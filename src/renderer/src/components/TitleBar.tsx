import { useState } from 'react'
import { ArrowDownToLine, Monitor, Moon, RotateCw, Sun } from 'lucide-react'
import type { ThemeMode } from '@shared/api'
import { APP_NAME } from '@shared/app'
import { Button } from '@/components/ui/button'
import { getThemeMode, setThemeMode } from '@/lib/theme'
import { useActiveConnection, useActiveTab } from '@/store'
import { useAnnouncedUpdate, useUpdateDownload, useUpdates } from '@/updates'

const THEMES: { mode: ThemeMode; label: string; icon: typeof Sun }[] = [
  { mode: 'system', label: 'Match system', icon: Monitor },
  { mode: 'light', label: 'Light', icon: Sun },
  { mode: 'dark', label: 'Dark', icon: Moon },
]

/**
 * The hedgehog from the app icon (build/icon-small.svg) in one color, without its
 * tile. It stays neutral because the only strong color in the chrome is the
 * connection's.
 */
function AppMark() {
  return (
    <svg viewBox="48 88 432 336" className="h-[14px] w-[18px] shrink-0" fill="currentColor" aria-hidden="true">
      <path d="M144 104H296A40 64 0 0 1 336 168H176Z" opacity="0.5" />
      <path d="M96 200H360A40 64 0 0 1 400 264H128Z" opacity="0.65" />
      <path d="M64 296H264V360H96Z" opacity="0.8" />
      <path d="M280 308Q280 272 316 272H330C378 272 426 308 458 346Q468 360 458 372C438 394 408 408 368 408H316Q280 408 280 372Z" />
      <circle cx="368" cy="328" r="19" fill="var(--card)" />
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

/**
 * Says that a newer version is out. It stays quiet and neutral: the one strong
 * color in the window belongs to the connection.
 */
function UpdateNotice() {
  const update = useAnnouncedUpdate()
  const download = useUpdateDownload()
  if (!update) return null
  const share = download.state === 'downloading' && download.total > 0 ? download.received / download.total : 0
  const [label, title] =
    download.state === 'ready'
      ? ['Restart to update', `${APP_NAME} ${update.version} is downloaded. Click to restart and install it.`]
      : download.state === 'downloading'
        ? [`Downloading ${update.version} · ${Math.floor(share * 100)}%`, `${APP_NAME} ${update.version} is downloading.`]
        : [`${update.version} available`, `${APP_NAME} ${update.version} is available. Click to see what is new and get it.`]
  return (
    <Button
      variant="outline"
      size="sm"
      className="mr-1.5 text-muted-foreground tabular-nums"
      title={title}
      onClick={() => useUpdates.getState().setDialogOpen(true)}
    >
      {download.state === 'ready' ? <RotateCw /> : <ArrowDownToLine />}
      {label}
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
        <UpdateNotice />
        <ThemeToggle />
      </div>
    </header>
  )
}
