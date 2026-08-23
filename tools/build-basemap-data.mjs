// Regenerates the vendored basemap geometry in public/data/.
//
//   npm run build:basemap
//
// Outputs are COMMITTED, so this only needs re-running when you change the country list or the
// resolution. `npm run dev` never touches the network for basemap data.
//
// Sources: Natural Earth via nvkelso/natural-earth-vector (public domain).
//   ne_10m_admin_0_countries_lakes         -> countries.geojson  (contours, one per country)
//   ne_10m_admin_1_states_provinces_lakes  -> us-states.geojson  (US inner state lines only)
//
// This builds ONLY the countries we care about. Water, land, coastline, roads and buildings all
// come from OpenMapTiles at runtime (see src/map/basemapStyle.js). What stays vendored is the one
// thing OSM can't express cleanly: an outline around a HAND-PICKED SET of countries. OSM's
// `boundary` layer is all-or-nothing — you cannot ask it for "just these four".
//
// Both source files are the `_lakes` variants, which already have the Great Lakes and similar
// inland water cut out of the landmass, so lakes read as water for free.

import { mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import mapshaper from 'mapshaper'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = join(ROOT, 'tools', '.cache')
const OUT = join(ROOT, 'public', 'data')

const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson'

// ── The countries that get a contour ─────────────────────────────────────────────────
//
// A list rather than a hardcoded USA because the cost is zero and it keeps the mainland-clipping
// logic honest. Every entry is MAINLAND ONLY, which takes one of two tools:
//
//   clip        a bounding box, when the offshore parts sit outside the mainland's box.
//   minIsland   drop detached landmasses under N km², when they DON'T — e.g. India's Andaman &
//               Nicobar Islands sit at 92-94°E, inside the same longitude band as the
//               northeastern states, so no bbox can separate them.
//
// `ADM0_A3` is Natural Earth's 3-letter code — note this file uses UPPERCASE field names,
// unlike the admin_1 file below, which uses lowercase.
// DELIBERATELY JUST THE US. Origin countries (Colombia, India, Vietnam) were tried and removed:
// outlining both ends of every lane cluttered the map and diluted the one thing the contour is
// for. Goods move INTO the US, so only the destination gets a border. Keep it that way unless
// there's a clear reason otherwise — the origin ports already read as labelled dots.
const COUNTRIES = [
  // Lower 48: the bbox drops Alaska, Hawaii, Puerto Rico and the Pacific territories. Its edges
  // clear the real extremes with room to spare (westmost -124.73, eastmost -66.95, south 24.5).
  { iso: 'USA', clip: '-125,24,-66.5,49.5' },
]

// "Keep this share of vertices" — HIGHER means more detail. Set by the zoom these layers survive
// to (they fade out around z10), not by taste: an earlier pass used 5% and the coast was visibly
// faceted by z6, with Long Island rendering as a triangle. `precision` is not the lever here;
// 0.0005 deg is ~55 m, well under a pixel at z10.
const SIMPLIFY = '30%'
const PRECISION = 0.0005

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function fetchCached(name) {
  const path = join(CACHE, name)
  if (await exists(path)) {
    console.log(`  cached  ${name}`)
    return path
  }
  const url = `${NE}/${name}`
  console.log(`  fetch   ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
  await writeFile(path, Buffer.from(await res.arrayBuffer()))
  return path
}

async function report(file) {
  const { size } = await stat(join(OUT, file))
  console.log(`  wrote   public/data/${file}  (${(size / 1024).toFixed(0)} KB)`)
}

await mkdir(CACHE, { recursive: true })
await mkdir(OUT, { recursive: true })

console.log('Natural Earth sources:')
const countriesSrc = await fetchCached('ne_10m_admin_0_countries_lakes.geojson')
const statesSrc = await fetchCached('ne_10m_admin_1_states_provinces_lakes.geojson')

console.log('\nBuilding:')

// `-filter-fields` with no arguments drops every attribute — Natural Earth carries ~40 name
// translations per feature that would otherwise be most of the payload. The `-each` then
// re-attaches just what the style needs, which also keeps mapshaper emitting a FeatureCollection;
// with zero attributes it writes a bare GeometryCollection, which geojson-vt handles far less
// predictably than plain features.

// One country at a time, because each needs its own mainland treatment; merged at the end so the
// style has a single source and one fill + one line layer covers all of them.
const features = []
for (const { iso, clip, minIsland } of COUNTRIES) {
  const tmp = join(CACHE, `tmp-${iso}.geojson`)
  const cmd = [
    `-i "${countriesSrc}"`,
    `-filter 'ADM0_A3 === "${iso}"'`,
    clip ? `-clip bbox=${clip}` : '',
    minIsland ? `-filter-islands min-area=${minIsland}km2` : '',
    `-simplify ${SIMPLIFY} keep-shapes`,
    `-dissolve`,
    `-filter-fields -each 'iso="${iso}"'`,
    `-o "${tmp}" format=geojson precision=${PRECISION}`,
  ]
    .filter(Boolean)
    .join(' ')

  await mapshaper.runCommands(cmd)
  const fc = JSON.parse(await readFile(tmp, 'utf8'))
  if (!fc.features?.length) throw new Error(`no geometry produced for ${iso}`)
  features.push(...fc.features)
  await rm(tmp, { force: true })
  console.log(`  built   ${iso}`)
}

await writeFile(join(OUT, 'countries.geojson'), JSON.stringify({ type: 'FeatureCollection', features }))
await report('countries.geojson')

// US state lines only — the inner boundaries, WITHOUT the outer contour, so the faint dashes
// never double up on the crisp country outline drawn over them.
await mapshaper.runCommands(
  `-i "${statesSrc}" -filter 'adm0_a3 === "USA"' -clip bbox=${COUNTRIES[0].clip}` +
    ` -simplify ${SIMPLIFY} keep-shapes -innerlines -filter-fields -each 'kind="state"'` +
    ` -o "${join(OUT, 'us-states.geojson')}" format=geojson precision=${PRECISION}`,
)
await report('us-states.geojson')
