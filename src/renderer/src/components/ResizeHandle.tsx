import type { PointerEvent as ReactPointerEvent } from 'react'
import { cn } from '@/lib/utils'

interface ResizeHandleProps {
  /** `x` resizes a width, `y` a height. */
  axis: 'x' | 'y'
  value: number
  min: number
  max: number
  /** Set when dragging toward the origin should grow the value (a panel docked right or bottom). */
  reverse?: boolean
  onChange(value: number): void
  className?: string
}

/** A thin divider you drag to resize the panel beside it. */
export function ResizeHandle({ axis, value, min, max, reverse, onChange, className }: ResizeHandleProps) {
  const start = (event: ReactPointerEvent) => {
    event.preventDefault()
    const origin = axis === 'x' ? event.clientX : event.clientY
    const initial = value

    const move = (moveEvent: PointerEvent) => {
      const delta = (axis === 'x' ? moveEvent.clientX : moveEvent.clientY) - origin
      onChange(Math.min(Math.max(initial + (reverse ? -delta : delta), min), max))
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      document.body.style.cursor = ''
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize'
  }

  return (
    <div
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      onPointerDown={start}
      className={cn(
        'relative z-10 shrink-0 bg-border transition-colors hover:bg-tint/60 active:bg-tint',
        axis === 'x'
          ? 'w-px cursor-col-resize after:absolute after:inset-y-0 after:-left-1 after:w-2'
          : 'h-px cursor-row-resize after:absolute after:inset-x-0 after:-top-1 after:h-2',
        className,
      )}
    />
  )
}
