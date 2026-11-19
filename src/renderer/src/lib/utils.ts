import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

export const isMac = window.api.platform === 'darwin'

/** "Ctrl" or the Mac command symbol, for shortcut hints. */
export const MOD = isMac ? '⌘' : 'Ctrl'

export function shortcut(...keys: string[]): string {
  return keys.join(isMac ? '' : '+')
}
