import { DRIVER_INFO } from '@shared/driver'
import { MOD } from '@/lib/utils'
import { useActiveConnection, useStore } from '@/store'
import { useUpdates } from '@/updates'

function Key({ children }: { children: string }) {
  return (
    <kbd className="rounded-[3px] border border-border bg-background px-1 font-sans text-[10.5px] text-muted-foreground">
      {children}
    </kbd>
  )
}

export function StatusBar() {
  const connection = useActiveConnection()
  const live = useStore((state) => (connection ? state.live[connection.id] : undefined))
  const version = useUpdates((state) => state.version)

  const status = !connection
    ? 'No connection selected'
    : live?.status === 'connected'
      ? `${DRIVER_INFO[connection.driver].label} ${live.serverVersion ?? ''} · ${connection.user}@${connection.host}:${connection.port}`
      : live?.status === 'connecting'
        ? `Connecting to ${connection.host}:${connection.port}…`
        : live?.status === 'failed'
          ? 'Could not connect'
          : 'Not connected'

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-card px-3 text-[11.5px] text-muted-foreground">
      <span className="truncate">{status}</span>
      <div className="flex-1" />
      <span className="flex shrink-0 items-center gap-1">
        <Key>{MOD}</Key>
        <Key>Enter</Key>
        <span className="mr-2">Run</span>
        <Key>{MOD}</Key>
        <Key>Shift</Key>
        <Key>Enter</Key>
        <span className="mr-2">Run all</span>
        <Key>{MOD}</Key>
        <Key>T</Key>
        <span>New query</span>
      </span>
      {version && (
        <button
          className="shrink-0 border-l border-border pl-3 text-faint hover:text-foreground"
          title="This version, and whether there is a newer one"
          onClick={() => useUpdates.getState().setDialogOpen(true)}
        >
          v{version}
        </button>
      )}
    </footer>
  )
}
