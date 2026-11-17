/** Only these keys are ever written. Never log note text, labels, filenames, tokens, emails or ids. */
export const LOG_KEYS = [
  'method',
  'route',
  'status',
  'ms',
  'revision',
  'ops',
  'bytes',
  'code',
  'point',
  'count',
  'kind',
  'reason',
  'port',
  /** The longest the event loop was held, ms (bench runs only). */
] as const

export type LogKey = (typeof LOG_KEYS)[number]
export type LogFields = Partial<Record<LogKey, string | number | boolean>>

export interface Logger {
  info(msg: string, f?: LogFields): void
  warn(msg: string, f?: LogFields): void
  error(msg: string, f?: LogFields): void
}

const ALLOWED: ReadonlySet<string> = new Set(LOG_KEYS)

export function createLogger(sink: (line: string) => void): Logger {
  const emit = (level: 'info' | 'warn' | 'error', msg: string, f?: LogFields) => {
    const entry: Record<string, unknown> = { level, msg }
    if (f) {
      for (const [k, v] of Object.entries(f)) {
        if (ALLOWED.has(k)) entry[k] = v
      }
    }
    sink(JSON.stringify(entry))
  }
  return {
    info: (msg, f) => emit('info', msg, f),
    warn: (msg, f) => emit('warn', msg, f),
    error: (msg, f) => emit('error', msg, f),
  }
}
