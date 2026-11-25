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

/**
 * True while a dialog is open. What lies behind one is out of reach, and that
 * has to hold for the keyboard as it does for the mouse: a shortcut that
 * changed the tab under an open dialog would leave the dialog asking about
 * something that is no longer on screen.
 */
export function modalOpen(): boolean {
  return document.querySelector('[role="dialog"], [role="alertdialog"]') !== null
}
