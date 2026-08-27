// Port container card — an isometric stack of the containers sitting at one discharge port.
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

const COLUMNS = 2 // "two containers wide, more stacked on top"

// ── Colour ────────────────────────────────────────────────────────────────────────────
//
// Three shades per status: top lightest, long side mid, door end darkest. That is the entire
// depth cue — at 40-60px on a map, silhouette and shading are all that read, so corrugation and
// corner castings would be noise.
//
// The three statuses are separated by LIGHTNESS as well as hue (red ~44, blue ~51, green ~72), so
// they stay distinguishable without relying on hue alone. Stack order reinforces it: containers
// are sorted red -> blue -> green, so urgency always reads from the bottom up and position carries
// the same signal a second time.
const SHADES = {
  red: { top: '#E0574A', side: '#C0392B', end: '#962A1F' },
  blue: { top: '#5B97E5', side: '#3B7DD8', end: '#2A5FA8' },
  green: { top: '#6FD79A', side: '#57C785', end: '#3E9A63' },
}

const OUTLINE = 'rgba(18, 28, 22, 0.55)'
// In CSS PIXELS, not user units — see vector-effect below.
const OUTLINE_WIDTH = 0.9

// Bottom-up urgency: aging first, then recent, then already booked.
const STATUS_ORDER = { red: 0, blue: 1, green: 2 }

const pts = (points) => points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ')

// The three visible faces of one box, as screen-space polygons.
function boxFaces(x0, z0) {
  const x1 = x0 + BOX_W
  const y1 = BOX_L
  const z1 = z0 + BOX_H
  return {
    // +z — the lid
    top: [iso(x0, 0, z1), iso(x1, 0, z1), iso(x1, y1, z1), iso(x0, y1, z1)],
    // +x — the long corrugated flank, lower-right
    side: [iso(x1, 0, z0), iso(x1, y1, z0), iso(x1, y1, z1), iso(x1, 0, z1)],
    // +y — the door end, lower-left
    end: [iso(x0, y1, z0), iso(x1, y1, z0), iso(x1, y1, z1), iso(x0, y1, z1)],
  }
}

/**
 * @param {Array<'red'|'blue'|'green'>} statuses one entry per container at this port
 * @param {number} size  rendered box in CSS px (the stack shrinks to fit inside it)
 * @returns {string} inline SVG markup, or '' when the port has no containers
 */
export function portCardSvg(statuses, size = 72) {
  if (!statuses || statuses.length === 0) return '' // no containers -> no card

  const ordered = [...statuses].sort(
    (a, b) => (STATUS_ORDER[a] ?? 9) - (STATUS_ORDER[b] ?? 9),
  )

  // Fill the bottom row left to right, then upward.
  //   index 0 -> back-left, 1 -> front-right, 2 -> second level back-left, ...
  const boxes = ordered.map((status, i) => ({
    status,
    col: i % COLUMNS,
    level: Math.floor(i / COLUMNS),
  }))

  // PAINTER'S ORDER. Every box shares the same y extent, so depth collapses to (x + z) and the
  // whole overlap problem reduces to one ascending sort: front occludes back, and an upper box
  // occludes the top face of the one beneath it. No special cases.
  boxes.sort((a, b) => a.col * BOX_W + a.level * BOX_H - (b.col * BOX_W + b.level * BOX_H))

  const polys = []
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const { status, col, level } of boxes) {
    const faces = boxFaces(col * BOX_W, level * BOX_H)
    const shade = SHADES[status] ?? SHADES.blue
    for (const face of ['top', 'side', 'end']) {
      const p = faces[face]
      for (const [x, y] of p) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
      polys.push(`<polygon points="${pts(p)}" fill="${shade[face]}"/>`)
    }
  }

  // Pad in user units for the stroke that will be drawn just outside the geometry.
  const pad = 1.5
  const vb = [minX - pad, minY - pad, maxX - minX + pad * 2, maxY - minY + pad * 2]

  // The viewBox does the shrink-to-fit: the stack is drawn at natural size and SVG scales it into
  // `size`. Taller stacks simply come out smaller, with no manual scaling maths — and it stays
  // vector-crisp at every zoom and devicePixelRatio, which is the point of SVG over a bitmap.
  //
  // xMidYMax pins the stack to the BOTTOM of the box so its base lands on the port when the
  // marker is anchored 'bottom'. xMidYMid would float short stacks above the port.
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
