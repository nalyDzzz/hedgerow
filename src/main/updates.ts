/**
 * Finding out whether a newer release exists.
 *
 * It asks GitHub for the project's latest release and compares that version
 * with the one running. The request says nothing about the person or their
 * databases, and the answer can only ever point at this project's own
 * releases: any other address in it is dropped.
 *
 * Nothing here imports Electron, so it can be tested with a made-up answer.
 */
import type { AvailableUpdate, UpdateCheck } from '@shared/api'

const REPOSITORY = 'nalyDzzz/hedgerow'
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`
const RELEASES_URL = `https://github.com/${REPOSITORY}/releases/`

/** The parts of an HTTP answer this needs. */
interface Answer {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

export interface CheckContext {
  fetch(url: string, init: { headers: Record<string, string>; signal: AbortSignal }): Promise<Answer>
  /** The version that is running. */
  current: string
  /** `process.platform` and the processor of the machine, which decide which installer to offer. */
  platform: string
  arch: string
}

/** A version as its three numbers, or null if it is not written that way. A leading "v" is fine. */
function parseVersion(text: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

/**
 * True when `candidate` is a later version than `current`. A version that cannot
 * be read, such as a pre-release, is never offered as newer.
 */
export function isNewer(candidate: string, current: string): boolean {
  const next = parseVersion(candidate)
  const now = parseVersion(current)
  if (!next || !now) return false
  for (let part = 0; part < 3; part++) {
    if (next[part] !== now[part]) return next[part] > now[part]
  }
  return false
}

/**
 * How the installer for a system ends its file name. This mirrors
 * `artifactName` in electron-builder.yml and the targets built there.
 */
export function installerSuffix(platform: string, arch: string): string | null {
  // The Windows build is 64-bit Intel, which Windows on ARM runs as well.
  if (platform === 'win32') return '-win-x64.exe'
  if (platform === 'darwin') return arch === 'arm64' ? '-mac-arm64.dmg' : '-mac-x64.dmg'
  if (platform === 'linux' && arch === 'x64') return '-linux-x86_64.AppImage'
  return null
}

/**
 * What a release says before its first heading, as plain text: the line or two
 * that tell what the release is. Empty when the notes open with a heading.
 */
export function summarize(notes: string): string {
  const opening = notes.replaceAll('\r\n', '\n').split(/^#/m)[0]
  const plain = opening
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > 400 ? `${plain.slice(0, 399).trimEnd()}…` : plain
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function describe(release: Record<string, unknown>, version: string, context: CheckContext): AvailableUpdate {
  const page = text(release.html_url)
  const suffix = installerSuffix(context.platform, context.arch)
  const assets = Array.isArray(release.assets) ? (release.assets as Record<string, unknown>[]) : []
  const installer = assets.find((asset) => {
    const name = text(asset?.name)
    return (
      suffix !== null && name.endsWith(suffix) && text(asset?.browser_download_url).startsWith(`${RELEASES_URL}download/`)
    )
  })

  return {
    version,
    summary: summarize(text(release.body)),
    publishedAt: text(release.published_at) || null,
    releaseUrl: page.startsWith(RELEASES_URL) ? page : `${RELEASES_URL}latest`,
    download: installer ? { name: text(installer.name), url: text(installer.browser_download_url) } : null,
  }
}

/** Never rejects: a check that could not be made is an answer too. */
export async function checkForUpdate(context: CheckContext): Promise<UpdateCheck> {
  const { current } = context
  try {
    const answer = await context.fetch(LATEST_RELEASE_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Hedgerow' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!answer.ok) {
      const busy = answer.status === 403 || answer.status === 429
      return {
        status: 'failed',
        current,
        message: busy
          ? 'GitHub is not taking more requests from this network for now. Try again in a while.'
          : `GitHub answered with an error (${answer.status}).`,
      }
    }
    const release = (await answer.json()) as Record<string, unknown> | null
    const version = text(release?.tag_name).replace(/^v/, '')
    if (!release || !isNewer(version, current)) return { status: 'current', current }
    return { status: 'available', current, update: describe(release, version, context) }
  } catch {
    return { status: 'failed', current, message: 'GitHub could not be reached. Check your connection and try again.' }
  }
}
