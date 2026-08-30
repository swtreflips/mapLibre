// Rasterises assets/vessel.svg into the vessel PNGs in public/icons/.
//
//   npm run build:icons
//
// Outputs are COMMITTED, like the basemap geometry and glyphs. Edit the SVG, re-run this, commit
// the PNGs. Never edit the PNGs directly.
//
// WHY THIS EXISTS. The vessel icon used to be a raster master: a 980x606 original LANCZOS-shrunk
// to 60x49. That destroyed the outline — the intended #086A08 stroke ended up existing in ZERO
// pixels of the shipped file, replaced by a 175-colour gradient, 1px thick on the stern and 2-3px
// on the diagonals with irregular stair-stepping. Rotating that under `icon-rotate` looked like a
// vsync tear. A vector master rasterised once at the target size has none of those problems.
//
// RASTERISE DIRECTLY AT THE TARGET SIZE. Do not render large and downscale: an SVG rasteriser's
// analytic antialiasing beats resampling, and resampling is what caused the original fault. One
// render, one edge.

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// Two source artworks now, one per moving marker. Both go through the same tiers and the same
// symmetry assertion, because both rotate on the map and both hit the same traps.
const ARTWORKS = [
  { src: join(ROOT, 'assets', 'vessel.svg'), name: 'assets/vessel.svg', variants: 'VESSEL' },
  { src: join(ROOT, 'assets', 'railcar.svg'), name: 'assets/railcar.svg', variants: 'RAIL' },
]
const OUT = join(ROOT, 'public', 'icons')

// The literal hex values in assets/vessel.svg, and what each variant replaces them with.
// Keeping the geometry in ONE file means the variants can never drift out of shape.
const BASE_FILL = '#FFC220'
const BASE_STROKE = '#086A08'
const BASE_STROKE_WIDTH = 2

// TWO SIZE TIERS, because one bitmap cannot serve z2 and z10.
//
// MapLibre scales sprites with GPU bilinear filtering and no mipmaps. Measured on the real
// renderer at devicePixelRatio 2, zoom 1.5: the 66px bitmap draws at ~40 device px (0.6x
// minification), the 2px stroke lands at 0.94 device px, and the dark outline survives on only
// 53% of the silhouette — dropping out in DIFFERENT places at each heading, so it crawls as
// ships turn. That is the artifact.
//
// The small tier fixes it two ways at once: it is baked near its display size so the GPU barely
// resamples it, and its stroke is proportionally heavier so it never falls under a device pixel.
// Smaller icons wanting bolder strokes is normal icon design, not a hack.
//
// `pixelRatio` is chosen so BOTH tiers report the same logical size (~33 CSS px wide). That is
// what lets one `icon-size` expression drive both, so the z4 switch changes weight only — never
// size. If you retune a tier, keep width / pixelRatio ≈ 33.
const TIERS = [
  { suffix: '', width: 66, height: 55, strokeWidth: 2, pixelRatio: 2, use: 'z4 and above' },
  { suffix: '-sm', width: 33, height: 28, strokeWidth: 3.4, pixelRatio: 1, use: 'below z4' },
]

// TWO STATES, TWO COLOURS. Amber = no arrival notice yet, green = one received. The default was
// previously a pale green, which made both variants green and left the difference resting on a
// lightness step alone — the thing it is meant to signal was the thing hardest to see.
//
// Separated by LIGHTNESS as well as hue (amber L*~81, green L*~63), so the pair does not depend on
// the red-green axis to be told apart, and the polarity is unchanged: the lighter hull is still
// the one with no notice.
//
// Both variants share the dark stroke on purpose — same contour, different hull — so they read as
// one family, and so the count numeral (which uses that same colour, held constant across both)
// stays true to the icon it trails. On amber it reads as a dark olive edge.
const VARIANTS = {
  VESSEL: [
    { file: 'nauticalDefault2.png', fill: '#FFC220', stroke: '#086A08', note: 'arrival_notice != yes' },
    { file: 'nauticalGreen2.png', fill: '#23B14D', stroke: '#086A08', note: 'arrival_notice = yes' },
  ],
  // ONE variant for rail. The ship's two colours encode arrival_notice; the inland leg has no
  // equivalent signal, and a second colour would imply a distinction that does not exist. Steel
  // grey, carrying the vessel's stroke so the pair reads as one family.
  RAIL: [{ file: 'railcar.png', fill: '#9AA6B2', stroke: '#086A08', note: 'inland rail leg' }],
}

const STROKE_ATTR = `stroke-width="${BASE_STROKE_WIDTH}"`

// The swaps below match on LITERAL TEXT, so an artwork whose hex had drifted would rasterise
// silently in the wrong colour instead of failing. Check every source up front.
async function readArtwork({ src, name, variants }) {
  const svg = await readFile(src, 'utf8')
  const baseFill = VARIANTS[variants][0].fill
  if (!svg.includes(baseFill) || !svg.includes(BASE_STROKE) || !svg.includes(STROKE_ATTR)) {
    throw new Error(
      `${name} no longer contains the expected literals ` +
        `(${baseFill} / ${BASE_STROKE} / ${STROKE_ATTR}). Update that artwork's first VARIANTS ` +
        `entry, or BASE_STROKE / BASE_STROKE_WIDTH here, to match the SVG.`,
    )
  }
  return { svg, baseFill, name, variants }
}

// The vessel is symmetric about its long axis, so the rendered alpha channel must mirror
// top-to-bottom. This catches the failure that shipped once: a polygon whose axis (y=27) did not
// equal the canvas centre (y=27.5). The shape was internally perfect and every row mirrored its
// partner — it simply sat half a pixel high, giving 2px of clearance above the stern and 3px
// below. MapLibre rotates about the CANVAS centre, so the hull orbited that offset rather than
// spinning on its own axis, and the stern flaps looked lopsided. Only visible by eye once it was
// turning on the map, which is exactly why it needs to be an assertion here.
async function assertVerticallySymmetric(buf, label) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width: w, height: h, channels: ch } = info
  const alphaAt = (x, y) => data[(y * w + x) * ch + (ch - 1)]

  let worst = 0
  let worstAt = null
  for (let y = 0; y < Math.floor(h / 2); y += 1) {
    for (let x = 0; x < w; x += 1) {
      const d = Math.abs(alphaAt(x, y) - alphaAt(x, h - 1 - y))
      if (d > worst) {
        worst = d
        worstAt = { x, y, mirror: h - 1 - y }
      }
    }
  }

  // Rasterisers are not bit-exact across a mirror; a couple of levels of difference is rounding.
  // Anything larger means the geometry is genuinely off-axis.
  const TOL = 4
  if (worst > TOL) {
    throw new Error(
      `${label}: not vertically symmetric — max alpha mirror-diff ${worst} at ` +
        `(${worstAt.x}, ${worstAt.y}) vs row ${worstAt.mirror}, tolerance ${TOL}.\n` +
        `  The polygon's axis of symmetry must equal the canvas centre (height/2). ` +
        `Check the y values in assets/vessel.svg.`,
    )
  }
  return worst
}

await mkdir(OUT, { recursive: true })
const artworks = await Promise.all(ARTWORKS.map(readArtwork))

for (const { svg, baseFill, name, variants } of artworks) {
  console.log(`Rasterising ${name}:`)
  for (const tier of TIERS) {
    for (const { file, fill, stroke, note } of VARIANTS[variants]) {
    // Order matters: replace the stroke colour first. If fill and stroke ever share a value,
    // doing fill first would rewrite the stroke too.
    const variantSvg = svg
      .split(BASE_STROKE).join(stroke)
      .split(baseFill).join(fill)
      .split(STROKE_ATTR).join(`stroke-width="${tier.strokeWidth}"`)

    const png = await sharp(Buffer.from(variantSvg))
      .resize(tier.width, tier.height)
      .png({ compressionLevel: 9 })
      .toBuffer()

    const outFile = file.replace(/\.png$/, `${tier.suffix}.png`)
    const skew = await assertVerticallySymmetric(png, outFile)

    const path = join(OUT, outFile)
    await writeFile(path, png)

    const { size } = await stat(path)
    const meta = await sharp(path).metadata()
    const logical = (meta.width / tier.pixelRatio).toFixed(1)
    console.log(
      `  ${outFile.padEnd(26)} ${meta.width}x${meta.height}  ${(size / 1024).toFixed(1)} KB  ` +
        `stroke ${tier.strokeWidth}  pixelRatio ${tier.pixelRatio}  logical ${logical} CSS px  ` +
        `sym ${skew}   (${tier.use}, ${note})`,
      )
    }
  }
  console.log()
}

console.log(
  '\nBoth tiers report ~33 CSS px logical width, so one icon-size expression drives both and the\n' +
    'z4 switch changes outline weight only, never size. MapView must register each PNG with its\n' +
    'OWN pixelRatio (2 for the full tier, 1 for -sm) or the small one will draw at double size.',
)
