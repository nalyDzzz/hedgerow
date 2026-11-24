import { useState } from 'react'
import { Check, CodeXml, Copy } from 'lucide-react'
import { Popover } from 'radix-ui'
import { Button } from '@/components/ui/button'
import { CodeView } from '@/editor/CodeView'

/**
 * Shows the statement that returned the rows on screen. The editor may have
 * been changed since it ran, and a filter may or may not be part of it, so
 * this is where to look for what the database was really asked.
 */
export function StatementButton({ sql, note }: { sql: string; note?: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button variant="ghost" size="sm" className="shrink-0" title="See the statement that returned these rows">
          <CodeXml />
          SQL
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="no-drag z-50 w-[560px] max-w-[calc(100vw-32px)] rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-popover outline-none"
        >
          <p className="text-[12.5px] font-medium">The statement that returned these rows</p>
          {note && <p className="mt-0.5 text-[12px] text-muted-foreground">{note}</p>}
          <div className="mt-2 max-h-[220px] min-h-[42px] overflow-auto rounded-md border border-border">
            <CodeView language="sql" value={sql} />
          </div>
          <div className="mt-2 flex justify-end">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void navigator.clipboard.writeText(sql)
                setCopied(true)
                setTimeout(() => setCopied(false), 1200)
              }}
            >
              {copied ? <Check /> : <Copy />}
              Copy SQL
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
