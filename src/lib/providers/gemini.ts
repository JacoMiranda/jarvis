/**
 * Google Gemini provider.
 *
 * Uses the Gemini REST API directly from the browser (CORS is supported).
 * Google Search grounding is enabled automatically — no extra key needed.
 *
 * Set VITE_BACKEND=gemini, VITE_GEMINI_API_KEY and optionally
 * VITE_GEMINI_MODEL in .env.local.
 */

import { GEMINI_API_KEY, GEMINI_MODEL, SYSTEM_PROMPT } from '../../config'
import type { AskHandlers, AskResult, ProviderMessage } from './types'

// ---------------------------------------------------------------------------
// Types (Gemini REST API subset)
// ---------------------------------------------------------------------------

type GeminiPart = { text: string }

type GeminiContent = {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

type GeminiChunk = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> }
    groundingMetadata?: {
      webSearchQueries?: string[]
    }
  }>
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let controller: AbortController | null = null

export function cancel(): void {
  controller?.abort()
  controller = null
}

export function connectedLabels(): string[] {
  return ['Google Search']
}

// ---------------------------------------------------------------------------
// Ask
// ---------------------------------------------------------------------------

export async function ask(
  history: ProviderMessage[],
  handlers: AskHandlers,
): Promise<AskResult> {
  controller = new AbortController()
  let fullText = ''
  const usedTools: string[] = []
  let searchReported = false

  const contents: GeminiContent[] = history.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))

  const body = {
    contents,
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    // Google Search grounding — built into Gemini, no extra API key.
    tools: [{ googleSearch: {} }],
    generationConfig: {
      maxOutputTokens: 1024,
      temperature: 0.7,
    },
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${GEMINI_MODEL}:streamGenerateContent?key=${GEMINI_API_KEY}&alt=sse`

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err: unknown) {
    if ((err as Error)?.name === 'AbortError') return { text: '', tools: [] }
    throw err
  }

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Gemini error ${res.status}: ${errText}`)
  }

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''

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
      let parsed: GeminiChunk
      try {
        parsed = JSON.parse(data)
      } catch {
        continue
      }

      const candidate = parsed.candidates?.[0]
      if (!candidate) continue

      for (const part of candidate.content?.parts ?? []) {
        if (part.text) {
          fullText += part.text
          handlers.onText(part.text)
        }
      }

      // Report when Google Search grounding fires.
      const queries = candidate.groundingMetadata?.webSearchQueries
      if (queries?.length && !searchReported) {
        searchReported = true
        usedTools.push('web_search')
        handlers.onTool('web search')
      }
    }
  }

  return { text: fullText.trim(), tools: usedTools }
}
