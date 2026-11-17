import { describe, expect, it } from 'vitest'
import { OP_SAMPLES, OpSchema, primeOpSchemas } from '../src/index'

describe('op samples (the server primes the op schemas with them at its start)', () => {
  it('cover every branch of OpSchema, and each parses', () => {
    const kinds = OpSchema.options.map((o) => o.shape.op.value).sort()
    expect(Object.keys(OP_SAMPLES).sort()).toEqual(kinds)
    for (const op of Object.values(OP_SAMPLES)) {
      const r = OpSchema.safeParse(op)
      expect(r.success, `${op.op}: ${r.error?.issues[0]?.message}`).toBe(true)
    }
    expect(primeOpSchemas()).toEqual([])
  })
})
