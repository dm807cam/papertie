/**
 * The orphans' notes: a footnote whose anchored text is gone is shown, never
 * dropped, faded (`data-orphan`, the engine's), with "No longer anchored · Remove" beside it,
 * outside the editing host (as the pins are). Laid out from the window's blocks as the page lays
 * out (`onLayout`, once a frame at most): O(window).
 */
import { useEffect, useRef, useState } from 'react'
import type { BlockEngine } from '../editor/blockEngine'

interface Orphan {
  id: string
  top: number
}

const same = (a: readonly Orphan[], b: readonly Orphan[]) =>
  a.length === b.length && a.every((o, i) => o.id === b[i]?.id && o.top === b[i]?.top)

export function FootnoteLayer({
  engine,
  page,
}: {
  engine: Pick<BlockEngine, 'liveBlocks' | 'onLayout' | 'orphan' | 'removeFootnote'>
  /** The book's blocks' parent: the notes' tops are in its coordinates. */
  page(): HTMLElement | null
}) {
  const layer = useRef<HTMLDivElement>(null)
  const [orphans, setOrphans] = useState<readonly Orphan[]>([])
  const pageRef = useRef(page)
  pageRef.current = page

  useEffect(() => {
    const compute = () => {
      const next: Orphan[] = []
      for (const b of engine.liveBlocks())
        if (b.kind === 'footnote' && engine.orphan(b.id)) next.push({ id: b.id, top: b.top })
      setOrphans((was) => (same(was, next) ? was : next))
      const el = layer.current
      const p = pageRef.current()
      const parent = el?.offsetParent ?? el?.parentElement
      if (el && p && parent) {
        // Over the book's text column: a note's right edge is the text's.
        const r = p.getBoundingClientRect()
        const q = parent.getBoundingClientRect()
        el.style.top = `${Math.round(r.top - q.top)}px`
        el.style.left = `${Math.round(r.left - q.left)}px`
        el.style.width = `${Math.round(r.width)}px`
      }
    }
    compute()
    return engine.onLayout(compute)
  }, [engine])

  return (
    <div ref={layer} className="bk-orphans">
      {orphans.map((o) => (
        <p
          key={o.id}
          className="bk-orphan"
          ref={(el) => {
            if (el) el.style.top = `${Math.round(o.top)}px`
          }}
        >
          <span>No longer anchored</span>
          <span aria-hidden="true"> · </span>
          <button
            type="button"
            className="bk-orphan-remove"
            onClick={() => engine.removeFootnote(o.id)}
          >
            Remove
          </button>
        </p>
      ))}
    </div>
  )
}
