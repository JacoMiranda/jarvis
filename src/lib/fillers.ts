/**
 * Filler speech — Portuguese version.
 *
 * A tool call pode demorar dez segundos, e esse silêncio parece um crash.
 * O JARVIS diz algo no instante em que o trabalho começa — depois fica
 * em silêncio até ter resposta. Um reconhecimento, sem comentário de progresso.
 */

/** Dito assim que a primeira ferramenta dispara, antes de qualquer resposta. */
const WORKING = [
  'A trabalhar nisso, senhor.',
  'A compilar.',
  'A recuperar.',
  'A aceder ao arquivo.',
  'A cruzar referências.',
  'A executar a pesquisa.',
  'A pesquisar.',
  'Em curso.',
]

/** Acknowledging an order where no tool is involved. */
const ACKNOWLEDGE = [
  'Como desejar, senhor.',
  'Muito bem, senhor.',
  'Certamente.',
  'Compreendido.',
  'Considera feito.',
  'Imediatamente, senhor.',
]

/** Answering to his name, before the user has said what they want. */
const ATTENTION = [
  'Sim, senhor?',
  'Senhor?',
  'Às suas ordens, senhor.',
  'Em standby.',
  'Acordado, senhor.',
]

/**
 * Avoids repeating the same phrase twice running, which is what makes canned
 * lines sound canned. Keeps one slot of history per pool.
 */
function makePicker(pool: string[]) {
  let last = -1
  return () => {
    if (pool.length < 2) return pool[0] ?? ''
    let i = last
    while (i === last) i = Math.floor(Math.random() * pool.length)
    last = i
    return pool[i]
  }
}

export const working = makePicker(WORKING)
export const acknowledge = makePicker(ACKNOWLEDGE)
export const attention = makePicker(ATTENTION)

/**
 * Naming the task is warmer than a generic acknowledgement and shows the
 * integration off on camera. Still participial, still under five words.
 */
type Rule = {
  server?: RegExp
  tool?: RegExp
  lines: string[]
}

const FOOTAGE = ['A montar a sequência.', 'A renderizar.']

const BY_TOOL: Rule[] = [
  { tool: /video|footage|\bclip\b|\breel\b|talking_head/, lines: FOOTAGE },
  {
    server: /higgsfield|openrouter-image|dalle|flux|midjourney/,
    tool: /image|photo|thumbnail|render|upscale|seedream/,
    lines: ['A renderizar.', 'A compor.'],
  },
  { server: /palmier|heygen|runway|descript/, lines: FOOTAGE },
  {
    server: /playwright|puppeteer|browserbase|chrome/,
    tool: /\bbrowser\b|navigate/,
    lines: ['A abrir o browser.', 'A navegar.'],
  },
  {
    server: /android|\badb\b|simulator/,
    tool: /\bdevice\b|\bapk\b|\bphone\b/,
    lines: ['A aceder ao dispositivo.', 'A ligar ao telemóvel.'],
  },
  {
    server: /gmail|\bmail\b/,
    tool: /gmail|\bmail\b|email|inbox/,
    lines: ['A verificar o correio.', 'A ler a caixa de entrada.'],
  },
  {
    tool: /calendar|\bdiary\b|\bmeeting\b/,
    lines: ['A verificar o calendário.', 'A consultar a agenda.'],
  },
  {
    server: /elevenlabs|openai-tts/,
    tool: /speech|\bvoice\b|\btts\b|text_to_sound/,
    lines: ['A sintetizar.', 'A trabalhar nisso, senhor.'],
  },
  {
    server: /spotify|sonos/,
    tool: /\bplay\b|\bmusic\b|playlist|\btrack\b/,
    lines: ['A colocar na fila.', 'A pôr a tocar.'],
  },
  {
    server: /^home|homeassistant|\bhue\b|\bhass\b/,
    tool: /\blights?\b|thermostat|\bdimmer\b/,
    lines: ['A ajustar.', 'A tratar disso, senhor.'],
  },
  {
    server: /github|linear|jira|sentry/,
    tool: /\brepo\b|repository|\bissues?\b|pull_request|\bcommit\b/,
    lines: ['A verificar o repositório.', 'A consultar o tracker.'],
  },
  {
    server: /mixpanel|clarity|posthog|amplitude/,
    tool: /analytic|\bmetrics?\b|\breports?\b|\bevents?\b|cohort|funnel|dashboard|\bquery\b/,
    lines: ['A executar a pesquisa.', 'A recolher os dados.'],
  },
  {
    server: /\bexa\b|serper|serpapi|perplexity|tavily|brave/,
    tool: /search|\bweb\b|\bfetch\b|crawl|research/,
    lines: ['A pesquisar.', 'A consultar.'],
  },
]

const pickers = BY_TOOL.map((r) => ({ ...r, pick: makePicker(r.lines) }))

function split(toolName: string): { server: string; tool: string } {
  const raw = /^mcp__(.+?)__(.+)$/.exec(toolName)
  if (raw) return { server: raw[1].toLowerCase(), tool: raw[2].toLowerCase() }

  const pretty = toolName.split(' · ')
  if (pretty.length === 2) {
    return { server: pretty[0].toLowerCase(), tool: pretty[1].toLowerCase() }
  }

  return { server: '', tool: toolName.toLowerCase() }
}

/** A phrase suited to the tool that just fired. */
export function forTool(toolName: string): string {
  const { server, tool } = split(toolName)
  for (const r of pickers) {
    const hit =
      (r.server !== undefined && server !== '' && r.server.test(server)) ||
      (r.tool !== undefined && r.tool.test(tool))
    if (hit) return r.pick()
  }
  return working()
}
