import type { ComponentProps } from 'react'
import { ContextMenu as ContextMenuPrimitive, DropdownMenu as DropdownMenuPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

const content =
  'no-drag z-50 min-w-[168px] max-h-[min(420px,var(--radix-popper-available-height,420px))] overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-popover outline-none'

const item =
  'flex h-7 items-center gap-2 rounded-sm px-2 text-[12.5px] outline-none data-[highlighted]:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-45 [&_svg]:size-3.5 [&_svg]:text-muted-foreground'

const danger = 'text-destructive [&_svg]:text-destructive'

const separator = '-mx-1 my-1 h-px bg-border'

export const DropdownMenu = DropdownMenuPrimitive.Root
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger

export function DropdownMenuContent({
  className,
  sideOffset = 4,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content sideOffset={sideOffset} className={cn(content, className)} {...props} />
    </DropdownMenuPrimitive.Portal>
  )
}

export function DropdownMenuItem({
  className,
  destructive,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Item> & { destructive?: boolean }) {
  return <DropdownMenuPrimitive.Item className={cn(item, destructive && danger, className)} {...props} />
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      className={cn('px-2 pb-1 pt-1.5 text-[11px] font-medium text-faint', className)}
      {...props}
    />
  )
}

export function DropdownMenuSeparator(props: ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return <DropdownMenuPrimitive.Separator className={separator} {...props} />
}

export const ContextMenu = ContextMenuPrimitive.Root
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger

export function ContextMenuContent({ className, ...props }: ComponentProps<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content className={cn(content, className)} {...props} />
    </ContextMenuPrimitive.Portal>
  )
}

export function ContextMenuItem({
  className,
  destructive,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.Item> & { destructive?: boolean }) {
  return <ContextMenuPrimitive.Item className={cn(item, destructive && danger, className)} {...props} />
}

export function ContextMenuSeparator(props: ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return <ContextMenuPrimitive.Separator className={separator} {...props} />
}
