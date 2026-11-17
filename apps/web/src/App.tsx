import { lazy, Suspense } from 'react'
import { AppShell } from './app/AppShell'
import { useRoute } from './app/router'

// `DEV_ROUTES` (app/router.ts), spelt out here so the bundler drops the imports below from a
// release build: the dev routes load on demand, and it holds neither them nor the demo boards.
const DEV = import.meta.env.DEV === true || import.meta.env.VITE_DEV_ROUTES === '1'
const StudyPage = DEV
  ? lazy(() => import('./study/StudyPage').then((m) => ({ default: m.StudyPage })))
  : null
const BenchRoute = DEV
  ? lazy(() => import('./dev/BenchRoute').then((m) => ({ default: m.BenchRoute })))
  : null

export function App() {
  const route = useRoute()
  if (route.name === 'study' && StudyPage) {
    return (
      <Suspense fallback={null}>
        <StudyPage />
      </Suspense>
    )
  }
  if (route.name === 'bench' && BenchRoute) {
    return (
      <Suspense fallback={null}>
        <BenchRoute key={route.board} board={route.board} />
      </Suspense>
    )
  }
  return <AppShell route={route} />
}
