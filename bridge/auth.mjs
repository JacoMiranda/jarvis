import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/**
 * Voice-activated write unlock.
 *
 * When JARVIS_UNLOCK_PIN is set, the session starts locked (even if
 * JARVIS_ALLOW_WRITES is not set). The model can call unlock_writes with
 * the PIN the user speaks to activate write access for the rest of that
 * session. Each new connection starts locked again.
 *
 * The PIN is checked here, in Node, not by the model — the model only
 * forwards what it hears. This means the model cannot grant itself access
 * by deciding the PIN "looks right"; it has to match exactly.
 *
 * Usage in .env.local (or shell before npm start):
 *   JARVIS_UNLOCK_PIN=1234
 */
export function authServer(onUnlock) {
  const PIN = process.env.JARVIS_UNLOCK_PIN
  if (!PIN) return null

  return createSdkMcpServer({
    name: 'jarvis_auth',
    version: '1.0.0',
    instructions:
      'Use unlock_writes when the user asks to do something that requires write ' +
      'access and the session is still locked. Ask them to say their access code, ' +
      'then pass exactly what they said to unlock_writes.',
    alwaysLoad: true,
    tools: [
      tool(
        'unlock_writes',
        'Verifica o código de acesso e activa permissões de escrita para esta sessão.',
        {
          pin: z.string().describe('Código dito pelo utilizador, transcrito literalmente'),
        },
        async ({ pin }) => {
          if (String(pin).trim() === String(PIN).trim()) {
            onUnlock()
            return {
              content: [
                {
                  type: 'text',
                  text: 'Código correto. Acesso de escrita activado para esta sessão.',
                },
              ],
            }
          }
          return {
            isError: true,
            content: [{ type: 'text', text: 'Código incorreto. Acesso negado.' }],
          }
        },
      ),
    ],
  })
}
