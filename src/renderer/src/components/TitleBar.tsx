import { useState } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import type { ThemeMode } from '@shared/api'
import { APP_NAME } from '@shared/app'
import { Button } from '@/components/ui/button'
import { getThemeMode, setThemeMode } from '@/lib/theme'
import { useActiveConnection, useActiveTab } from '@/store'

const THEMES: { mode: ThemeMode; label: string; icon: typeof Sun }[] = [
  { mode: 'system', label: 'Match system', icon: Monitor },
  { mode: 'light', label: 'Light', icon: Sun },
  { mode: 'dark', label: 'Dark', icon: Moon },
]

/** A table with one selected cell: the app in one glyph. */
function AppMark() {
  return (
    <svg viewBox="0 0 16 16" className="size-4 shrink-0" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.55" />
      <path d="M1.5 6.2h13M6 2.5v11" stroke="currentColor" strokeWidth="1.2" opacity="0.55" />
      <rect x="6.6" y="6.8" width="7.3" height="3.1" rx="0.6" fill="var(--tint)" />
    </svg>
  )
}

function ThemeToggle() {
  const [mode, setMode] = useState(getThemeMode)
  const index = THEMES.findIndex((theme) => theme.mode === mode)
  const current = THEMES[index]
  const next = THEMES[(index + 1) % THEMES.length]

  return (
    <Button
      variant="ghost"
      size="icon"
      title={`Theme: ${current.label}. Click for ${next.label.toLowerCase()}.`}
      aria-label={`Theme: ${current.label}`}
      onClick={() => {
        setThemeMode(next.mode)
        setMode(next.mode)
      }}
    >
      <current.icon />
    </Button>
  )
}

export function TitleBar() {
  const connection = useActiveConnection()
  const tab = useActiveTab()

  return (
    <header className="titlebar drag relative flex h-10 shrink-0 items-center border-b border-border bg-card">
      {/* The one place the connection color always shows: across the top of the window. */}
      {connection && <div className="absolute inset-x-0 top-0 h-0.5 bg-tint" />}

      <div className="flex min-w-0 items-center gap-2 pl-3 text-muted-foreground">
        <AppMark />
        <span className="shrink-0 text-[12.5px] font-medium">{APP_NAME}</span>
        {connection && (
          <>
            <span className="text-faint">/</span>
            <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-foreground">
              <span className="size-2 shrink-0 rounded-full bg-tint" />
              <span className="truncate font-medium">{connection.name}</span>
            </span>
            {tab?.database && (
              <>
                <span className="text-faint">/</span>
                <span className="truncate text-[12.5px]">{tab.database}</span>
              </>
            )}
          </>
        )}
      </div>

      <div className="flex-1" />

      <div className="no-drag flex items-center pr-1.5">
        <ThemeToggle />
      </div>
    </header>
  )
}
