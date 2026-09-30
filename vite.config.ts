import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Read .env.local at server start so the proxy target can be set dynamically.
  const env = loadEnv(mode, process.cwd(), '')
  const llmTarget = env.VITE_OPENAI_BASE_URL

  return {
    plugins: [react()],
    server: {
      // Honour PORT so a second instance can run alongside the first. The bridge
      // only accepts sockets from localhost:5173-5199, so stay inside that range
      // or set JARVIS_ALLOWED_ORIGINS to match.
      port: Number(process.env.PORT) || 5173,
      // Listen on all interfaces so the page is reachable from other devices on
      // the LAN (phones, tablets). Without this Vite only binds to 127.0.0.1.
      host: process.env.JARVIS_HOST === '1' || false,
      proxy: llmTarget
        ? {
            // Browser calls /api/llm/… → Vite forwards to the real LLM API.
            // This avoids CORS entirely: the browser talks to localhost and
            // Node.js (no CORS restrictions) talks to the API.
            '/api/llm': {
              target: llmTarget,
              changeOrigin: true,
              rewrite: (path) => path.replace(/^\/api\/llm/, ''),
            },
          }
        : {},
    },
    optimizeDeps: {
      // kokoro-js pulls in `phonemizer`, which carries espeak-ng as inline WASM.
      // Vite's dependency pre-bundler rewrites that initialisation and the
      // language table ends up empty — the symptom is
      // `Invalid language identifier: "en". Should be one of: .` at generate()
      // time, long after the model has loaded successfully. Serving these
      // untouched fixes it.
      exclude: ['kokoro-js', 'phonemizer', '@huggingface/transformers'],
    },
  }
})
