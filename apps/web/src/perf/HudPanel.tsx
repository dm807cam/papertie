/** The perf HUD's panel: a chunk of its own, loaded once the HUD is first switched on. */
import { useEffect, useRef } from 'react'
import type { CanvasRuntime } from '../canvas/runtime'
import { FrameStats, loopSampler } from './frameStats'
import { HUD_REFRESH_MS } from './PerfHud'
import './perfHud.css'

const ROWS = [
  ['fps', 'fps'],
  ['p95', 'p95 ms'],
  ['long', 'long'],
  ['zoom', 'zoom'],
  ['notes', 'notes'],
  ['yarn', 'yarn s/d'],
  ['pins', 'pins'],
  ['motion', 'springs/anim'],
  ['loop', 'loop'],
] as const

type RowKey = (typeof ROWS)[number][0]

function readings(rt: CanvasRuntime, stats: FrameStats): Record<RowKey, string> {
  const f = stats.snapshot()
  const c = rt.camera.get()
  const y = rt.yarnStats
  return {
    fps: f.frames === 0 ? '–' : f.fps.toFixed(1),
    p95: f.frames === 0 ? '–' : f.p95FrameMs.toFixed(1),
    long: String(f.longFrames),
    zoom: `${c.zoom.toFixed(2)} ${rt.view.getState().lod}`,
    notes: `${rt.lod === 'overview' ? (y.pyramid ? `${y.pyramid.tiles} tiles` : `${y.cards ?? 0} cards`) : rt.noteEls.size} / ${rt.store.getState().notes.size}`,
    yarn: `${y.segmentsStatic} / ${y.segmentsDynamic}`,
    pins: String(y.pins),
    motion: `${rt.motion.awakeCount} / ${rt.motion.activeAnimations}`,
    loop: rt.loop.running ? 'running' : 'idle',
  }
}

/** The numbers, sampled from the frame loop and written straight into the DOM at 4 Hz. */
export function HudPanel({ runtime }: { runtime: CanvasRuntime }) {
  const cells = useRef(new Map<RowKey, HTMLElement>())
  useEffect(() => {
    const stats = new FrameStats()
    const off = runtime.loop.add(loopSampler(stats))
    const write = () => {
      for (const [k, v] of Object.entries(readings(runtime, stats)) as [RowKey, string][]) {
        const el = cells.current.get(k)
        if (el !== undefined && el.textContent !== v) el.textContent = v
      }
    }
    write()
    const timer = setInterval(write, HUD_REFRESH_MS)
    return () => {
      clearInterval(timer)
      off()
    }
  }, [runtime])
  return (
    <aside className="perf-hud" aria-label="Performance" data-testid="perf-hud">
      <dl className="perf-hud-list">
        {ROWS.map(([k, label]) => (
          <div key={k} className="perf-hud-row">
            <dt>{label}</dt>
            <dd
              data-hud={k}
              ref={(el) => {
                if (el === null) cells.current.delete(k)
                else cells.current.set(k, el)
              }}
            />
          </div>
        ))}
      </dl>
    </aside>
  )
}
