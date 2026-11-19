import type { ThemeMode } from '@shared/api'

const STORAGE_KEY = 'theme'
const systemDark = window.matchMedia('(prefers-color-scheme: dark)')

export function getThemeMode(): ThemeMode {
  const stored = localStorage.getItem(STORAGE_KEY)
  return stored === 'light' || stored === 'dark' ? stored : 'system'
}

export function applyTheme(mode: ThemeMode): void {
  const resolved = mode === 'system' ? (systemDark.matches ? 'dark' : 'light') : mode
  const root = document.documentElement
  root.dataset.theme = resolved

  // Native window buttons are drawn by the OS, so tell it which colors to use.
  const css = getComputedStyle(root)
  void window.api.window.setTheme(mode, {
    background: css.getPropertyValue('--card').trim(),
    symbols: css.getPropertyValue('--foreground').trim(),
  })
}

export function setThemeMode(mode: ThemeMode): void {
  localStorage.setItem(STORAGE_KEY, mode)
  applyTheme(mode)
}

systemDark.addEventListener('change', () => {
  if (getThemeMode() === 'system') applyTheme('system')
})
