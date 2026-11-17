import {
  Component,
  type ComponentType,
  Fragment,
  lazy,
  type ReactNode,
  useEffect,
  useState,
} from 'react'

/**
 * A screen in a chunk of its own, loaded when first shown or ahead of that (`load`, at idle).
 * Once its chunk is in, it renders at once, never suspending again: a screen preloaded before it
 * opens shows in the very commit that opens it, with no blank frame. Until then it suspends (the
 * `Suspense` around it shows nothing: there are no loading states). A failed load throws to the
 * boundary around it, and is tried again only once something asks for it ({@link retryChunks}:
 * "Try again", or a picker opened again): never by itself, so no loop of failing fetches.
 */
export interface Chunk<P extends object> {
  /** The screen: suspends until its chunk is in. */
  Component: ComponentType<P>
  /** Load the chunk (once; a failed load is tried again on the next call). */
  load(): Promise<void>
}

/** Bumped by each ask to try failed chunks again: a chunk that failed before it loads afresh. */
let epoch = 0
export const retryChunks = (): void => {
  epoch++
}

export function lazyChunk<P extends object>(load: () => Promise<ComponentType<P>>): Chunk<P> {
  type Loaded = { default: ComponentType<P> }
  let ready: Loaded | null = null
  let loading: Promise<Loaded> | null = null
  /** The {@link epoch} the last load failed in; null when none has. */
  let failed: number | null = null
  const fetch = () => {
    loading ??= load().then(
      (c) => {
        ready = { default: c }
        // In now (a prefetch, say): a screen that failed before renders it at once.
        if (failed !== null) {
          failed = null
          Lazy = make()
        }
        return ready
      },
      (e: unknown) => {
        // The failed one keeps its error (for the boundary); a screen mounted after a retry
        // tries a fresh one.
        loading = null
        failed = epoch
        throw e
      },
    )
    return loading
  }
  // Once in, the factory answers at once (a thenable resolved in `then` itself), so the screen
  // renders in the commit that mounts it, never a frame later.
  const make = () =>
    lazy(() =>
      ready === null
        ? fetch()
        : // biome-ignore lint/suspicious/noThenProperty: a thenable on purpose, resolved in `then`
          ({ then: (done: (m: Loaded) => void) => done(ready as Loaded) } as Promise<Loaded>),
    )
  let Lazy = make()
  // biome-ignore lint/correctness/noComponentHookFactories: made once per chunk, at module level
  function Screen(props: P) {
    const [L] = useState(() => {
      if (failed !== null && failed < epoch) {
        failed = null
        Lazy = make()
      }
      return Lazy
    })
    return <L {...props} />
  }
  return { Component: Screen, load: () => fetch().then(() => undefined) }
}

interface BoundaryState {
  failed: boolean
  /** Bumped by "Try again": the screen under it is mounted afresh. */
  attempt: number
}

/** The slip in a failed screen's place; Esc (`onEscape`) leaves it. */
function Slip({
  sheet,
  onRetry,
  onEscape,
}: {
  sheet: boolean
  onRetry(): void
  onEscape?: () => void
}) {
  useEffect(() => {
    if (!onEscape) return
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return
      e.preventDefault()
      onEscape()
    }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onEscape])
  return (
    <div className={sheet ? 'chunk-failed chunk-failed--sheet' : 'chunk-failed'} role="alert">
      <div className="chunk-failed-card">
        <p className="chunk-failed-text">
          Couldn’t open this. Check your connection and try again.
        </p>
        <button type="button" className="stage-button" onClick={onRetry}>
          Try again
        </button>
      </div>
    </div>
  )
}

/**
 * Around a lazy screen: when its chunk fails to load, a quiet slip says so in place of the screen,
 * with "Try again" (which loads it again). A sheet's (`sheet`: the shelf, a book) lies where the
 * sheet would, under the sidebar and the mini-bar, which stay in use; with `retry`, each time
 * the boundary mounts (a sheet opened again) a chunk that failed is fetched again. What failed is
 * counted in the console, never more.
 */
export class ChunkBoundary extends Component<
  {
    children: ReactNode
    sheet?: boolean
    onEscape?: () => void
    /** A chunk that failed before is fetched again as this boundary mounts (once, not in a loop). */
    retry?: boolean
  },
  BoundaryState
> {
  state: BoundaryState = { failed: false, attempt: 0 }

  constructor(props: ChunkBoundary['props']) {
    super(props)
    if (props.retry) retryChunks()
  }

  static getDerivedStateFromError(): Partial<BoundaryState> {
    return { failed: true }
  }

  componentDidCatch(): void {
    failures++
    console.error(`chunk load failed (${failures})`)
  }

  render(): ReactNode {
    if (!this.state.failed)
      return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>
    return (
      <Slip
        sheet={this.props.sheet === true}
        onEscape={this.props.onEscape}
        onRetry={() => {
          retryChunks()
          this.setState((s) => ({ failed: false, attempt: s.attempt + 1 }))
        }}
      />
    )
  }
}

let failures = 0
