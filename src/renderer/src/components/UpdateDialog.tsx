import { useState } from 'react'
import { ArrowDownToLine, CircleAlert, CircleCheck, LoaderCircle, RotateCw } from 'lucide-react'
import type { AvailableUpdate, UpdateDownload } from '@shared/api'
import { APP_NAME } from '@shared/app'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { formatBytes, plural } from '@/lib/format'
import { countChanges, useStore, type Tab } from '@/store'
import { useUpdateDownload, useUpdates } from '@/updates'

const dates = new Intl.DateTimeFormat('en-US', { dateStyle: 'long' })

function released(date: string | null): string {
  const time = date ? Date.parse(date) : Number.NaN
  return Number.isNaN(time) ? '' : `Released on ${dates.format(time)}. `
}

/**
 * What closing the app throws away, as sentences: the tabs, which are not kept,
 * and anything in them that matters more. Empty when no tab is open.
 */
export function whatRestartingCloses(tabs: Tab[]): string[] {
  if (tabs.length === 0) return []
  const changes = tabs.reduce(
    (sum, tab) => sum + tab.results.reduce((count, entry) => count + countChanges(entry.staged), 0),
    0,
  )
  const transactions = tabs.filter((tab) => tab.transaction).length
  const running = tabs.filter((tab) => tab.running).length
  const lines = [
    tabs.length === 1
      ? 'Restarting closes the open tab, and the SQL in it is not kept.'
      : `Restarting closes the ${tabs.length} open tabs, and the SQL in them is not kept.`,
  ]
  if (changes > 0) {
    lines.push(`${plural(changes, 'change')} in the results ${changes === 1 ? 'is' : 'are'} not saved and would be lost.`)
  }
  if (transactions > 0) {
    lines.push(
      transactions === 1
        ? 'A transaction is open, and what it changed would be rolled back.'
        : `${transactions} transactions are open, and what they changed would be rolled back.`,
    )
  }
  if (running > 0) {
    lines.push(
      running === 1
        ? 'A statement is still running and would be stopped.'
        : `${running} statements are still running and would be stopped.`,
    )
  }
  return lines
}

function DownloadProgress({ received, total }: { received: number; total: number }) {
  const share = total > 0 ? Math.min(1, received / total) : 0
  return (
    <div className="mt-3">
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label="Downloading the update"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(share * 100)}
      >
        <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${share * 100}%` }} />
      </div>
      <p className="mt-1.5 text-[12px] tabular-nums text-muted-foreground">
        Downloading… {formatBytes(received)} of {formatBytes(total)}
      </p>
    </div>
  )
}

/** What the dialog says about getting the new version, and the buttons for it. */
function GetTheUpdate({ available, download }: { available: AvailableUpdate; download: UpdateDownload }) {
  const skipped = useUpdates((state) => state.skipped)
  const tabs = useStore((state) => state.tabs)
  const { skip, setDialogOpen, startDownload, cancelDownload, restart } = useUpdates.getState()
  const [restarting, setRestarting] = useState(false)
  const installer = available.download
  const whatIsNew = (
    <Button size="lg" data-primary={installer ? undefined : ''} onClick={() => window.open(available.releaseUrl)}>
      What is new
    </Button>
  )
  const skipButton = (
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
  )

  if (!installer || !available.installable) {
    return (
      <>
        <p className="mt-2.5 text-[12px] leading-snug text-muted-foreground">
          {installer
            ? `Download fetches ${installer.name} with your browser. Run it to replace this version. ` +
              'Your saved connections are kept.'
            : 'There is no ready-made download for this system. The release page has the others, and the source.'}
        </p>
        <div className="mt-4 flex items-center gap-2">
          {skipButton}
          <div className="flex-1" />
          {whatIsNew}
          {installer && (
            <Button size="lg" variant="primary" data-primary onClick={() => window.open(installer.url)}>
              <ArrowDownToLine />
              Download
            </Button>
          )}
        </div>
      </>
    )
  }

  if (download.state === 'downloading') {
    return (
      <>
        <DownloadProgress received={download.received} total={download.total} />
        <div className="mt-4 flex items-center gap-2">
          <div className="flex-1" />
          <Button size="lg" data-primary onClick={cancelDownload}>
            Cancel
          </Button>
        </div>
      </>
    )
  }

  if (download.state === 'ready') {
    const closes = whatRestartingCloses(tabs)
    // The Windows installer takes a while, with nothing on screen. An AppImage is swapped in a moment.
    const takes = window.api.platform === 'win32' ? ', which takes about half a minute' : ''
    return (
      <>
        <p className="mt-2.5 text-[12px] leading-snug text-muted-foreground">
          Downloaded and checked. Restart now and {APP_NAME} closes, installs it and opens again{takes}. Or carry on,
          and it is installed when you close {APP_NAME}. Your saved connections are kept.
        </p>
        {closes.length > 0 && <p className="mt-2 text-[12px] leading-snug text-foreground">{closes.join(' ')}</p>}
        <div className="mt-4 flex items-center gap-2">
          <div className="flex-1" />
          <DialogClose asChild>
            <Button size="lg" disabled={restarting}>
              Later
            </Button>
          </DialogClose>
          <Button
            size="lg"
            variant="primary"
            data-primary
            disabled={restarting}
            onClick={() => {
              setRestarting(true)
              // When it works the app is closing. Otherwise the dialog shows why it did not.
              void restart().then(() => setRestarting(useUpdates.getState().download.state === 'ready'))
            }}
          >
            {restarting ? <LoaderCircle className="animate-spin" /> : <RotateCw />}
            {restarting ? 'Restarting…' : 'Restart now'}
          </Button>
        </div>
      </>
    )
  }

  return (
    <>
      {download.state === 'failed' ? (
        <p className="selectable mt-2.5 flex items-start gap-1.5 text-[12px] text-destructive" role="alert">
          <CircleAlert className="mt-px size-3.5 shrink-0" />
          {download.message}
        </p>
      ) : (
        <p className="mt-2.5 text-[12px] leading-snug text-muted-foreground">
          {APP_NAME} downloads the update ({formatBytes(installer.size)}), checks it against the checksum published with
          the release, and installs it when it restarts. Your saved connections are kept.
        </p>
      )}
      <div className="mt-4 flex items-center gap-2">
        {download.state === 'failed' ? (
          <Button
            size="lg"
            variant="ghost"
            className="-ml-2"
            title={`Fetch ${installer.name} with your browser and run it yourself.`}
            onClick={() => window.open(installer.url)}
          >
            Use the browser
          </Button>
        ) : (
          skipButton
        )}
        <div className="flex-1" />
        {whatIsNew}
        <Button size="lg" variant="primary" data-primary onClick={() => void startDownload()}>
          <ArrowDownToLine />
          {download.state === 'failed' ? 'Try again' : 'Download and install'}
        </Button>
      </div>
    </>
  )
}

/**
 * Which version is running, whether a newer one exists, and the one setting
 * there is about that. An update is offered here, never installed unasked.
 */
export function UpdateDialog() {
  const { version, automatic, checking, checked, available, problem, dialogOpen } = useUpdates()
  const download = useUpdateDownload()
  const { check, setAutomatic, setDialogOpen } = useUpdates.getState()
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
              {APP_NAME} {available.version} {download.state === 'ready' ? 'is ready to install' : 'is available'}
            </DialogTitle>
            <DialogDescription className="mt-1.5">
              {released(available.publishedAt)}You are running {running}.
            </DialogDescription>
            {available.summary && (
              <p className="selectable mt-2.5 text-[12.5px] leading-relaxed text-foreground">{available.summary}</p>
            )}
            <GetTheUpdate available={available} download={download} />
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
