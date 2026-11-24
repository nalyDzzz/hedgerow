/** The update check, against made-up answers from GitHub. Nothing here touches the network. */
import { describe, expect, it } from 'vitest'
import {
  checkForUpdate,
  installerSuffix,
  isNewer,
  LATEST_RELEASE_URL,
  REQUEST_HEADERS,
  summarize,
  type CheckContext,
} from './updates'

const DOWNLOADS = 'https://github.com/nalyDzzz/hedgerow/releases/download/v0.3.0'

/** A release as GitHub describes one, cut down to what matters here. */
function release(over: Record<string, unknown> = {}) {
  return {
    tag_name: 'v0.3.0',
    html_url: 'https://github.com/nalyDzzz/hedgerow/releases/tag/v0.3.0',
    published_at: '2026-12-01T10:00:00Z',
    body: 'Hedgerow 0.3.0 filters and sorts results.\n\n## What is new\n\n- Filters',
    assets: ['win-x64.exe', 'mac-arm64.dmg', 'mac-x64.dmg', 'linux-x86_64.AppImage']
      .map((ending) => `Hedgerow-0.3.0-${ending}`)
      .concat('SHA256SUMS.txt')
      .map((name) => ({ name, browser_download_url: `${DOWNLOADS}/${name}` })),
    ...over,
  }
}

function answering(body: unknown, status = 200, over: Partial<CheckContext> = {}): CheckContext {
  return {
    fetch: async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }),
    current: '0.2.0',
    platform: 'win32',
    arch: 'x64',
    ...over,
  }
}

describe('comparing versions', () => {
  it('compares number by number, not as text', () => {
    expect(isNewer('0.3.0', '0.2.0')).toBe(true)
    expect(isNewer('0.10.0', '0.9.9')).toBe(true)
    expect(isNewer('1.0.0', '0.99.99')).toBe(true)
    expect(isNewer('v0.2.1', '0.2.0')).toBe(true)
  })

  it('does not offer the same or an older version', () => {
    expect(isNewer('0.2.0', '0.2.0')).toBe(false)
    expect(isNewer('0.1.9', '0.2.0')).toBe(false)
  })

  it('does not offer what it cannot read', () => {
    expect(isNewer('0.3.0-beta.1', '0.2.0')).toBe(false)
    expect(isNewer('nightly', '0.2.0')).toBe(false)
    expect(isNewer('0.3.0', 'unknown')).toBe(false)
  })
})

describe('choosing the installer', () => {
  it('matches the names the build gives its installers', () => {
    expect(installerSuffix('win32', 'x64')).toBe('-win-x64.exe')
    expect(installerSuffix('win32', 'arm64')).toBe('-win-x64.exe')
    expect(installerSuffix('darwin', 'arm64')).toBe('-mac-arm64.dmg')
    expect(installerSuffix('darwin', 'x64')).toBe('-mac-x64.dmg')
    expect(installerSuffix('linux', 'x64')).toBe('-linux-x86_64.AppImage')
  })

  it('offers none where there is no build', () => {
    expect(installerSuffix('linux', 'arm64')).toBeNull()
    expect(installerSuffix('freebsd', 'x64')).toBeNull()
  })
})

describe('summing up release notes', () => {
  it('keeps what comes before the first heading, as plain text', () => {
    const notes = 'Hedgerow **0.3.0** adds `filters`, see [the issue](https://example.com/12).\r\n\r\n## What is new\n\n- more'
    expect(summarize(notes)).toBe('Hedgerow 0.3.0 adds filters, see the issue.')
  })

  it('is empty when the notes open with a heading', () => {
    expect(summarize("## What's Changed\n* Something by @someone")).toBe('')
    expect(summarize('')).toBe('')
  })

  it('cuts a long opening short', () => {
    const summary = summarize('word '.repeat(200))
    expect(summary.length).toBeLessThanOrEqual(400)
    expect(summary.endsWith('…')).toBe(true)
  })
})

describe('checking for a new version', () => {
  it('asks GitHub for the latest release and says nothing else', async () => {
    const asked: { url: string; headers: Record<string, string> }[] = []
    const context = answering(release())
    await checkForUpdate({
      ...context,
      fetch: (url, init) => {
        asked.push({ url, headers: init.headers })
        return context.fetch(url, init)
      },
    })
    expect(asked).toEqual([{ url: LATEST_RELEASE_URL, headers: REQUEST_HEADERS }])
    expect(LATEST_RELEASE_URL).toBe('https://api.github.com/repos/nalyDzzz/hedgerow/releases/latest')
    // The app's name only: no version, no system, no language of the person's own.
    expect(REQUEST_HEADERS).toEqual({
      Accept: 'application/vnd.github+json',
      'Accept-Language': 'en',
      'User-Agent': 'Hedgerow',
    })
  })

  it('describes a newer release, with the installer for this system', async () => {
    expect(await checkForUpdate(answering(release()))).toEqual({
      status: 'available',
      current: '0.2.0',
      update: {
        version: '0.3.0',
        summary: 'Hedgerow 0.3.0 filters and sorts results.',
        publishedAt: '2026-12-01T10:00:00Z',
        releaseUrl: 'https://github.com/nalyDzzz/hedgerow/releases/tag/v0.3.0',
        download: { name: 'Hedgerow-0.3.0-win-x64.exe', url: `${DOWNLOADS}/Hedgerow-0.3.0-win-x64.exe` },
      },
    })

    const mac = await checkForUpdate(answering(release(), 200, { platform: 'darwin', arch: 'arm64' }))
    expect(mac.status === 'available' && mac.update.download?.name).toBe('Hedgerow-0.3.0-mac-arm64.dmg')
  })

  it('says the app is current when the latest release is not newer', async () => {
    expect(await checkForUpdate(answering(release({ tag_name: 'v0.2.0' })))).toEqual({
      status: 'current',
      current: '0.2.0',
    })
    expect(await checkForUpdate(answering(release(), 200, { current: '1.0.0' }))).toMatchObject({ status: 'current' })
  })

  it('offers the release page alone when there is no installer for this system', async () => {
    const result = await checkForUpdate(answering(release(), 200, { platform: 'linux', arch: 'arm64' }))
    expect(result).toMatchObject({ status: 'available', update: { download: null } })
  })

  it('never passes on an address outside this project', async () => {
    const result = await checkForUpdate(
      answering(
        release({
          html_url: 'https://example.com/fake-release',
          assets: [{ name: 'Hedgerow-0.3.0-win-x64.exe', browser_download_url: 'https://example.com/evil.exe' }],
        }),
      ),
    )
    expect(result).toMatchObject({
      status: 'available',
      update: { releaseUrl: 'https://github.com/nalyDzzz/hedgerow/releases/latest', download: null },
    })
  })

  it('survives an answer that is not a release at all', async () => {
    expect(await checkForUpdate(answering(null))).toEqual({ status: 'current', current: '0.2.0' })
    expect(await checkForUpdate(answering({ message: 'Not Found' }))).toEqual({ status: 'current', current: '0.2.0' })
    expect(await checkForUpdate(answering(release({ assets: 'none', body: 7 })))).toMatchObject({
      status: 'available',
      update: { summary: '', download: null },
    })
  })

  it('reports a check that could not be made instead of failing', async () => {
    expect(await checkForUpdate(answering({}, 500))).toMatchObject({ status: 'failed', current: '0.2.0' })
    const limited = await checkForUpdate(answering({}, 403))
    expect(limited.status === 'failed' && limited.message).toMatch(/Try again in a while/)

    const offline = await checkForUpdate({
      ...answering(release()),
      fetch: async () => {
        throw new Error('net::ERR_INTERNET_DISCONNECTED')
      },
    })
    expect(offline.status === 'failed' && offline.message).toMatch(/could not be reached/)
  })
})
