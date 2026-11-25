import { useState } from 'react'
import { Check, CircleAlert, Copy, LoaderCircle } from 'lucide-react'
import type { SaveResult, TableRef } from '@shared/driver'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { CodeView } from '@/editor/CodeView'
import { plural } from '@/lib/format'

/** What the driver made of the staged changes: the statements to run, or why there are none. */
export type SavePlan = { statements: string[] } | { problem: string }

interface SaveChangesDialogProps {
  plan: SavePlan
  table: TableRef
  /** Name of the connection the statements will run on. */
  connection: string
  changes: number
  /** Runs the statements. Resolves with a failure when nothing was saved. */
  onSave(statements: string[]): Promise<SaveResult>
  /** Interrupts a save that is running, for one that waits on a lock held elsewhere. */
  onStop(): void
  onClose(): void
}

/**
 * The last step before anything reaches the database: the exact statements,
 * and the choice to run them or not.
 */
export function SaveChangesDialog({
  plan,
  table,
  connection,
  changes,
  onSave,
  onStop,
  onClose,
}: SaveChangesDialogProps) {
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<Extract<SaveResult, { ok: false }> | null>(null)
  const [copied, setCopied] = useState(false)

  const statements = 'statements' in plan ? plan.statements : []
  // Each statement is sent on its own. The semicolons are only for reading, and for pasting elsewhere.
  const script = statements.map((statement) => `${statement};`).join('\n')

  const save = async () => {
    setSaving(true)
    setFailure(null)
    const outcome = await onSave(statements)
    setSaving(false)
    if (outcome.ok) onClose()
    else setFailure(outcome)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent
        className="flex max-h-[calc(100vh-64px)] w-[680px] flex-col p-4"
        // Start on the button that answers the question, not on the first thing that can take focus.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          event.currentTarget instanceof HTMLElement &&
            event.currentTarget.querySelector<HTMLElement>('[data-primary]')?.focus()
        }}
      >
        {'problem' in plan ? (
          <>
            <DialogTitle>These changes cannot be saved yet</DialogTitle>
            <DialogDescription className="selectable mt-1.5 text-foreground">{plan.problem}</DialogDescription>
            <p className="mt-1.5 text-[12.5px] text-muted-foreground">
              Nothing was sent to the database. Your changes are still in the grid.
            </p>
            <div className="mt-4 flex justify-end">
              <Button data-primary size="lg" onClick={onClose}>
                Back to the grid
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogTitle>
              Save {plural(changes, 'change')} to {table.table}?
            </DialogTitle>
            <DialogDescription className="mt-1.5">
              {statements.length === 1 ? 'This statement runs' : `These ${statements.length} statements run`} on{' '}
              <span className="font-medium text-foreground">{connection}</span>, in{' '}
              <span className="font-mono text-[11.5px]">{table.database}</span>, as one transaction. If any of them
              fails, or changes anything other than exactly one row, none of them takes effect.
            </DialogDescription>

            <div className="mt-3 max-h-[min(320px,45vh)] min-h-[58px] overflow-auto rounded-md border border-border">
              <CodeView language="sql" value={script} />
            </div>

            {failure && (
              <div className="mt-3 flex items-start gap-2 text-destructive" role="alert">
                <CircleAlert className="mt-0.5 size-4 shrink-0" />
                <div className="min-w-0 text-[12.5px]">
                  <p className="font-medium">
                    {failure.notUndone ? 'The save did not go through, but part of it may remain.' : 'Nothing was saved.'}
                  </p>
                  <p className="selectable mt-0.5">
                    {failure.statement !== undefined &&
                      statements.length > 1 &&
                      `Statement ${failure.statement + 1} of ${statements.length} stopped it. `}
                    {failure.message}
                    {failure.connectionLost && ' The connection to the server was lost. Try again to reconnect.'}
                  </p>
                  {failure.notUndone && <p className="selectable mt-1.5 text-foreground">{failure.notUndone}</p>}
                  {failure.statement !== undefined && statements.length > 1 && (
                    <pre className="selectable mt-1.5 max-h-20 overflow-auto whitespace-pre-wrap break-words rounded-md border border-destructive/30 p-2 font-mono text-[11.5px] text-foreground">
                      {statements[failure.statement]}
                    </pre>
                  )}
                </div>
              </div>
            )}

            <div className="mt-4 flex items-center gap-2">
              <Button
                size="lg"
                variant="ghost"
                onClick={() => {
                  void navigator.clipboard.writeText(script)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1200)
                }}
              >
                {copied ? <Check /> : <Copy />}
                Copy SQL
              </Button>
              <div className="flex-1" />
              {saving ? (
                <Button size="lg" variant="danger" title="Interrupt the save. Nothing will have been saved." onClick={onStop}>
                  Stop
                </Button>
              ) : (
                <Button size="lg" onClick={onClose}>
                  Cancel
                </Button>
              )}
              <Button data-primary size="lg" variant="tint" disabled={saving} onClick={() => void save()}>
                {saving && <LoaderCircle className="animate-spin" />}
                {saving ? 'Saving…' : failure ? 'Try again' : `Save ${plural(changes, 'change')}`}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
