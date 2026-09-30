/**
 * OpenAI-compatible provider.
 *
 * Works with any API that speaks the OpenAI chat completions format:
 *   - NVIDIA NIM  (https://integrate.api.nvidia.com/v1)
 *   - Groq        (https://api.groq.com/openai/v1)
 *   - OpenAI      (https://api.openai.com/v1)
 *   - Ollama      (http://localhost:11434/v1)
 *   - OpenRouter  (https://openrouter.ai/api/v1)
 *
 * Set VITE_BACKEND=openai and the three VITE_OPENAI_* vars in .env.local.
 *
 * Web search: optionally add VITE_BRAVE_SEARCH_KEY (free at
 * brave.com/search/api) for live web results. Without it the model
 * answers from training data only.
 */

import {
  OPENAI_BASE_URL,
  OPENAI_API_KEY,
  OPENAI_MODEL,
  SYSTEM_PROMPT,
  BRAVE_SEARCH_KEY,
} from '../../config'

// In dev the Vite server proxies /api/llm → OPENAI_BASE_URL, which sidesteps
// CORS. Most OpenAI-compatible APIs (NVIDIA NIM, Groq, etc.) do not send
// Access-Control-Allow-Origin headers, so a direct browser fetch is blocked.
const BASE = import.meta.env.DEV ? '/api/llm' : OPENAI_BASE_URL
import type { AskHandlers, AskResult, ProviderMessage } from './types'

// ---------------------------------------------------------------------------
// Thinking filter
// ---------------------------------------------------------------------------

/**
 * Strips <think>…</think> blocks from a streamed text delta.
 *
 * Models like Nemotron emit their internal reasoning inside these tags before
 * the real answer. The tags arrive in pieces across many chunks, so a simple
 * string replace doesn't work — this state machine buffers just enough to
 * detect the opening/closing tags and discards everything in between.
 */
class ThinkFilter {
  private buf = ''
  private inside = false
  // True once </think> has been seen — we emit freely from that point.
  // Reasoning models (Nemotron, DeepSeek-R1) emit their internal chain-of-thought
  // inside <think>…</think>. Some also emit a preamble BEFORE the opening tag
  // ("Ok, the user said…") that is equally internal and must not reach the UI.
  // Suppressing everything until after </think> fixes both cases; non-thinking
  // models (Llama, Gemma…) never emit that tag, so flush() releases the buffer.
  private pastThink = false

  feed(chunk: string, emit: (text: string) => void): void {
    this.buf += chunk
    for (;;) {
      if (this.pastThink) {
        // All reasoning is behind us — emit as fast as chunks arrive.
        const safe = this.buf.length > 6 ? this.buf.slice(0, -6) : ''
        if (safe) {
          console.log('[think-filter] emit:', JSON.stringify(safe.slice(0, 60)))
          emit(safe); this.buf = this.buf.slice(safe.length)
        }
        break
      }

      if (this.inside) {
        const end = this.buf.indexOf('</think>')
        if (end === -1) {
          // Still inside — keep only a tail long enough to catch a split tag.
          if (this.buf.length > 20) this.buf = this.buf.slice(-20)
          break
        }
        this.inside = false
        this.pastThink = true
        // Trim the leading newline models usually add after </think>.
        this.buf = this.buf.slice(end + 8).replace(/^\n/, '')
        // Continue the loop to emit post-think content immediately.
      } else {
        // Looking for the opening tag. Any text before it is preamble reasoning
        // (Nemotron-style) and must not reach the screen or the speaker.
        const start = this.buf.indexOf('<think>')
        if (start === -1) {
          // No <think> yet. Keep the full buffer — it may be a non-thinking model
          // whose entire response will be released in flush(). Only cap at a large
          // size to prevent unbounded memory growth on a runaway stream.
          if (this.buf.length > 4000) this.buf = this.buf.slice(-4000)
          break
        }
        // Discard everything before <think> (preamble reasoning).
        this.inside = true
        this.buf = this.buf.slice(start + 7)
        // Continue the loop to scan for </think>.
      }
    }
  }

  flush(emit: (text: string) => void): void {
    if (this.pastThink) {
      // We passed </think> — emit whatever is still buffered.
      if (this.buf) {
        console.log('[think-filter] flush post-think:', JSON.stringify(this.buf.slice(0, 80)))
        emit(this.buf); this.buf = ''
      }
    } else if (!this.inside) {
      // Stream ended without ever seeing <think>: non-reasoning model.
      // Release everything we held back.
      if (this.buf) {
        console.log('[think-filter] flush no-think (full buf):', JSON.stringify(this.buf.slice(0, 80)))
        emit(this.buf); this.buf = ''
      }
    } else {
      // Unclosed <think> — model only produced reasoning, no answer.
      console.warn('[think-filter] stream ended inside <think> — no answer emitted')
    }
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

type OAITool = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

const TOOLS: OAITool[] = BRAVE_SEARCH_KEY
  ? [
      {
        type: 'function',
        function: {
          name: 'web_search',
          description: 'Procura informação atual na web. Resuma sempre os resultados em português, mesmo que as fontes estejam em inglês ou outro idioma.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Termos de pesquisa' },
            },
            required: ['query'],
          },
        },
      },
    ]
  : []

async function runTool(name: string, args: Record<string, string>): Promise<string> {
  if (name === 'web_search' && BRAVE_SEARCH_KEY) {
    try {
      const res = await fetch(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(args.query ?? '')}&count=5`,
        {
          headers: {
            Accept: 'application/json',
            'Accept-Encoding': 'gzip',
            'X-Subscription-Token': BRAVE_SEARCH_KEY,
          },
        },
      )
      if (!res.ok) return 'Pesquisa falhou.'
      const data = await res.json()
      const results: string = (data.web?.results ?? [])
        .slice(0, 5)
        .map((r: { title: string; description: string }) => `${r.title}: ${r.description}`)
        .join('\n')
      return results || 'Sem resultados.'
    } catch {
      return 'Pesquisa falhou.'
    }
  }
  return 'Ferramenta não disponível.'
}

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

type OAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: { name: string; arguments: string }
      }>
    }
  | { role: 'tool'; tool_call_id: string; name: string; content: string }

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let controller: AbortController | null = null

export function cancel(): void {
  controller?.abort()
  controller = null
}

export function connectedLabels(): string[] {
  return BRAVE_SEARCH_KEY ? ['Brave Search'] : []
}

// ---------------------------------------------------------------------------
// Ask
// ---------------------------------------------------------------------------

export async function ask(
  history: ProviderMessage[],
  handlers: AskHandlers,
): Promise<AskResult> {
  console.log('[openai] ask() called, model:', OPENAI_MODEL, 'history:', history.length)
  const usedTools: string[] = []
  let fullText = ''

  const messages: OAIMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ]

  // Agentic loop: keep going while the model calls tools.
  for (let turn = 0; turn < 6; turn++) {
    controller = new AbortController()

    const body: Record<string, unknown> = {
      model: OPENAI_MODEL,
      messages,
      stream: true,
      // Thinking models (Nemotron, DeepSeek-R1) consume most of their token
      // budget on internal reasoning inside <think>…</think>. 2048 gives ~1900
      // tokens of thinking room; the system prompt caps the actual answer at 60
      // words (~80 tokens). The ThinkFilter strips reasoning from output.
      max_tokens: 2048,
      temperature: 0.7,
      ...(TOOLS.length ? { tools: TOOLS, tool_choice: 'auto' } : {}),
    }

    let res: Response
    try {
      res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err: unknown) {
      if ((err as Error)?.name === 'AbortError') return { text: fullText.trim(), tools: usedTools }
      throw err
    }

    console.log('[openai] response status:', res.status)
    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`Provider error ${res.status}: ${errText}`)
    }

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ''

    // Tool call fragments accumulate across chunks.
    const pendingCalls: Record<
      number,
      { id: string; name: string; args: string }
    > = {}
    let assistantText = ''
    const filter = new ThinkFilter()

    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch {
        break
      }
      if (chunk.done) break
      buf += decoder.decode(chunk.value, { stream: true })

      const lines = buf.split('\n')
      buf = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') break
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(data)
        } catch {
          continue
        }

        const choice = (parsed.choices as Array<Record<string, unknown>>)?.[0]
        if (!choice) continue

        const delta = choice.delta as Record<string, unknown> | undefined
        if (!delta) continue

        if (typeof delta.content === 'string' && delta.content) {
          assistantText += delta.content
          // Strip <think>…</think> before sending to the speaker and screen.
          filter.feed(delta.content, (visible) => {
            fullText += visible
            handlers.onText(visible)
          })
        }

        const toolDeltas = delta.tool_calls as
          | Array<{
              index?: number
              id?: string
              function?: { name?: string; arguments?: string }
            }>
          | undefined

        if (toolDeltas) {
          for (const tc of toolDeltas) {
            const i = tc.index ?? 0
            if (!pendingCalls[i]) pendingCalls[i] = { id: '', name: '', args: '' }
            if (tc.id) pendingCalls[i].id = tc.id
            if (tc.function?.name) {
              pendingCalls[i].name = tc.function.name
              handlers.onTool(tc.function.name.replace(/_/g, ' '))
            }
            if (tc.function?.arguments) pendingCalls[i].args += tc.function.arguments
          }
        }
      }
    }

    // Flush anything buffered at the end of the turn (e.g. last few chars
    // held back while watching for a partial <think> opening tag).
    filter.flush((visible) => { fullText += visible; handlers.onText(visible) })

    const calls = Object.values(pendingCalls)

    // No tool calls — done.
    if (!calls.length) break

    // Add assistant turn with the tool_calls block.
    messages.push({
      role: 'assistant',
      content: assistantText || null,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: 'function' as const,
        function: { name: c.name, arguments: c.args },
      })),
    })

    // Execute each tool and push its result.
    for (const call of calls) {
      usedTools.push(call.name)
      let args: Record<string, string> = {}
      try {
        args = JSON.parse(call.args)
      } catch {
        /* noop */
      }
      const result = await runTool(call.name, args)
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.name,
        content: result,
      })
    }
  }

  console.log('[openai] ask() done, fullText:', JSON.stringify(fullText.trim().slice(0, 120)))
  return { text: fullText.trim(), tools: usedTools }
}
