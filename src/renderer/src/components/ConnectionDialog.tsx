import { useState, type FormEvent } from 'react'
import { Check, CircleAlert, CircleCheck, LoaderCircle } from 'lucide-react'
import type { ConnectionInput, SavedConnection, TestResult } from '@shared/api'
import { DRIVER_INFO, type DriverId, type TlsMode } from '@shared/driver'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input, Label, Select } from '@/components/ui/input'
import { HUES, nextFreeHue, tintStyle } from '@/lib/hues'
import { cn } from '@/lib/utils'
import { useStore } from '@/store'

const TLS_OPTIONS: { value: TlsMode; label: string }[] = [
  { value: 'disabled', label: 'Off' },
  { value: 'required', label: 'Encrypt' },
  { value: 'verify', label: 'Encrypt and verify the server certificate' },
]

type TestState = { status: 'idle' } | { status: 'testing' } | { status: 'done'; result: TestResult }

function ConnectionForm({ editing, onDone }: { editing?: SavedConnection; onDone(): void }) {
  const connections = useStore((state) => state.connections)
  const { saveConnection, newTab } = useStore.getState()

  const [name, setName] = useState(editing?.name ?? '')
  const [driver, setDriver] = useState<DriverId>(editing?.driver ?? 'mysql')
  const [host, setHost] = useState(editing?.host ?? '127.0.0.1')
  const [port, setPort] = useState(String(editing?.port ?? DRIVER_INFO.mysql.defaultPort))
  const [user, setUser] = useState(editing?.user ?? 'root')
  // null means "leave the stored password as it is".
  const [password, setPassword] = useState<string | null>(editing ? null : '')
  const [database, setDatabase] = useState(editing?.database ?? '')
  const [tls, setTls] = useState<TlsMode>(editing?.tls ?? 'disabled')
  const [hue, setHue] = useState(editing?.hue ?? nextFreeHue(connections.map((c) => c.hue)))
  const [test, setTest] = useState<TestState>({ status: 'idle' })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const portNumber = Number(port)
  const valid = host.trim() !== '' && Number.isInteger(portNumber) && portNumber > 0 && portNumber < 65536

  const input = (): ConnectionInput => ({
    id: editing?.id,
    name: name.trim() || host.trim(),
    driver,
    host: host.trim(),
    port: portNumber,
    user: user.trim(),
    password: password ?? undefined,
    database: database.trim(),
    tls,
    hue,
  })

  const runTest = async () => {
    setTest({ status: 'testing' })
    try {
      setTest({ status: 'done', result: await window.api.connections.test(input()) })
    } catch (error) {
      setTest({ status: 'done', result: { ok: false, message: (error as Error).message } })
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!valid || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      const saved = await saveConnection(input())
      if (!editing) newTab(saved.id)
      onDone()
    } catch (error) {
      setSaveError((error as Error).message)
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} data-tint style={tintStyle(hue)}>
      <div className="relative border-b border-border px-5 pb-4 pt-5">
        <span className="absolute inset-x-0 top-0 h-0.5 rounded-t-lg bg-tint" />
        <DialogTitle>{editing ? 'Edit connection' : 'New connection'}</DialogTitle>
        <DialogDescription className="mt-1">
          Saved on this computer. The password is encrypted with your system keychain.
        </DialogDescription>
      </div>

      <div className="grid grid-cols-6 gap-x-3 gap-y-3.5 px-5 py-4">
        <div className="col-span-4">
          <Label htmlFor="conn-name">Name</Label>
          <Input
            id="conn-name"
            autoFocus
            value={name}
            placeholder={host.trim() || 'Local MySQL'}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="col-span-2">
          <Label htmlFor="conn-driver">Type</Label>
          <Select id="conn-driver" value={driver} onChange={(event) => setDriver(event.target.value as DriverId)}>
            {Object.entries(DRIVER_INFO).map(([id, info]) => (
              <option key={id} value={id}>
                {info.label}
              </option>
            ))}
          </Select>
        </div>

        <div className="col-span-4">
          <Label htmlFor="conn-host">Host</Label>
          <Input id="conn-host" value={host} onChange={(event) => setHost(event.target.value)} />
        </div>
        <div className="col-span-2">
          <Label htmlFor="conn-port">Port</Label>
          <Input id="conn-port" inputMode="numeric" value={port} onChange={(event) => setPort(event.target.value)} />
        </div>

        <div className="col-span-3">
          <Label htmlFor="conn-user">User</Label>
          <Input id="conn-user" value={user} onChange={(event) => setUser(event.target.value)} />
        </div>
        <div className="col-span-3">
          <Label htmlFor="conn-password">Password</Label>
          <Input
            id="conn-password"
            type="password"
            value={password ?? ''}
            placeholder={editing?.hasPassword && password === null ? 'Saved. Type to replace it.' : ''}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        <div className="col-span-3">
          <Label htmlFor="conn-database">Default database</Label>
          <Input
            id="conn-database"
            value={database}
            placeholder="Optional"
            onChange={(event) => setDatabase(event.target.value)}
          />
        </div>
        <div className="col-span-3">
          <Label htmlFor="conn-tls">Encryption (TLS)</Label>
          <Select id="conn-tls" value={tls} onChange={(event) => setTls(event.target.value as TlsMode)}>
            {TLS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>

        <div className="col-span-6">
          <Label id="conn-color-label">Color</Label>
          <div className="flex items-center gap-2" role="radiogroup" aria-labelledby="conn-color-label">
            {HUES.map((option) => (
              <button
                key={option.hue}
                type="button"
                role="radio"
                aria-checked={hue === option.hue}
                aria-label={option.name}
                title={option.name}
                data-tint
                style={tintStyle(option.hue)}
                onClick={() => setHue(option.hue)}
                className={cn(
                  'flex size-6 items-center justify-center rounded-full bg-tint text-tint-foreground',
                  hue === option.hue && 'ring-2 ring-tint ring-offset-2 ring-offset-popover',
                )}
              >
                {hue === option.hue && <Check className="size-3.5" strokeWidth={3} />}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[12px] leading-snug text-muted-foreground">
            The window takes this color while you work in this connection, so production never looks like local.
          </p>
        </div>
      </div>

      {(test.status !== 'idle' || saveError) && (
        <div className="selectable border-t border-border px-5 py-2.5 text-[12.5px]" role="status">
          {saveError ? (
            <p className="flex items-start gap-1.5 text-destructive">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
              {saveError}
            </p>
          ) : test.status === 'testing' ? (
            <p className="flex items-center gap-1.5 text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" />
              Connecting…
            </p>
          ) : test.status === 'done' && test.result.ok ? (
            <p className="flex items-center gap-1.5">
              <CircleCheck className="size-3.5 shrink-0 text-tint" />
              Connected. Server version {test.result.serverVersion}.
            </p>
          ) : test.status === 'done' && !test.result.ok ? (
            <p className="flex items-start gap-1.5 text-destructive">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
              {test.result.message}
            </p>
          ) : null}
        </div>
      )}

      <div className="flex items-center gap-2 border-t border-border px-5 py-3">
        <Button size="lg" variant="outline" disabled={!valid || test.status === 'testing'} onClick={() => void runTest()}>
          Test connection
        </Button>
        <div className="flex-1" />
        <Button size="lg" onClick={onDone}>
          Cancel
        </Button>
        <Button size="lg" variant="primary" type="submit" disabled={!valid || saving}>
          {editing ? 'Save changes' : 'Save and connect'}
        </Button>
      </div>
    </form>
  )
}

export function ConnectionDialog() {
  const dialog = useStore((state) => state.dialog)
  const { setDialog } = useStore.getState()
  const close = () => setDialog({ mode: 'closed' })

  return (
    <Dialog open={dialog.mode !== 'closed'} onOpenChange={(open) => !open && close()}>
      <DialogContent aria-describedby={undefined}>
        {dialog.mode !== 'closed' && (
          <ConnectionForm editing={dialog.mode === 'edit' ? dialog.connection : undefined} onDone={close} />
        )}
      </DialogContent>
    </Dialog>
  )
}
