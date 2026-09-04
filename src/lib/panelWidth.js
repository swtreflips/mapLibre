// How wide the sidebar is, and how wide it is allowed to be.
//
// The panel was a fixed 380px, which is right while the map is the subject and wrong the moment it
// is not: working through search results — the "fast lookup" job in CLAUDE.md §12 — means reading a
// one-card-wide column against a map nobody is looking at. Dragging trades map width for list
// width, and past TWO_COL_AT the container cards go to two columns.
//
// THE STOPS ARE NOT ARBITRARY. A card sits at ~356px today: 380 minus the tray list's 12px padding
// on each side. At MAX_WIDTH the two columns come out at ~363px each — WIDER than the single column
// is now — so doubling is precisely the width at which a second column costs nothing.
//
//   380  |card 356|              one column, today
//   660  |card 313|card 313|     two columns, 12% tighter than today
//   760  |card 363|card 363|     two columns, roomier than today
//
// TWO_COL_AT sits below the point where columns match today's width (~746px) on purpose. Waiting
// for that would mean the second column only ever appeared in the last few pixels of the drag.

export const MIN_WIDTH = 380
export const MAX_WIDTH = 760
export const TWO_COL_AT = 660

// Versioned like the notes key, for the same reason: the shape stored here is a decision, and a
// later one should not have to interpret this one's leftovers.
const KEY = 'inbound.sidebar.v1'

/**
 * Hold a width inside the stops.
 *
 * NON-NUMBERS COLLAPSE TO THE MINIMUM RATHER THAN PROPAGATING. `Math.min(Math.max(NaN, …))` is NaN,
 * and a NaN width reaches CSS as an invalid value — which does not error, it just leaves the panel
 * at whatever the stylesheet last said, or at nothing. A stored string, a corrupted entry or an
 * arithmetic slip during a drag all arrive here, and all of them should end at 380 rather than
 * somewhere unpredictable.
 */
export function clampWidth(px) {
  const n = Number(px)
  if (!Number.isFinite(n)) return MIN_WIDTH
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(n)))
}

// localStorage throws, and not only in exotic cases: a private window can deny access outright and
// a full quota rejects the write. A panel preference that takes the dashboard down with it is far
// worse than one that quietly forgets, so every read and write is guarded and failure degrades to
// the default — the same stance src/lib/notes.js takes, for the same reasons.
export function readWidth() {
  try {
    const raw = localStorage.getItem(KEY)
    return raw == null ? MIN_WIDTH : clampWidth(raw)
  } catch {
    return MIN_WIDTH
  }
}

/** @returns {boolean} false when the write failed, so a caller can tell rather than assume. */
export function writeWidth(px) {
  try {
    localStorage.setItem(KEY, String(clampWidth(px)))
    return true
  } catch {
    return false
  }
}
