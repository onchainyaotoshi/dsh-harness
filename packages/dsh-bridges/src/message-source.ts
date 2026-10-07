/** DSH 0.2 attributes injected context to each producer's own source kind. */
import type {} from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-bridges': { kind: 'dsh-bridges'; plugin: string }
  }
}
