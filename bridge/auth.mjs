import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/**
 * Voice-activated write unlock — two methods:
 *
 * 1. PIN (JARVIS_UNLOCK_PIN=1234): the user speaks a numeric/alphanumeric code.
 *    JARVIS asks for it, forwards what it hears to unlock_writes(), which checks
 *    in Node — the model never makes the security decision.
 *
 * 2. Face (JARVIS_FACE_API_URL=http://localhost:8000): JARVIS captures one frame
 *    from the browser camera and POST /verify to the face-hi Python service, which
 *    compares it locally with YuNet+SFace ONNX models. If verified=true, unlocks.
 *    The model never sees the result — the Python service decides.
 *
 * Both methods are registered when their env var is present. Either is enough to
 * unlock; they can coexist. If neither is configured, authServer() returns null and
 * no jarvis_auth server is added — write access then only via --writes / ALLOW_WRITES.
 *
 * Each new WebSocket connection starts locked again.
 */
export function authServer(onUnlock, captureFrame) {
  const PIN = process.env.JARVIS_UNLOCK_PIN
  const FACE_URL = process.env.JARVIS_FACE_API_URL

  if (!PIN && !FACE_URL) return null

  const tools = []

  // --- PIN unlock ---------------------------------------------------------------
  if (PIN) {
    tools.push(
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
              content: [{ type: 'text', text: 'Código correto. Acesso activado.' }],
            }
          }
          return {
            isError: true,
            content: [{ type: 'text', text: 'Código incorreto. Acesso negado.' }],
          }
        },
      ),
    )
  }

  // --- Face unlock --------------------------------------------------------------
  if (FACE_URL && captureFrame) {
    tools.push(
      tool(
        'unlock_with_face',
        'Captura um frame da câmera e verifica a identidade através do serviço local de reconhecimento facial. Não requer código — só olhar para a câmera.',
        {},
        async () => {
          // 1. Capture frame from browser
          let reply
          try {
            reply = await captureFrame()
          } catch (err) {
            return {
              isError: true,
              content: [{ type: 'text', text: `Câmera indisponível: ${err?.message ?? err}` }],
            }
          }
          if (!reply?.data) {
            return {
              isError: true,
              content: [{ type: 'text', text: 'Câmera não devolveu imagem.' }],
            }
          }

          // 2. Send to face-hi Python service for comparison (no LLM involved)
          let result
          try {
            const res = await fetch(`${FACE_URL}/verify`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ image: reply.data }),
              signal: AbortSignal.timeout(8000),
            })
            if (!res.ok) {
              const txt = await res.text()
              return {
                isError: true,
                content: [{ type: 'text', text: `Serviço de visão respondeu ${res.status}: ${txt}` }],
              }
            }
            result = await res.json()
          } catch (err) {
            return {
              isError: true,
              content: [{
                type: 'text',
                text: `Serviço de visão inacessível (${FACE_URL}): ${err?.message ?? err}. ` +
                      'Verifique se o face-hi está em execução.',
              }],
            }
          }

          // 3. Decision is made here in Node, not by the model
          if (result.verified) {
            onUnlock()
            return {
              content: [{
                type: 'text',
                text: `Identidade confirmada${result.name ? ` (${result.name})` : ''}. Acesso activado.`,
              }],
            }
          }

          const reason = {
            no_face: 'Não foi detectado nenhum rosto na imagem.',
            no_identity: 'Nenhuma identidade registada. Apresente-se ao face-hi primeiro.',
            below_threshold: `Score insuficiente (${result.score ?? '?'}). Tente de novo em melhor luz.`,
          }[result.reason] ?? 'Identidade não confirmada.'

          return {
            isError: true,
            content: [{ type: 'text', text: reason }],
          }
        },
      ),
    )
  }

  return createSdkMcpServer({
    name: 'jarvis_auth',
    version: '1.0.0',
    instructions:
      'Use these tools when the user asks to do something that requires write ' +
      'access and the session is still locked.\n' +
      (PIN
        ? '- unlock_writes: ask the user for their access code, then pass exactly what they said.\n'
        : '') +
      (FACE_URL
        ? '- unlock_with_face: ask the user to look at the camera, then call this tool (no argument needed).\n'
        : '') +
      'Do not attempt to guess a PIN or construct it yourself.',
    alwaysLoad: true,
    tools,
  })
}
