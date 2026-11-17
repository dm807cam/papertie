export interface RecordedCall {
  name: string
  args: unknown[]
}

export interface RecordedSet {
  prop: string
  value: unknown
}

/** A stand-in 2D context that logs every method call and property assignment. */
export function recordingContext(): {
  ctx: CanvasRenderingContext2D
  calls: RecordedCall[]
  sets: RecordedSet[]
} {
  const calls: RecordedCall[] = []
  const sets: RecordedSet[] = []
  const state = new Map<string, unknown>()
  const ctx = new Proxy(
    {},
    {
      get(_target, prop) {
        const name = String(prop)
        if (state.has(name)) return state.get(name)
        return (...args: unknown[]) => {
          calls.push({ name, args })
        }
      },
      set(_target, prop, value) {
        sets.push({ prop: String(prop), value })
        state.set(String(prop), value)
        return true
      },
    },
  )
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, sets }
}
