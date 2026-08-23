// Vendors the SDF glyph ranges the map's text layers need into public/fonts/.
//
//   npm run build:glyphs
//
// MapLibre draws canvas text from pre-baked signed-distance-field glyph PBFs; it cannot use
// the skin's CSS font. Outputs are COMMITTED so the running app makes no external font call —
// labels can't vanish because someone else's CDN went down or changed CORS.
//
// WHY NOTO SANS and not DM Sans (the skin's --font-sans): building PBFs from an arbitrary TTF
// needs `fontnik`, a native module that does not build on current Node/Windows, and Google
// only publishes DM Sans as a variable font (no static weights to instance without more
// tooling). Noto Sans is a neutral grotesque that sits happily beside DM Sans at 10-12px.
// If you ever get fontnik building, swap this for a real DM Sans bake and update
// FONT_REGULAR / FONT_BOLD in src/map/basemapStyle.js — nothing else cares.
//
// Ranges: 0-255 is Latin-1 (covers accented port names like Málaga), 256-511 is Latin
// Extended-A. Add more here if a curated place name needs them; a missing range means that
// label silently renders blank.

import { mkdir, writeFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'public', 'fonts')

// OpenFreeMap serves these as application/x-protobuf, uncompressed. (Carto's font host has the
// same stacks but returns them gzipped, which Vite's static handler would pass through without
// a Content-Encoding header — MapLibre then chokes on the bytes. fonts.openmaptiles.org 200s
// with an HTML page. Both are why this validates the payload below rather than trusting a 200.)
const ENDPOINT = 'https://tiles.openfreemap.org/fonts'
const STACKS = ['Noto Sans Regular', 'Noto Sans Bold']
const RANGES = ['0-255', '256-511']

for (const stack of STACKS) {
  await mkdir(join(OUT, stack), { recursive: true })
  for (const range of RANGES) {
    const url = `${ENDPOINT}/${encodeURIComponent(stack)}/${range}.pbf`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
    const buf = Buffer.from(await res.arrayBuffer())
    // A real range is tens of KB of protobuf. Anything tiny or starting with '<' is an error
    // page served with a 200 — writing it would produce a map with silently blank labels.
    if (buf.length < 1024 || buf[0] === 0x3c) {
      throw new Error(`not a glyph pbf (${buf.length} bytes) for ${url}`)
    }
    const path = join(OUT, stack, `${range}.pbf`)
    await writeFile(path, buf)
    const { size } = await stat(path)
    console.log(`  wrote   public/fonts/${stack}/${range}.pbf  (${(size / 1024).toFixed(0)} KB)`)
  }
}
