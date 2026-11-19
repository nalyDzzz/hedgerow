/**
 * Regenerates the icon files in build/ from the SVG artwork. Run with `pnpm icons`.
 *
 *   icon.ico      Windows. The simplified drawing up to 24 px, the master above that.
 *   icon.png      Linux, and the window icon on Windows and Linux.
 *   icon-mac.png  macOS, with the margin Apple's icon grid expects.
 *
 * Electron does the rasterising, so no image library is needed.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const BUILD = path.join(__dirname, '..', 'build')

/** Runs inside the hidden page: draws one SVG and returns PNG bytes (base64) or raw RGBA. */
async function rasterise({ svg, size, inset, format }) {
  const image = new Image()
  image.src = `data:image/svg+xml;base64,${svg}`
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const context = canvas.getContext('2d')
  context.drawImage(image, inset, inset, size - inset * 2, size - inset * 2)
  if (format === 'png') return canvas.toDataURL('image/png').split(',')[1]
  return Array.from(context.getImageData(0, 0, size, size).data)
}

/** One uncompressed 32-bit image for an .ico file: rows bottom-up in BGRA, then an empty mask. */
function bitmapEntry(size, rgba) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8) // the height field counts the mask rows as well
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(size * size * 4, 20)

  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const from = ((size - 1 - y) * size + x) * 4
      const to = (y * size + x) * 4
      pixels[to] = rgba[from + 2]
      pixels[to + 1] = rgba[from + 1]
      pixels[to + 2] = rgba[from]
      pixels[to + 3] = rgba[from + 3]
    }
  }
  // Transparency comes from the alpha channel, so the 1-bit mask stays all zero.
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size)
  return Buffer.concat([header, pixels, mask])
}

function icoFile(entries) {
  const directory = Buffer.alloc(6 + 16 * entries.length)
  directory.writeUInt16LE(1, 2)
  directory.writeUInt16LE(entries.length, 4)
  let offset = directory.length
  entries.forEach(({ size, data }, index) => {
    const at = 6 + 16 * index
    directory.writeUInt8(size === 256 ? 0 : size, at) // 0 means 256
    directory.writeUInt8(size === 256 ? 0 : size, at + 1)
    directory.writeUInt16LE(1, at + 4)
    directory.writeUInt16LE(32, at + 6)
    directory.writeUInt32LE(data.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += data.length
  })
  return Buffer.concat([directory, ...entries.map((entry) => entry.data)])
}

async function main() {
  const window = new BrowserWindow({ show: false })
  await window.loadURL('about:blank')

  const render = (file, size, format, inset = 0) =>
    window.webContents.executeJavaScript(
      `(${rasterise})(${JSON.stringify({
        svg: fs.readFileSync(path.join(BUILD, file)).toString('base64'),
        size,
        inset,
        format,
      })})`,
    )
  const png = async (file, size, inset) => Buffer.from(await render(file, size, 'png', inset), 'base64')
  const write = (name, data) => {
    fs.writeFileSync(path.join(BUILD, name), data)
    console.log(`${name}  ${(data.length / 1024).toFixed(1)} KB`)
  }

  const entries = []
  for (const size of [16, 20, 24, 32, 40, 48, 64, 128]) {
    const drawing = size <= 24 ? 'icon-small.svg' : 'icon.svg'
    entries.push({ size, data: bitmapEntry(size, await render(drawing, size, 'rgba')) })
  }
  // Windows expects the 256 px image PNG-compressed.
  entries.push({ size: 256, data: await png('icon.svg', 256) })
  write('icon.ico', icoFile(entries))

  write('icon.png', await png('icon.svg', 1024))
  // Apple's grid puts an 824 px shape in the middle of a 1024 px canvas.
  write('icon-mac.png', await png('icon.svg', 1024, 100))
}

app
  .whenReady()
  .then(main)
  .then(
    () => app.quit(),
    (error) => {
      console.error(error)
      app.exit(1)
    },
  )
