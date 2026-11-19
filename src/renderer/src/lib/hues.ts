import type { CSSProperties } from 'react'

/** The colors a connection can take. Lightness and chroma come from the theme. */
export const HUES = [
  { hue: 25, name: 'Red' },
  { hue: 55, name: 'Orange' },
  { hue: 95, name: 'Yellow' },
  { hue: 150, name: 'Green' },
  { hue: 195, name: 'Teal' },
  { hue: 250, name: 'Blue' },
  { hue: 295, name: 'Violet' },
  { hue: 350, name: 'Pink' },
] as const

export const DEFAULT_HUE = 250

/** Inline style that gives an element (and its children) a connection's color. */
export function tintStyle(hue: number): CSSProperties {
  return { '--conn-h': hue, '--conn-c': 'var(--tint-chroma)' } as CSSProperties
}

/** First hue no existing connection uses, so new connections look different by default. */
export function nextFreeHue(used: number[]): number {
  const order = [250, 150, 55, 295, 195, 350, 95, 25]
  return order.find((hue) => !used.includes(hue)) ?? DEFAULT_HUE
}
