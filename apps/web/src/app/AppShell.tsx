import { BoardScreen } from './BoardScreen'
import type { Route } from './router'
import { ShellCork } from './Stage'

type AppRoute = Exclude<Route, { name: 'study' | 'bench' }>

function Page({ route }: { route: AppRoute }) {
  switch (route.name) {
    case 'board':
      return <BoardScreen />
    case 'settings':
      // The same board screen, with Settings laid over it: opening and closing keep the board.
      return <BoardScreen settings={route.section} />
    case 'shelf':
      // The same board screen again, with the shelf over it: the board stays mounted under it.
      return <BoardScreen books={{ kind: 'shelf' }} />
    case 'book':
      return <BoardScreen books={{ kind: 'book', bookId: route.id }} />
  }
}

/** The app: the board, and settings and the books over it. Nothing is asked before the board. */
export function AppShell({ route }: { route: Route }) {
  if (route.name === 'study' || route.name === 'bench') return null
  return (
    <div className="app-shell" data-testid="app-shell" data-route={route.name}>
      <ShellCork />
      <Page route={route} />
    </div>
  )
}
