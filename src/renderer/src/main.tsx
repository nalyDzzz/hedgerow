import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource-variable/jetbrains-mono'
import './styles.css'
import { App } from './App'
import { applyTheme, getThemeMode } from './lib/theme'

document.documentElement.dataset.platform = window.api.platform
applyTheme(getThemeMode())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
