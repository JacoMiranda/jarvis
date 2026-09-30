import { BACKEND } from '../config'
import * as direct from './anthropic'
import * as bridge from './bridge'
import * as openaiProvider from './providers/openai-compat'
import * as geminiProvider from './providers/gemini'
import type { AskHandlers, Msg } from './anthropic'
import type { Blade, Panel } from '../store'
import type { ProviderMessage } from './providers/types'

export type { AskHandlers, Msg }
export type { ConnectionState } from './bridge'

/**
 * Convert the app's Anthropic-typed history to the simple format the
 * third-party providers understand. Content is always a plain string in
 * practice — the non-bridge path never produces multi-part blocks.
 */
function toProviderMessages(msgs: Msg[]): ProviderMessage[] {
  return msgs.flatMap((m) => {
    const role = m.role as 'user' | 'assistant'
    const content =
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .filter((b): b is { type: 'text'; text: string } => (b as any).type === 'text')
              .map((b) => b.text)
              .join('')
          : ''
    return content ? [{ role, content }] : []
  })
}

/**
 * True for any backend that keeps conversation state internally (the bridge
 * does, every other backend does not). App.tsx uses this flag to decide
 * whether to thread the history through on every turn.
 */
export const usingBridge = BACKEND === 'bridge'

export async function ask(
  prompt: string,
  history: Msg[],
  handlers: AskHandlers,
): Promise<{ text: string; tools: string[] }> {
  if (BACKEND === 'bridge') {
    return bridge.ask(prompt, handlers)
  }

  const messages = toProviderMessages([
    ...history,
    { role: 'user', content: prompt },
  ])

  if (BACKEND === 'openai') {
    const r = await openaiProvider.ask(messages, handlers)
    // Nemotron sometimes starts <think> and hits the token budget before </think>,
    // leaving an empty response. One silent retry is enough — the model is
    // non-deterministic and the next call usually comes back without thinking mode.
    if (!r.text && !r.tools.length) {
      console.warn('[brain] empty response (thinking truncated?), retrying once')
      return openaiProvider.ask(messages, handlers)
    }
    return r
  }
  if (BACKEND === 'gemini') return geminiProvider.ask(messages, handlers)

  // 'direct' — Anthropic SDK called from the browser.
  return direct.ask([...history, { role: 'user', content: prompt }], handlers)
}

export async function warm(): Promise<void> {
  if (usingBridge) await bridge.warmBridge()
}

export function watchServers(fn: (servers: string[]) => void): void {
  if (usingBridge) bridge.watchServers(fn)
}

export function watchPanels(fn: (panel: Panel) => void): void {
  if (usingBridge) bridge.watchPanels(fn)
}

export function watchBlades(fn: (blade: Blade) => void): void {
  if (usingBridge) bridge.watchBlades(fn)
}

export function watchUi(fn: (op: string, args: any) => void): void {
  if (usingBridge) bridge.watchUi(fn)
}

export function watchCapture(
  fn: (req: bridge.CaptureRequest) => Promise<bridge.CaptureResult>,
): void {
  if (usingBridge) bridge.watchCapture(fn)
}

export function cancel(): void {
  if (BACKEND === 'bridge') bridge.cancel()
  else if (BACKEND === 'openai') openaiProvider.cancel()
  else if (BACKEND === 'gemini') geminiProvider.cancel()
  else direct.cancel()
}

export function interrupt(): void {
  cancel()
}

export function isConnected(): boolean {
  return usingBridge ? bridge.isConnected() : true
}

export function watchConnection(
  fn: (state: bridge.ConnectionState) => void,
): void {
  if (usingBridge) bridge.watchConnection(fn)
}

export function connectedLabels(): string[] {
  if (BACKEND === 'bridge') return bridge.bridgeServers()
  if (BACKEND === 'openai') return openaiProvider.connectedLabels()
  if (BACKEND === 'gemini') return geminiProvider.connectedLabels()
  return direct.connectedLabels()
}
