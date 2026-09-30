import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const FACE_SCRIPT = join(__dir, 'face.py')

/**
 * Voice-activated write unlock — two independent methods:
 *
 * 1. PIN (JARVIS_UNLOCK_PIN=1234): the user speaks a numeric/alphanumeric code.
 *    JARVIS asks for it, forwards what it hears to unlock_writes() which checks
 *    the value here in Node — the model never makes the security decision.
 *
 * 2. Face (JARVIS_FACE_UNLOCK=1): JARVIS captures one camera frame and pipes it
 *    to bridge/face.py (YuNet+SFace ONNX, local). The Python script compares
 *    the embedding to ~/.jarvis-face.json and returns verified=true/false. The
 *    model never sees the comparison result — Node reads it and decides.
 *
 * Both methods are registered when their env var is present. Either is enough to
 * unlock; they can coexist. If neither is configured, authServer() returns null
 * and no jarvis_auth server is added.
 *
 * Each new WebSocket connection starts locked again.
 */
export function authServer(onUnlock, captureFrame) {
  const PIN = process.env.JARVIS_UNLOCK_PIN
  const FACE = process.env.JARVIS_FACE_UNLOCK === '1'

  // Always register the server when face is enabled (even if only to enroll).
  // Enroll must be available before the user has unlocked anything — it IS how
  // they set up unlock. PIN-only setups with no face flag skip this server.
  if (!PIN && !FACE) return null

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
            return { content: [{ type: 'text', text: 'Código correto. Acesso activado.' }] }
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
  if (FACE && captureFrame) {
    tools.push(
      tool(
        'unlock_with_face',
        'Pede ao utilizador que olhe para a câmera e verifica a identidade localmente com reconhecimento facial (sem código necessário).',
        {},
        async () => {
          // 1. Capture frame from browser camera
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
              content: [{ type: 'text', text: 'A câmera não devolveu imagem.' }],
            }
          }

          // 2. Call face.py — comparison happens in Python, not in the model
          let result
          try {
            result = await runFaceScript({ cmd: 'verify', image: reply.data })
          } catch (err) {
            return {
              isError: true,
              content: [{
                type: 'text',
                text: `Reconhecimento facial falhou: ${err?.message ?? err}. ` +
                      'Verifique se o Python e o opencv-python-headless estão instalados.',
              }],
            }
          }

          // 3. Decision in Node, not the model
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
            models_not_found: 'Modelos ONNX não encontrados em bridge/models/. Execute: python bridge/face.py --download',
            no_face: 'Nenhum rosto detectado. Tente de novo em melhor iluminação.',
            no_identity: 'Nenhum rosto registado. Diga "JARVIS, regista o meu rosto" primeiro.',
            below_threshold: `Score insuficiente (${result.score ?? '?'}). Tente de novo.`,
          }[result.reason] ?? 'Identidade não confirmada.'

          return {
            isError: true,
            content: [{ type: 'text', text: reason }],
          }
        },
      ),
    )

    // Enroll tool — register the owner's face so unlock_with_face can recognise them
    tools.push(
      tool(
        'enroll_face',
        'Regista o rosto do utilizador para desbloqueio futuro por câmera. Captura vários frames e guarda a assinatura local em ~/.jarvis-face.json. Usar apenas quando pedido explicitamente.',
        {
          name: z.string().describe('Nome do utilizador a registar'),
        },
        async ({ name }) => {
          if (!captureFrame) {
            return {
              isError: true,
              content: [{ type: 'text', text: 'Câmera não disponível.' }],
            }
          }

          // Capture several frames for a better average embedding
          const SAMPLES = 5
          const images = []
          for (let i = 0; i < SAMPLES; i++) {
            try {
              const r = await captureFrame()
              if (r?.data) images.push(r.data)
            } catch {
              // skip failed captures
            }
            if (i < SAMPLES - 1) await new Promise((r) => setTimeout(r, 600))
          }

          if (images.length === 0) {
            return {
              isError: true,
              content: [{ type: 'text', text: 'Não foi possível capturar imagens da câmera.' }],
            }
          }

          let result
          try {
            result = await runFaceScript({ cmd: 'enroll', name, images })
          } catch (err) {
            return {
              isError: true,
              content: [{ type: 'text', text: `Erro ao registar rosto: ${err?.message ?? err}` }],
            }
          }

          if (result.enrolled) {
            return {
              content: [{
                type: 'text',
                text: `Rosto de ${result.name} registado com ${result.samples} amostras.`,
              }],
            }
          }
          return {
            isError: true,
            content: [{ type: 'text', text: result.reason ?? 'Rosto não registado — rostos insuficientes detectados.' }],
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
        ? '- unlock_writes: ask the user for their access code, pass exactly what they said.\n'
        : '') +
      (FACE
        ? '- unlock_with_face: tell the user to look at the camera, then call this (no args).\n' +
          '- enroll_face: when the user explicitly asks to register their face, ask their name first.\n'
        : '') +
      'Never guess a PIN or construct it yourself.',
    alwaysLoad: true,
    tools,
  })
}

// ---------------------------------------------------------------------------
// Run face.py as a child process
// ---------------------------------------------------------------------------

function runFaceScript(payload) {
  return new Promise((resolve, reject) => {
    const py = spawn('python', [FACE_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    py.stdout.on('data', (d) => { out += d })
    py.stderr.on('data', (d) => { err += d })
    py.on('close', (code) => {
      if (err) console.warn('[face.py stderr]', err.slice(0, 200))
      try {
        resolve(JSON.parse(out))
      } catch {
        reject(new Error(`face.py output not JSON (exit ${code}): ${out.slice(0, 120)}`))
      }
    })
    py.on('error', reject)
    py.stdin.write(JSON.stringify(payload))
    py.stdin.end()
  })
}
