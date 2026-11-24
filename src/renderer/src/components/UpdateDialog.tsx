import { ArrowDownToLine, CircleAlert, CircleCheck, LoaderCircle } from 'lucide-react'
import { APP_NAME } from '@shared/app'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useUpdates } from '@/updates'

const dates = new Intl.DateTimeFormat('en-US', { dateStyle: 'long' })

function released(date: string | null): string {
  const time = date ? Date.parse(date) : Number.NaN
  return Number.isNaN(time) ? '' : `Released on ${dates.format(time)}. `
}

/**
 * Which version is running, whether a newer one exists, and the one setting
 * there is about that. An update is offered here, never installed unasked.
 */
export function UpdateDialog() {
  const { version, automatic, checking, checked, available, problem, skipped, dialogOpen } = useUpdates()
  const { check, setAutomatic, skip, setDialogOpen } = useUpdates.getState()
  const running = version ?? ''

  return (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <DialogContent
        className="w-[460px] p-4"
        // Start on the main action. The first button in reading order is Skip, which Enter should not press.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          event.currentTarget instanceof HTMLElement &&
            event.currentTarget.querySelector<HTMLElement>('[data-primary]')?.focus()
        }}
      >
        {available ? (
          <>
            <DialogTitle>
              {APP_NAME} {available.version} is available
            </DialogTitle>
            <DialogDescription className="mt-1.5">
              {released(available.publishedAt)}You are running {running}.
            </DialogDescription>
            {available.summary && (
              <p className="selectable mt-2.5 text-[12.5px] leading-relaxed text-foreground">{available.summary}</p>
            )}
            <p className="mt-2.5 text-[12px] leading-snug text-muted-foreground">
              {available.download
                ? `Download fetches ${available.download.name} with your browser. Run it to replace this version. Your saved connections are kept.`
                : 'There is no ready-made download for this system. The release page has the others, and the source.'}
            </p>

            <div className="mt-4 flex items-center gap-2">
              <Button
                size="lg"
                variant="ghost"
                className="-ml-2"
                disabled={skipped === available.version}
                title="Stop mentioning this version. A later one is announced again."
                onClick={() => {
                  skip(available.version)
                  setDialogOpen(false)
                }}
              >
                {skipped === available.version ? 'Skipped' : 'Skip this version'}
              </Button>
              <div className="flex-1" />
              <Button
                size="lg"
                data-primary={available.download ? undefined : ''}
                onClick={() => window.open(available.releaseUrl)}
              >
                What is new
              </Button>
              {available.download && (
                <Button size="lg" variant="primary" data-primary onClick={() => window.open(available.download!.url)}>
                  <ArrowDownToLine />
                  Download
                </Button>
              )}
            </div>
          </>
        ) : (
          <>
            <DialogTitle>
              {APP_NAME} {running}
            </DialogTitle>
            <DialogDescription className="mt-1.5 flex items-center gap-1.5">
              {checking ? (
                <>
                  <LoaderCircle className="size-3.5 animate-spin" />
                  Looking for a newer version…
                </>
              ) : checked && !problem ? (
                <>
                  <CircleCheck className="size-3.5" />
                  This is the latest version.
                </>
              ) : (
                'It has not looked for a newer version yet.'
              )}
            </DialogDescription>
            <div className="mt-4 flex justify-end gap-2">
              <DialogClose asChild>
                <Button size="lg">Close</Button>
              </DialogClose>
              <Button size="lg" variant="primary" data-primary disabled={checking} onClick={() => void check()}>
                Check now
              </Button>
            </div>
          </>
        )}

        {problem && !checking && (
          <p className="selectable mt-3 flex items-start gap-1.5 text-[12px] text-destructive" role="alert">
            <CircleAlert className="mt-px size-3.5 shrink-0" />
            {problem}
          </p>
        )}

        <label className="mt-4 flex items-start gap-2 border-t border-border pt-3 text-[12px] text-muted-foreground">
          <input
            type="checkbox"
            className="mt-0.5 accent-[var(--foreground)]"
            checked={automatic}
            onChange={(event) => setAutomatic(event.target.checked)}
          />
          <span>
            <span className="text-foreground">Look for a new version when {APP_NAME} starts</span>
            <br />
            It asks GitHub which release is the latest and sends nothing else. Nothing is downloaded or installed
            unless you choose to.
          </span>
        </label>
      </DialogContent>
    </Dialog>
  )
}
