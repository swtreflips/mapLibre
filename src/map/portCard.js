// Port container card — three isometric stacks, one per status, radiating from the port.
//
// Replaces the golden-angle spiral that drew one icon per container. The spiral answered the wrong
// question: you counted scattered boxes instead of reading a port's load at a glance.
//
// This is a plain function returning an SVG STRING, not a React component. MapLibre markers own
// raw DOM, so a string goes straight into marker.getElement().innerHTML — no React root to create,
// reconcile and tear down per marker.
//
// Everything here is pure geometry + colour. It knows nothing about the map.

// ── Isometric projection ──────────────────────────────────────────────────────────────
//
// World axes: x across (containers sit side by side along x), y along the container's LENGTH,
// z up. Screen:
//     sx = (x - y) * cos30
//     sy = (x + y) * sin30 - z
//
// +x maps right-and-down, +y maps left-and-down, +z maps straight up. That orientation is chosen
// so the LONG corrugated side faces lower-right and the door end faces lower-left, matching how a
// container is normally drawn.
const COS30 = Math.cos(Math.PI / 6)
const SIN30 = 0.5
const iso = (x, y, z) => [(x - y) * COS30, (x + y) * SIN30 - z]

// Roughly a 20ft box: 2.44m wide x 6.06m long x 2.59m high -> 12 : 30 : 13.
const BOX_W = 12
const BOX_L = 30
const BOX_H = 13

const COLUMNS = 2 // each arm is "two containers wide, more stacked on top"

// ── The three arms ────────────────────────────────────────────────────────────────────
//
// Each status gets its OWN pile, on its own axis out of a shared centre. Blue goes northwest,
// red northeast, green due south — 120 degrees apart on screen.
//
// The isometric ground plane hands us those three directions exactly, which is why the layout is
// this and not an arbitrary rosette:
//
//     -x        -> (-cos30, -sin30)  up-and-left    NW   blue
//     -y        -> (+cos30, -sin30)  up-and-right   NE   red
//     +x +y     -> (0,      +1    )  straight down  S    green
//
// All three land at the same screen radius from centre, so the arms are evenly spread with no
// per-arm fudge factor. Verify with iso(): iso(-R,0) = (-.866R, -.5R), iso(0,-R) = (+.866R, -.5R),
// iso(R,R) = (0, R) — three vectors of length R, 120 degrees apart.
//
// WHY PILES AND NOT ONE MIXED STACK: position now carries status independently of hue. A card with
// one pile in the northwest is a blue-only port whether or not you can see the blue — which matters
// on a map read by someone colour-blind. Colour and position say the same thing twice.
const ARM_R = 27 // screen radius of each arm from the card centre

// `depth` orders the arms front-to-back: green sits nearest the viewer, blue and red behind it.
// Blue and red never overlap on screen (opposite sides), so their relative order is arbitrary.
const ARMS = {
  blue: { dx: -ARM_R, dy: 0, depth: 0 },
  red: { dx: 0, dy: -ARM_R, depth: 0 },
  green: { dx: ARM_R, dy: ARM_R, depth: 1 },
}

// Arms are drawn (and the empty frame reserved) in this order.
const ARM_ORDER = ['blue', 'red', 'green']

// An arm's footprint is centred on its axis point, so the piles sit symmetrically around the
// centre rather than hanging off it.
const armBase = (arm) => [
  ARMS[arm].dx - (COLUMNS * BOX_W) / 2,
  ARMS[arm].dy - BOX_L / 2,
]

// ── Colour ────────────────────────────────────────────────────────────────────────────
//
// Three shades per status: top lightest, long side mid, door end darkest. That is the entire
// depth cue — at 40-60px on a map, silhouette and shading are all that read, so corrugation and
// corner castings would be noise.
//
// The three statuses are separated by LIGHTNESS as well as hue (red ~44, blue ~51, green ~72), so
// they stay distinguishable without relying on hue alone. The arm layout above reinforces it a
// third time: which corner a pile sits in IS its status.
const SHADES = {
  red: { top: '#E0574A', side: '#C0392B', end: '#962A1F' },
  blue: { top: '#5B97E5', side: '#3B7DD8', end: '#2A5FA8' },
  green: { top: '#6FD79A', side: '#57C785', end: '#3E9A63' },
}

const OUTLINE = 'rgba(18, 28, 22, 0.55)'
// In CSS PIXELS, not user units — see vector-effect below.
const OUTLINE_WIDTH = 0.9

// The faint ground quad marking an arm's slot. Neutral grey (R=G=B) on purpose: it is structure,
// not data, and must not read as a fourth status. Piles cover their own pad, so in practice this
// is only visible where a section is EMPTY — which is the point. An absent pile is legible as
// "no red here" rather than as an ambiguous gap.
const PAD_FILL = 'rgba(90, 90, 90, 0.14)'

const pts = (points) => points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ')

// The three visible faces of one box, as screen-space polygons.
function boxFaces(x0, y0, z0) {
  const x1 = x0 + BOX_W
  const y1 = y0 + BOX_L
  const z1 = z0 + BOX_H
  return {
    // +z — the lid
    top: [iso(x0, y0, z1), iso(x1, y0, z1), iso(x1, y1, z1), iso(x0, y1, z1)],
    // +x — the long corrugated flank, lower-right
    side: [iso(x1, y0, z0), iso(x1, y1, z0), iso(x1, y1, z1), iso(x1, y0, z1)],
    // +y — the door end, lower-left
    end: [iso(x0, y1, z0), iso(x1, y1, z0), iso(x1, y1, z1), iso(x0, y1, z1)],
  }
}

// The ground rectangle of one arm's slot, projected.
function armPad(arm) {
  const [x0, y0] = armBase(arm)
  const x1 = x0 + COLUMNS * BOX_W
  const y1 = y0 + BOX_L
  return [iso(x0, y0, 0), iso(x1, y0, 0), iso(x1, y1, 0), iso(x0, y1, 0)]
}

/**
 * @param {Array<'red'|'blue'|'green'>} statuses one entry per container at this port
 * @param {number} size  rendered box in CSS px (the stack shrinks to fit inside it)
 * @returns {string} inline SVG markup, or '' when the port has no containers
 */
export function portCardSvg(statuses, size = 72) {
  if (!statuses || statuses.length === 0) return '' // no containers -> no card

  // ── The frame ───────────────────────────────────────────────────────────────────────
  //
  // Horizontal extent and the baseline come from ALL THREE arm slots, present or not — never from
  // the geometry actually drawn. That fixed frame is what makes position mean something: without
  // it the viewBox would tighten around a lone pile and re-centre it, so a blue-only port and a
  // red-only port would render as the same picture in different colours. The cost is whitespace on
  // a single-status card; the frame is the feature.
  let minX = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let minY = Infinity
  const pads = []
  for (const arm of ARM_ORDER) {
    const p = armPad(arm)
    for (const [x, y] of p) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      if (y < minY) minY = y
    }
    // Only EMPTY sections get a pad. A partly-filled slot would show its unused half as a grey
    // shard poking out beside the box — noise, since the pile itself already says where the
    // section is. The frame above is measured from all three slots either way.
    if (!statuses.some((s) => s === arm)) {
      pads.push(`<polygon points="${pts(p)}" fill="${PAD_FILL}" stroke="none"/>`)
    }
  }

  // ── The piles ───────────────────────────────────────────────────────────────────────
  const boxes = []
  for (const arm of ARM_ORDER) {
    const n = statuses.filter((s) => s === arm).length
    if (n === 0) continue
    const [bx, by] = armBase(arm)
    for (let i = 0; i < n; i++) {
      // Fill the bottom row left to right, then upward.
      //   index 0 -> back-left, 1 -> front-right, 2 -> second level back-left, ...
      const col = i % COLUMNS
      const level = Math.floor(i / COLUMNS)
      boxes.push({
        arm,
        x0: bx + col * BOX_W,
        y0: by,
        z0: level * BOX_H,
        // PAINTER'S KEY, within an arm. Every box in a pile shares the same y extent, so depth
        // collapses to (x + z) and overlap reduces to one ascending sort: front occludes back, and
        // an upper box occludes the top face of the one beneath it. No special cases.
        key: col * BOX_W + level * BOX_H,
      })
    }
  }

  // Arms first (green in front of blue/red), then depth within the arm.
  boxes.sort((a, b) => ARMS[a.arm].depth - ARMS[b.arm].depth || a.key - b.key)

  const polys = []
  for (const { arm, x0, y0, z0 } of boxes) {
    const faces = boxFaces(x0, y0, z0)
    const shade = SHADES[arm] ?? SHADES.blue
    for (const face of ['top', 'side', 'end']) {
      const p = faces[face]
      for (const [, y] of p) if (y < minY) minY = y // stacks grow the frame UPWARD only
      polys.push(`<polygon points="${pts(p)}" fill="${shade[face]}"/>`)
    }
  }

  // Pad in user units for the stroke that will be drawn just outside the geometry.
  const pad = 1.5
  const vb = [minX - pad, minY - pad, maxX - minX + pad * 2, maxY - minY + pad * 2]

  // The viewBox does the shrink-to-fit: the card is drawn at natural size and SVG scales it into
  // `size`. Taller stacks simply come out smaller, with no manual scaling maths — and it stays
  // vector-crisp at every zoom and devicePixelRatio, which is the point of SVG over a bitmap.
  //
  // xMidYMax pins the card to the BOTTOM of the box so the green arm's front edge lands on the
  // port when the marker is anchored 'bottom'. xMidYMid would float short cards above the port.
  return (
    `<svg class="port-card__svg" width="${size}" height="${size}" ` +
    `viewBox="${vb.map((v) => v.toFixed(2)).join(' ')}" ` +
    `preserveAspectRatio="xMidYMax meet" aria-hidden="true" ` +
    // vector-effect="non-scaling-stroke" is what keeps the outline honest. Without it the stroke
    // is in USER units, so it shrinks with the viewBox — a tall stack (or a low zoom) drives it
    // under one device pixel and the edges break up, exactly the failure the vessel hull hit.
    // With it, the stroke is a constant width in final render space at any stack height.
    `stroke="${OUTLINE}" stroke-width="${OUTLINE_WIDTH}" stroke-linejoin="round" ` +
    `vector-effect="non-scaling-stroke">` +
    pads.join('') +
    polys.join('') +
    `</svg>`
  )
}

/** Human-readable summary for the marker's title/aria — SVG alone tells a screen reader nothing. */
export function portCardLabel(portName, statuses) {
  const n = statuses.length
  const aging = statuses.filter((s) => s === 'red').length
  const booked = statuses.filter((s) => s === 'green').length
  const bits = [`${n} container${n === 1 ? '' : 's'}`]
  if (aging) bits.push(`${aging} aging`)
  if (booked) bits.push(`${booked} with appointment`)
  return `${portName}: ${bits.join(', ')}`
}
