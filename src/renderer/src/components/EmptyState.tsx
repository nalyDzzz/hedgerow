import { Plus, SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useActiveConnection, useStore } from '@/store'

/** Shown in the main area while no query tab is open. */
export function EmptyState() {
  const connections = useStore((state) => state.connections)
  const loaded = useStore((state) => state.loaded)
  const active = useActiveConnection()
  const { setDialog, newTab } = useStore.getState()

  if (!loaded) return null
  const target = active ?? connections[0]

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-[420px] max-w-full">
        {target ? (
          <>
            <h1 className="text-[20px] font-semibold tracking-[-0.01em]">Start a query</h1>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
              Open a query tab on <span className="font-medium text-foreground">{target.name}</span>, or double-click a
              table in the sidebar to see its rows.
            </p>
            <div className="mt-5 flex gap-2">
              <Button size="lg" variant="tint" onClick={() => newTab(target.id)}>
                <SquareTerminal />
                New query
              </Button>
              <Button size="lg" variant="outline" onClick={() => setDialog({ mode: 'new' })}>
                <Plus />
                New connection
              </Button>
            </div>
          </>
        ) : (
          <>
            <h1 className="text-[20px] font-semibold tracking-[-0.01em]">Connect to a database</h1>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
              Add a MySQL server to browse its tables, run SQL and inspect results. Connections stay on this computer.
            </p>
            <Button size="lg" variant="primary" className="mt-5" onClick={() => setDialog({ mode: 'new' })}>
              <Plus />
              New connection
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
