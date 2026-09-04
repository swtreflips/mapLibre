// Pixel-space de-clustering for map markers.
//
// Overlap is a PIXEL phenomenon, not a geographic one — New York and Philadelphia are 130 km
// apart, which is 4 px at world zoom and 400 px at z8. So the whole calculation lives in screen
// space, which makes it zoom-aware for free: zoom in, the same geographic gap becomes more pixels,
// the overlap resolves, and every offset falls to zero on its own. A marker sits on its true
// position the moment it is visually distinguishable.
//
// Pure: pixels in, pixel offsets out. No map, no DOM.

/**
 * Push overlapping discs apart until they clear, by relaxation.
 *
 * WHY RELAXATION AND NOT A GOLDEN-ANGLE SPIRAL. CLAUDE.md §5.3 sketches a spiral for de-stacking
 * vessels, and a spiral is right there — ships in a cluster are interchangeable, so packing them
 * evenly around a centroid is fine. Ports are NOT interchangeable: they are named places, and a
 * spiral assigns slots by index, so Philadelphia could end up drawn north-east of New York. Pushing
 * along the line between two markers preserves their relative bearing, so the arrangement still
 * reads as the geography it stands for.
 *
 * Deterministic for a given input order — callers must pass markers in a stable order (sorted by
 * key), or offsets will flip between frames and the markers will jitter in the bad sense.
 *
 * PINNED MARKERS TAKE PART BUT DO NOT MOVE. A vessel arriving at its discharge port lands on the
 * exact coordinate that port's own card is drawn at, and the two must separate — but the card is
 * positioned by its own pass and cannot be shoved by this one, or the two passes would fight and
 * the card would drift a little further every frame. Pinning it makes the ship take the whole
 * correction instead of half. Two pinned markers are simply left alone: neither can yield, so
 * there is nothing to compute.
 *
 * @param {{x:number,y:number}[]} points  projected marker positions, screen px
 * @param {number[]} radii                each marker's visual radius, screen px
 * @param {number} gap                    clear space to leave between two markers, px
 * @param {number} passes                 relaxation iterations; more = closer to fully resolved
 * @param {boolean[]|null} pinned         markers that others must clear but that never move
 * @returns {[number,number][]} per-marker [dx, dy] offset in px, [0,0] when nothing overlaps
 */
export function relaxOverlaps(points, radii, gap = 4, passes = 24, pinned = null) {
  const n = points.length
  if (n < 2) return points.map(() => [0, 0])

  const p = points.map((q) => ({ x: q.x, y: q.y }))

  for (let pass = 0; pass < passes; pass++) {
    let moved = false
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        // Two anchors cannot resolve anything between them, and trying would move a marker whose
        // whole purpose is to stay put.
        if (pinned?.[i] && pinned?.[j]) continue
        const need = radii[i] + radii[j] + gap
        let dx = p[j].x - p[i].x
        let dy = p[j].y - p[i].y
        let d = Math.hypot(dx, dy)
        if (d >= need) continue
        // Exactly coincident — two ports on the same coordinate, or the same port twice. There is
        // no line to push along, so pick one; without this the normalisation divides by zero and
        // every position becomes NaN, which MapLibre renders as a silently missing marker.
        if (d < 1e-6) {
          dx = 1
          dy = 0
          d = 1
        }
        const ux = dx / d
        const uy = dy / d
        // Split the correction between the pair so neither is privileged, and so a cluster's
        // centre of mass stays put rather than the whole group drifting toward the last one moved.
        // Against an anchor there is nothing to split: the movable one covers the whole distance,
        // which is what makes a ship clear a port card completely rather than half of it.
        if (pinned?.[i]) {
          p[j].x += ux * (need - d)
          p[j].y += uy * (need - d)
        } else if (pinned?.[j]) {
          p[i].x -= ux * (need - d)
          p[i].y -= uy * (need - d)
        } else {
          const push = (need - d) / 2
          p[i].x -= ux * push
          p[i].y -= uy * push
          p[j].x += ux * push
          p[j].y += uy * push
        }
        moved = true
      }
    }
    // Converged: with three or more markers, resolving one pair can re-break another, so this runs
    // until a whole pass changes nothing rather than a fixed number of times.
    if (!moved) break
  }

  return p.map((q, i) => [q.x - points[i].x, q.y - points[i].y])
}
