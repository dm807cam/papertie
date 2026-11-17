import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { listenForOpenedFiles } from './app/openedFile'
import { listenForUpdates } from './app/updates'
import { devHooks } from './lib/devHooks'
import './styles/fonts'
import './styles/tokens.css'
import { applyPaletteVars, paletteCssVars } from './styles/palette'
import { STATIONERY_CSS_VARS } from './styles/stationery'

devHooks()
applyPaletteVars(document.documentElement, paletteCssVars())
applyPaletteVars(document.documentElement, STATIONERY_CSS_VARS)

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
// The desktop app: a .papertie file the system opened goes to Settings → Import.
listenForOpenedFiles()
// The desktop app: a newer release the main process found is said on a slip.
listenForUpdates()
