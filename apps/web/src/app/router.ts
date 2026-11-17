import { useMemo, useSyncExternalStore } from 'react'

/** `data` is "Delete all data". */
export type SettingsSection = 'export' | 'history' | 'preferences' | 'data'

export type Route =
  | { name: 'board' }
  | { name: 'settings'; section: SettingsSection }
  /** The bookshelf, over the board. */
  | { name: 'shelf' }
  /** A book open in the writer, over the board. */
  | { name: 'book'; id: string }
  | { name: 'study' }
  | { name: 'bench'; board: string }

const SECTIONS: readonly SettingsSection[] = ['export', 'history', 'preferences', 'data']

/** Where Settings opens, and where an address of no section (an old one, say) goes. */
export const FIRST_SECTION: SettingsSection = 'export'

const isSection = (s: string): s is SettingsSection => (SECTIONS as readonly string[]).includes(s)

/** Routes are paths, not hashes: focus mode keeps its state in the hash (`replaceHash`). */
const SIMPLE: Record<string, Route> = {
  '/': { name: 'board' },
  '/shelf': { name: 'shelf' },
}

/** Whether `id` can be a book's: an id's letters, never a path's own (`/`, `.`, `%`). */
export const isBookId = (id: unknown): id is string =>
  typeof id === 'string' && /^book_[0-9A-Za-z]{1,40}$/.test(id)

/**
 * The route for a location. `/study` and `/bench` exist only in dev (`dev`); in
 * a production build they, like any unknown path, are the board.
 */
export function parseRoute(loc: { pathname: string; search: string }, dev: boolean): Route {
  const path = loc.pathname.length > 1 ? loc.pathname.replace(/\/+$/, '') : loc.pathname
  const query = new URLSearchParams(loc.search)
  const simple = SIMPLE[path]
  if (simple) return { ...simple }
  if (path === '/settings') return { name: 'settings', section: FIRST_SECTION }
  if (path.startsWith('/settings/') && !path.slice('/settings/'.length).includes('/')) {
    const section = path.slice('/settings/'.length)
    return { name: 'settings', section: isSection(section) ? section : FIRST_SECTION }
  }
  if (path.startsWith('/book/')) {
    const id = path.slice('/book/'.length)
    if (isBookId(id)) return { name: 'book', id }
  }
  if (dev && path === '/study') return { name: 'study' }
  if (dev && path === '/bench') return { name: 'bench', board: query.get('board') || 'demo' }
  return { name: 'board' }
}

/** The path (and query) for a route: `parseRoute` of it is the same route. */
export function routePath(r: Route): string {
  switch (r.name) {
    case 'board':
      return '/'
    case 'settings':
      return `/settings/${r.section}`
    case 'shelf':
      return '/shelf'
    case 'book':
      return `/book/${encodeURIComponent(r.id)}`
    case 'study':
      return '/study'
    case 'bench':
      return `/bench?board=${encodeURIComponent(r.board)}`
  }
}

const ROUTE_EVENT = 'papertie:route'

/** Go to a route through the History API; `useRoute` listeners hear it as `papertie:route`. */
export function navigate(r: Route, opts: { replace?: boolean } = {}): void {
  if (opts.replace) history.replaceState(null, '', routePath(r))
  else history.pushState(null, '', routePath(r))
  window.dispatchEvent(new Event(ROUTE_EVENT))
}

/**
 * Put `hash` (with its `#`, or '' for none) on the current URL in place: no history entry, no
 * `hashchange` and no route change. Focus mode keeps its state there (`#focus=…&d=2`).
 */
export function replaceHash(hash: string): void {
  // A bare `#` reads as '' too, but is left on the URL until replaced.
  if (location.hash === hash && !location.href.endsWith('#')) return
  history.replaceState(history.state, '', `${location.pathname}${location.search}${hash}`)
}

/** Leave this page for a fresh load of `path` (the board after "Delete all data", say). */
export function loadPage(path: string): void {
  location.assign(path)
}

/**
 * Whether `/study` and `/bench` exist: dev server builds, or a bundle built with
 * `VITE_DEV_ROUTES=1` (the e2e bench build). Decided at build time, never from the URL, so a
 * normal production build serves neither.
 */
export const DEV_ROUTES: boolean =
  import.meta.env.DEV === true || import.meta.env.VITE_DEV_ROUTES === '1'

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange)
  window.addEventListener(ROUTE_EVENT, onChange)
  return () => {
    window.removeEventListener('popstate', onChange)
    window.removeEventListener(ROUTE_EVENT, onChange)
  }
}

const snapshot = () => location.pathname + location.search

/** The current route, re-rendering on `navigate`, back and forward. */
export function useRoute(): Route {
  const where = useSyncExternalStore(subscribe, snapshot)
  return useMemo(() => {
    const url = new URL(where, location.origin)
    return parseRoute(url, DEV_ROUTES)
  }, [where])
}
