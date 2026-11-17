import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EnvVerdict } from './benchEnv'
import { HEAVY_CPU } from './benchJudge'

/**
 * `pnpm bench:report`: the latest bench JSONs (`e2e/bench/results/`, git-ignored) as one table,
 * written beside them as `e2e/bench/results/report.md`.
 */

/** One results file. */
export interface BenchRun {
  file: string
  json: Record<string, unknown>
}

interface Machine {
  at?: string
  commit?: string
  dirty?: boolean
  load1?: number
  power?: string
  mains?: boolean
  quiet?: boolean
  calm?: boolean
  valid?: boolean
  top?: Array<{ command: string; cpu: number }>
}

interface Gate {
  minFps?: number
  p95OverBaselineMs?: number
  maxFrameMs?: number
}

interface Row {
  id?: string
  fps?: number
  p95FrameMs?: number
  maxFrameMs?: number
  gate?: Gate
  budget?: string
  failures?: string[]
}

interface Section {
  machine?: Machine
  machineAtEnd?: Machine
  budget?: string
  failures?: string[]
  rows?: Row[]
  /** Times nothing (a bundle size): judged on its failures alone, whatever the machine. */
  untimed?: boolean
  [key: string]: unknown
}

interface Env {
  commit?: string
  verdict?: EnvVerdict
}

/** Metadata keys of a bench JSON that are not sections. */
const NOT_SECTIONS = new Set(['run', 'env'])

const isSection = (name: string, v: unknown): v is Section =>
  !NOT_SECTIONS.has(name) && typeof v === 'object' && v !== null && !Array.isArray(v)

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')

function gateText(g: Gate | undefined): string {
  const parts: string[] = []
  if (g?.minFps !== undefined) parts.push(`mean ≥ ${g.minFps} fps`)
  if (g?.p95OverBaselineMs !== undefined) parts.push(`p95 ≤ blank page + ${g.p95OverBaselineMs} ms`)
  if (g?.maxFrameMs !== undefined) parts.push(`no frame over ${g.maxFrameMs} ms`)
  return parts.length > 0 ? parts.join(', ') : 'for information'
}

/** Two decimals; a value under 0.01 (a CLS) keeps two significant digits rather than reading 0. */
const num = (n: number) =>
  n !== 0 && Math.abs(n) < 0.01
    ? String(Number(n.toPrecision(2)))
    : String(Math.round(n * 100) / 100)

function rowMeasured(r: Row): string {
  const parts: string[] = []
  if (r.fps !== undefined) parts.push(`${r.fps.toFixed(2)} fps`)
  if (r.p95FrameMs !== undefined) parts.push(`p95 ${r.p95FrameMs.toFixed(1)} ms`)
  if (r.maxFrameMs !== undefined) parts.push(`max ${r.maxFrameMs.toFixed(1)} ms`)
  return parts.join(', ')
}

/** A section with no rows: its own numbers, as the bench wrote them. */
function sectionMeasured(s: Section): string {
  const skip = new Set(['machine', 'machineAtEnd', 'budget', 'failures', 'rows', 'untimed'])
  return Object.entries(s)
    .filter(
      ([k, v]) =>
        !skip.has(k) && !k.startsWith('target') && typeof v === 'number' && Number.isFinite(v),
    )
    .slice(0, 5)
    .map(([k, v]) => `${k} ${num(v as number)}`)
    .join(', ')
}

function machineReason(m: Machine): string {
  const out: string[] = []
  if (m.mains === false) out.push(m.power === 'unknown' ? 'power unknown' : 'battery')
  if (m.quiet === false) out.push(`load ${(m.load1 ?? Number.NaN).toFixed(1)}`)
  if (m.calm === false) {
    const busy = m.top?.find((p) => p.cpu >= HEAVY_CPU)
    out.push(busy ? `busy: ${busy.command} ${busy.cpu.toFixed(0)}%` : 'busy')
  }
  return out.length > 0 ? out.join('; ') : 'not valid'
}

const wellFormed = (v: EnvVerdict | undefined): v is EnvVerdict =>
  v !== undefined && typeof v.valid === 'boolean' && v.samples > 0

/**
 * Why a section's numbers do not count, or null when they do. They count only with the run-long
 * verdict present and valid, and the section's machine (at its start, and at its end when
 * recorded) explicitly valid: missing evidence is never a pass.
 */
function invalidReason(
  env: Env | undefined,
  m: Machine | undefined,
  end: Machine | undefined,
): string | null {
  if (!wellFormed(env?.verdict)) return 'no environment record'
  if (!env.verdict.valid) return env.verdict.reason ?? 'not valid'
  if (m === undefined) return 'no machine record'
  if (m.valid !== true) return machineReason(m)
  if (end !== undefined && end.valid !== true) return machineReason(end)
  return null
}

/** The 1-minute load at the section's start, and at its end when recorded. */
function loadText(m: Machine | undefined, end: Machine | undefined): string {
  const f = (n: number | undefined) => (n === undefined || !Number.isFinite(n) ? '?' : n.toFixed(2))
  if (m?.load1 === undefined) return '–'
  return end?.load1 === undefined ? f(m.load1) : `${f(m.load1)} → ${f(end.load1)}`
}

function tableRow(
  label: string,
  target: string,
  measured: string,
  verdict: string,
  env: Env | undefined,
  s: Section,
  runName: string,
): string {
  const m = s.machine
  const commit = env?.commit ?? m?.commit ?? '–'
  const dirty = m?.dirty ? '+dirty' : ''
  const date = (m?.at ?? runName).slice(0, 10)
  return `| ${[label, target, measured || '–', loadText(m, s.machineAtEnd), verdict, `${commit}${dirty}`, date].map(cell).join(' | ')} |`
}

/** The report: a heading, a note and one table. */
export function renderReport(runs: readonly BenchRun[]): string {
  const head = [
    '# Latest bench runs',
    '',
    'Written by `pnpm bench:report` from the newest result of each section in `e2e/bench/results/` (`pnpm bench` and `pnpm budget`). A row reads `invalid: <reason>` when the run was not quiet (load1 ≥ 4, battery, or a busy process): those numbers are kept out of pass and fail. Load1 is the 1-minute load at the section’s start and end. The bundle budget times nothing, so it is judged whatever the load.',
    '',
  ]
  // Each section comes from the newest file that has it.
  const winner = new Map<string, BenchRun>()
  for (const r of [...runs].sort((a, b) => a.file.localeCompare(b.file)))
    for (const [name, v] of Object.entries(r.json)) if (isSection(name, v)) winner.set(name, r)
  if (winner.size === 0) return [...head, 'No bench results yet: run `pnpm bench`.'].join('\n')

  const lines = [
    '| Row | Target | Measured | Load1 | Verdict | Commit | Date |',
    '|---|---|---|---|---|---|---|',
  ]
  for (const [name, run] of winner) {
    const raw = run.json[name] as Section
    // A machine recorded as anything but a record is no machine record: its rows are invalid.
    const record = (m: unknown) =>
      typeof m === 'object' && m !== null && !Array.isArray(m) ? (m as Machine) : undefined
    const s: Section = {
      ...raw,
      machine: record(raw.machine),
      machineAtEnd: record(raw.machineAtEnd),
    }
    const env = run.json.env as Env | undefined
    const bad = s.untimed === true ? null : invalidReason(env, s.machine, s.machineAtEnd)
    const verdict = (failures: readonly string[] | undefined) =>
      bad !== null
        ? `invalid: ${bad}`
        : failures === undefined
          ? 'invalid: no failures record'
          : failures.length > 0
            ? 'fail'
            : 'pass'
    const runName = String(run.json.run ?? run.file)
    if (Array.isArray(s.rows)) {
      for (const r of s.rows)
        lines.push(
          tableRow(
            `${name} · ${r.id ?? '?'}`,
            r.budget ?? gateText(r.gate),
            rowMeasured(r),
            verdict(r.failures),
            env,
            s,
            runName,
          ),
        )
    } else if (s.budget !== undefined) {
      lines.push(tableRow(name, s.budget, sectionMeasured(s), verdict(s.failures), env, s, runName))
    } else {
      // No target of its own (the blank-page floor): shown, never judged.
      lines.push(
        tableRow(
          name,
          'for information',
          sectionMeasured(s),
          bad !== null ? `invalid: ${bad}` : 'info',
          env,
          s,
          runName,
        ),
      )
    }
  }
  return [...head, ...lines].join('\n')
}

/**
 * Every results file under `dir` (the sampler's `.env.json` is merged into the run, not a run; a
 * Chrome trace a bench saved there, `<run>-trace-<row>.json`, is not one either).
 */
export function readRuns(dir: string): BenchRun[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((n) => n.endsWith('.json') && !n.endsWith('.env.json') && !n.includes('-trace-'))
    .map((file) => ({
      file,
      json: JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>,
    }))
}

const repo = join(import.meta.dirname, '../..')

if (process.argv[1] === import.meta.filename) {
  const dir = join(repo, 'e2e/bench/results')
  const runs = readRuns(dir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'report.md'), `${renderReport(runs)}\n`)
  console.log(`e2e/bench/results/report.md: ${runs.length} result file(s)`)
}
