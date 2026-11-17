import { type BenchRun, readRuns, renderReport } from '../src/benchReport'

const verdict = (o: object = {}) => ({
  valid: true,
  reason: null,
  maxLoad1: 1.1,
  onACThroughout: true,
  samples: 20,
  ...o,
})

const machine = (o: object = {}) => ({
  at: '2026-11-06T10:00:00.000Z',
  commit: 'abc1234',
  dirty: false,
  load1: 1,
  power: 'ac',
  quiet: true,
  mains: true,
  calm: true,
  valid: true,
  ...o,
})

const row = (o: object = {}) => ({
  id: 'full/pan',
  fps: 60,
  p95FrameMs: 17.6,
  maxFrameMs: 18.4,
  failures: [],
  budget: 'A budget “as written” ≥ 55 fps | with a pipe',
  ...o,
})

const run = (
  name: string,
  env: object | undefined,
  sections: Record<string, unknown>,
): BenchRun => ({
  file: `${name}.json`,
  json: { run: name, ...(env ? { env } : {}), ...sections },
})

const lines = (md: string) =>
  md.split('\n').filter((l) => l.startsWith('|') && !l.startsWith('|--'))

describe('renderReport', () => {
  const sec = { lifetime: { machine: machine(), rows: [row()] } }

  it('marks a valid run pass, and a missed gate fail', () => {
    const ok = renderReport([run('2026-11-06T10', { commit: 'abc1234', verdict: verdict() }, sec)])
    expect(lines(ok)[1]).toContain('| pass |')
    const bad = renderReport([
      run(
        '2026-11-06T10',
        { commit: 'abc1234', verdict: verdict() },
        { lifetime: { machine: machine(), rows: [row({ failures: ['mean 50 fps < 59.5'] })] } },
      ),
    ])
    expect(lines(bad)[1]).toContain('| fail |')
  })

  it("report marks an invalid run's rows invalid, never pass or fail", () => {
    const md = renderReport([
      run(
        '2026-11-06T10',
        { commit: 'abc1234', verdict: verdict({ valid: false, reason: 'battery at T' }) },
        { lifetime: { machine: machine(), rows: [row(), row({ id: 'x', failures: ['miss'] })] } },
      ),
    ])
    const rows = lines(md).slice(1)
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      expect(r).toContain('invalid: battery at T')
      expect(r).not.toMatch(/\| (pass|fail) \|/)
    }
  })

  it('a run with no env is invalid even when its section machine was valid', () => {
    const md = renderReport([run('r', undefined, sec)])
    expect(lines(md)[1]).toContain('invalid: no environment record')
  })

  it('an env without a well-formed verdict is invalid', () => {
    for (const env of [{ commit: 'abc1234' }, { commit: 'x', verdict: { valid: true } }]) {
      const md = renderReport([run('r', env, sec)])
      expect(lines(md)[1]).toContain('invalid: no environment record')
    }
  })

  it('a section machine without valid === true is invalid, at the start or the end', () => {
    const env = { commit: 'abc1234', verdict: verdict() }
    const { valid: _v, ...partial } = machine()
    expect(
      lines(
        renderReport([run('r', env, { s: { machine: partial, budget: 'b', failures: [] } })]),
      )[1],
    ).toContain('invalid:')
    const end = renderReport([
      run('r', env, {
        s: {
          machine: machine(),
          machineAtEnd: machine({ valid: false, mains: false, power: 'battery' }),
          budget: 'b',
          failures: [],
        },
      }),
    ])
    expect(lines(end)[1]).toContain('invalid: battery')
  })

  it('a section whose machine is a line of text, not a record, is invalid and dated by its run', () => {
    const env = { commit: 'abc1234', verdict: verdict() }
    const md = renderReport([
      run('2026-11-07T16:37:26.922Z', env, {
        spike: { machine: 'VALID run: load 2.78, power ac', budget: 'b', failures: [] },
      }),
    ])
    expect(lines(md)[1]).toContain('invalid:')
    expect(lines(md)[1]).toContain('2026-11-07')
  })

  it('a row with no failures record is never a pass', () => {
    const { failures: _f, ...bare } = row()
    const md = renderReport([
      run(
        'r',
        { commit: 'c', verdict: verdict() },
        { lifetime: { machine: machine(), rows: [bare] } },
      ),
    ])
    expect(lines(md)[1]).not.toMatch(/\| (pass|fail) \|/)
    expect(lines(md)[1]).toContain('invalid: no failures record')
  })

  it('lists a section with no target for information', () => {
    const md = renderReport([
      run('r', { commit: 'c', verdict: verdict() }, { baseline: { machine: machine(), fps: 60 } }),
    ])
    expect(lines(md)[1]).toContain('baseline')
    expect(lines(md)[1]).toContain('| info |')
  })

  it("report keeps a target's text exactly as written in the bench file", () => {
    const md = renderReport([run('r', { commit: 'abc1234', verdict: verdict() }, sec)])
    expect(md).toContain('A budget “as written” ≥ 55 fps \\| with a pipe')
  })

  it('gives each row the commit and the date', () => {
    const md = renderReport([run('r', { commit: 'abc1234', verdict: verdict() }, sec)])
    expect(lines(md)[1]).toContain('abc1234')
    expect(lines(md)[1]).toContain('2026-11-06')
  })

  it('takes each section from the newest run that has it', () => {
    const old = run('2026-11-05', { commit: 'old1111', verdict: verdict() }, sec)
    const neu = run('2026-11-06', { commit: 'new2222', verdict: verdict() }, sec)
    const md = renderReport([old, neu])
    expect(md).toContain('new2222')
    expect(md).not.toContain('old1111')
  })

  it('reads a section with no rows by its budget and measured fields', () => {
    const md = renderReport([
      run(
        'r',
        { commit: 'abc1234', verdict: verdict() },
        {
          'warm open': {
            machine: machine(),
            budget: 'warm open, first paint ≤ 300 ms',
            medianMs: 187,
            failures: [],
          },
        },
      ),
    ])
    expect(lines(md)[1]).toContain('warm open, first paint ≤ 300 ms')
    expect(lines(md)[1]).toContain('187')
    expect(lines(md)[1]).toContain('| pass |')
  })

  it('gives each row the load at its start and end', () => {
    const md = renderReport([
      run(
        'r',
        { commit: 'abc1234', verdict: verdict() },
        {
          lifetime: {
            machine: machine({ load1: 1.234 }),
            machineAtEnd: machine({ load1: 2.5 }),
            rows: [row()],
          },
        },
      ),
    ])
    expect(lines(md)[0]).toContain('| Load1 |')
    expect(lines(md)[1]).toContain('| 1.23 → 2.50 |')
  })

  it('judges a section that times nothing (the bundle budget) on its failures alone', () => {
    const budget = (o: object) => ({
      untimed: true,
      budget: 'initial JS for `/` ≤ 250 KB gzip',
      machine: { at: '2026-11-07T01:00:00.000Z', commit: 'abc1234', dirty: false },
      initialJsGzipKb: 243.06,
      failures: [],
      ...o,
    })
    const ok = renderReport([run('b', undefined, { budget: budget({}) })])
    expect(lines(ok)[1]).toContain('| pass |')
    expect(lines(ok)[1]).toContain('initialJsGzipKb 243.06')
    expect(lines(ok)[1]).toContain('| abc1234 |')
    const bad = renderReport([run('b', undefined, { budget: budget({ failures: ['over'] }) })])
    expect(lines(bad)[1]).toContain('| fail |')
    const dirty = renderReport([
      run('b', undefined, {
        budget: budget({ machine: { at: 'x', commit: 'abc1234', dirty: true } }),
      }),
    ])
    expect(lines(dirty)[1]).toContain('abc1234+dirty')
  })

  it('shows fps with two decimals, so a miss by 0.01 reads as one', () => {
    const md = renderReport([
      run(
        'r',
        { commit: 'abc1234', verdict: verdict() },
        {
          phase4: {
            machine: machine(),
            rows: [row({ fps: 59.49366, failures: ['mean 59.5 < 59.5'] })],
          },
        },
      ),
    ])
    expect(lines(md)[1]).toContain('59.49 fps')
  })

  it('says so when there are no runs', () => {
    expect(renderReport([])).toContain('No bench results')
  })
})

describe('readRuns', () => {
  it('reads the results, not the Chrome traces a bench saves beside them', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'bench-results-'))
    writeFileSync(join(dir, '2026-11-06T09:40:14.464Z.json'), '{"commit":"abc"}')
    writeFileSync(join(dir, '2026-11-06T09:40:14.464Z.env.json'), '{}')
    writeFileSync(join(dir, '2026-11-06T09:40:14.464Z-trace-warm.json'), '{"metadata":{}}')
    expect(readRuns(dir).map((r) => r.file)).toEqual(['2026-11-06T09:40:14.464Z.json'])
  })
})

describe('a small measured value', () => {
  it('keeps two significant digits instead of rounding to 0', () => {
    const md = renderReport([
      run(
        'r',
        { commit: 'abc1234', verdict: verdict() },
        {
          'layout shift': {
            machine: machine(),
            budget: 'CLS ≤ 0.01',
            maxCls: 0.00023077829654794186,
            failures: [],
          },
        },
      ),
    ])
    expect(lines(md)[1]).toContain('maxCls 0.00023')
  })
})
