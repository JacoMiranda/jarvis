export type ProviderMessage = {
  role: 'user' | 'assistant'
  content: string
}

export type AskHandlers = {
  onText: (delta: string) => void
  onTool: (name: string) => void
}

export type AskResult = {
  text: string
  tools: string[]
}
