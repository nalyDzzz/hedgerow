import type { BinaryCell, CellValue } from '@shared/driver'

const counts = new Intl.NumberFormat('en-US')

export function formatCount(value: number): string {
  return counts.format(value)
}

export function plural(count: number, noun: string): string {
  return `${formatCount(count)} ${noun}${count === 1 ? '' : 's'}`
}

export function formatDuration(ms: number): string {
  if (ms < 1) return '<1 ms'
  if (ms < 1000) return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function isBinary(value: CellValue): value is BinaryCell {
  return typeof value === 'object' && value !== null
}

/** The value as plain text, for copying. */
export function cellText(value: CellValue): string {
  if (value === null) return 'NULL'
  if (isBinary(value)) return `0x${value.preview}`
  return String(value)
}

/** True for text that is a JSON object or array. Scalars are left alone on purpose. */
export function looksLikeJson(text: string): boolean {
  const first = text.trimStart()[0]
  if (first !== '{' && first !== '[') return false
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/**
 * Re-indents JSON text without parsing its values, so large integers and
 * decimals stay exactly as the database stored them.
 */
export function formatJson(text: string, indent = 2): string {
  let out = ''
  let depth = 0
  let inString = false
  const pad = () => `\n${' '.repeat(depth * indent)}`

  for (let i = 0; i < text.length; i++) {
    const char = text[i]

    if (inString) {
      out += char
      if (char === '\\') out += text[++i] ?? ''
      else if (char === '"') inString = false
      continue
    }

    switch (char) {
      case '"':
        inString = true
        out += char
        break
      case '{':
      case '[': {
        // Keep empty containers on one line.
        let next = i + 1
        while (next < text.length && /\s/.test(text[next])) next++
        if (text[next] === '}' || text[next] === ']') {
          out += char + text[next]
          i = next
        } else {
          depth++
          out += char + pad()
        }
        break
      }
      case '}':
      case ']':
        depth = Math.max(0, depth - 1)
        out += pad() + char
        break
      case ',':
        out += char + pad()
        break
      case ':':
        out += ': '
        break
      default:
        if (!/\s/.test(char)) out += char
    }
  }
  return out
}
