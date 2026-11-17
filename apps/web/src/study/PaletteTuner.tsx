import {
  PALETTE as BASE,
  contrastRatio,
  PALETTE_TOKENS,
  type PaletteEntry,
  type PaletteToken,
} from '@papertie/core'
import { useState } from 'react'
import { paletteWarnings } from '../styles/palette'

export type Palette = Record<PaletteToken, PaletteEntry>
type Overrides = Partial<Record<PaletteToken, { paper?: string; yarn?: string }>>

/** localStorage key for the tuner's overrides. */
export const PALETTE_STORAGE_KEY = 'papertie.proto.palette'

const HEX = /^#[0-9a-f]{6}$/i

/** Stored overrides, keeping only known tokens and valid #rrggbb values. */
function readOverrides(): Overrides {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(PALETTE_STORAGE_KEY)
  } catch {
    return {}
  }
  if (raw === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}
  const out: Overrides = {}
  for (const token of PALETTE_TOKENS) {
    const v = (parsed as Record<string, unknown>)[token]
    if (typeof v !== 'object' || v === null) continue
    const { paper, yarn } = v as Record<string, unknown>
    const entry: { paper?: string; yarn?: string } = {}
    if (typeof paper === 'string' && HEX.test(paper)) entry.paper = paper.toUpperCase()
    if (typeof yarn === 'string' && HEX.test(yarn)) entry.yarn = yarn.toUpperCase()
    if (entry.paper !== undefined || entry.yarn !== undefined) out[token] = entry
  }
  return out
}

function writeOverrides(p: Palette): void {
  const out: Overrides = {}
  for (const token of PALETTE_TOKENS) {
    const entry: { paper?: string; yarn?: string } = {}
    if (p[token].paper !== BASE[token].paper) entry.paper = p[token].paper
    if (p[token].yarn !== BASE[token].yarn) entry.yarn = p[token].yarn
    if (entry.paper !== undefined || entry.yarn !== undefined) out[token] = entry
  }
  try {
    if (Object.keys(out).length === 0) localStorage.removeItem(PALETTE_STORAGE_KEY)
    else localStorage.setItem(PALETTE_STORAGE_KEY, JSON.stringify(out))
  } catch {
    // Storage may be unavailable (private mode, quota); the tuner still works for the session.
  }
}

/** Core's palette with any stored overrides applied. */
export function loadPalette(): Palette {
  const over = readOverrides()
  const out = {} as Palette
  for (const token of PALETTE_TOKENS) out[token] = { ...BASE[token], ...over[token] }
  return out
}

/** `{ [token]: { paper, yarn } }` for every token, as pasted back into core's palette. */
export function paletteJson(p: Palette): string {
  const out: Record<string, { paper: string; yarn: string }> = {}
  for (const token of PALETTE_TOKENS) out[token] = { paper: p[token].paper, yarn: p[token].yarn }
  return JSON.stringify(out, null, 2)
}

/**
 * Colour inputs for each token's paper and yarn with the live ink contrast (flagged under 7:1).
 * Overrides persist in localStorage; "Copy JSON" exports the whole tuned palette.
 */
export function PaletteTuner({
  palette,
  onChange,
}: {
  palette: Palette
  onChange: (p: Palette) => void
}) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [json, setJson] = useState<string | null>(null)
  const low = new Set(paletteWarnings(palette).map((w) => w.token))

  const set = (token: PaletteToken, role: 'paper' | 'yarn', value: string) => {
    if (!HEX.test(value)) return
    const next = { ...palette, [token]: { ...palette[token], [role]: value.toUpperCase() } }
    writeOverrides(next)
    setCopied('idle')
    onChange(next)
  }

  const reset = () => {
    const next = { ...BASE }
    writeOverrides(next)
    setCopied('idle')
    setJson(null)
    onChange(next)
  }

  const copy = async () => {
    const text = paletteJson(palette)
    setJson(text)
    try {
      await navigator.clipboard.writeText(text)
      setCopied('copied')
    } catch {
      setCopied('failed')
    }
  }

  const tuned = PALETTE_TOKENS.some(
    (t) => palette[t].paper !== BASE[t].paper || palette[t].yarn !== BASE[t].yarn,
  )

  return (
    <div className="tuner" data-testid="palette-tuner">
      <table className="tuner-table">
        <thead>
          <tr>
            <th scope="col">Token</th>
            <th scope="col">Paper</th>
            <th scope="col">Yarn</th>
            <th scope="col">Sample</th>
            <th scope="col">Ink contrast</th>
          </tr>
        </thead>
        <tbody>
          {PALETTE_TOKENS.map((token) => {
            const e = palette[token]
            const ratio = contrastRatio(e.ink, e.paper)
            const flagged = low.has(token)
            return (
              <tr key={token} data-token={token}>
                <th scope="row">
                  <span className="tuner-token">{token}</span>
                </th>
                <td>
                  <label className="tuner-swatch">
                    <input
                      type="color"
                      value={e.paper.toLowerCase()}
                      aria-label={`${token} paper`}
                      onChange={(ev) => set(token, 'paper', ev.currentTarget.value)}
                    />
                    <code className={e.paper === BASE[token].paper ? '' : 'is-tuned'}>
                      {e.paper}
                    </code>
                  </label>
                </td>
                <td>
                  <label className="tuner-swatch">
                    <input
                      type="color"
                      value={e.yarn.toLowerCase()}
                      aria-label={`${token} yarn`}
                      onChange={(ev) => set(token, 'yarn', ev.currentTarget.value)}
                    />
                    <code className={e.yarn === BASE[token].yarn ? '' : 'is-tuned'}>{e.yarn}</code>
                  </label>
                </td>
                <td>
                  <span
                    className="tuner-sample"
                    style={{ background: e.paper, color: e.ink, borderBottomColor: e.yarn }}
                  >
                    Tie Aa
                  </span>
                </td>
                <td>
                  <output className={flagged ? 'tuner-ratio is-low' : 'tuner-ratio'}>
                    {ratio.toFixed(2)}:1
                    {flagged && <span className="tuner-flag">below 7:1</span>}
                  </output>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="tuner-actions">
        <button type="button" className="study-button" onClick={copy}>
          Copy JSON
        </button>
        <button type="button" className="study-button study-button--quiet" onClick={reset}>
          Reset to core palette
        </button>
        <span className="tuner-status" role="status">
          {copied === 'copied'
            ? 'Copied to the clipboard.'
            : copied === 'failed'
              ? 'Clipboard unavailable; copy from below.'
              : tuned
                ? 'Tuned values are saved in this browser.'
                : 'Showing the core palette.'}
        </span>
      </div>
      {json !== null && (
        <pre className="tuner-json" data-testid="palette-json">
          {json}
        </pre>
      )}
    </div>
  )
}
