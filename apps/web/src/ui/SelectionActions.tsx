import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { deleteSelection, duplicateSelection, type SelectionTarget } from '../notes/noteCommands'
import { createViewStore, useView, type ViewStore } from '../proto/viewStore'
import type { BoardStore } from '../store/boardStore'
import { ActionButton, duplicateShortcut } from './buttons'
import { handToBoard } from './handToBoard'
import { DeleteIcon, DuplicateIcon, FocusIcon } from './sidebarIcons'

/** What the selection's actions ask of the board (the canvas runtime). */
export interface SelectionHost extends SelectionTarget {
  /** The selection, as the notes read it. */
  readonly view: ViewStore
  readonly store: BoardStore
  focusSelection(): boolean
  /** The selected thread (a note selection clears it), and when it changes. */
  readonly selectedYarnId: string | undefined
  onYarnSelection(fn: () => void): () => void
  selectYarn(id: string | null): void
  readonly yarnFlows: { untie(yarnId: string): void }
}

/** A view with nothing selected, read until the canvas is up. */
const NO_VIEW = createViewStore()

/** The selected thread's id, followed. */
function useSelectedYarn(host: SelectionHost | null): string | undefined {
  const subscribe = useCallback(
    (fn: () => void) => (host === null ? () => {} : host.onYarnSelection(fn)),
    [host],
  )
  return useSyncExternalStore(subscribe, () => host?.selectedYarnId)
}

/**
 * The sidebar's selection section: Duplicate, Focus and Delete for the selected notes, and only
 * Delete (untie) for a selected thread, which nothing edits; the board's only commands on a
 * selection besides its keys (⌘D, F, ⌫). It unfolds under the tools while something is selected
 * and folds away (inert) when nothing is; it never moves the tools above it. `host` is the canvas
 * runtime, null until it is up.
 */
export function SelectionActions({
  host,
  className = 'sidebar-selection',
  says = false,
}: {
  host: SelectionHost | null
  className?: string
  /**
   * Whether it says on the page's root that its row is out (`data-selection-row`), for what
   * floats above the mini-bar outside the UI layer: the "Papertie was updated" slip.
   */
  says?: boolean
}) {
  const ids = useView(host?.view ?? NO_VIEW, (v) => v.selected)
  const thread = useSelectedYarn(host)
  const box = useRef<HTMLDivElement>(null)
  const shown = host !== null && (ids.size > 0 || thread !== undefined)

  useLayoutEffect(() => {
    const root = box.current?.ownerDocument.documentElement
    if (!says || !shown || !root) return
    root.dataset.selectionRow = ''
    return () => {
      delete root.dataset.selectionRow
    }
  }, [says, shown])

  // Focus on one of its buttons as it folds away (a delete, Esc) goes to the board, never <body>.
  useLayoutEffect(() => {
    const el = box.current
    const active = el?.ownerDocument.activeElement
    if (!shown && active && el?.contains(active)) handToBoard(el)
  }, [shown])

  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of commands, not a form field set
    <div
      ref={box}
      className={className}
      role="group"
      aria-label="Selection"
      data-shown={shown || undefined}
      inert={!shown}
    >
      <div className="sidebar-selection-inner">
        <span className="sidebar-rule" aria-hidden="true" />
        {thread === undefined && (
          <>
            <ActionButton
              label="Duplicate"
              Icon={DuplicateIcon}
              shortcut={duplicateShortcut()}
              keys="Meta+D Control+D"
              onClick={() => host && duplicateSelection(host.store, ids, host)}
            />
            <ActionButton
              label="Focus"
              Icon={FocusIcon}
              shortcut="F"
              keys="F"
              onClick={() => host?.focusSelection()}
            />
          </>
        )}
        <ActionButton
          label="Delete"
          Icon={DeleteIcon}
          shortcut="⌫"
          keys="Delete Backspace"
          data-danger=""
          onClick={() => {
            if (!host) return
            handToBoard(box.current)
            if (thread === undefined) {
              deleteSelection(host.store, ids)
              return
            }
            host.selectYarn(null)
            host.yarnFlows.untie(thread)
          }}
        />
      </div>
    </div>
  )
}
