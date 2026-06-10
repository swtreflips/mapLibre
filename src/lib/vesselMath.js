// Vessel geometry helpers. ALL coordinates are GeoJSON-native [lng, lat]
// (the Leaflet reference used [lat, lng]; the flips are dropped here — see CLAUDE.md §3).

// Collapse whitespace, normalize ", " spacing, trim, lowercase — the shipment↔route join key.
export const normalizeKey = (s) =>
  s ? s.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim().toLowerCase() : ''

// "YYYY-MM-DD" -> local-midnight Date, or null. Manual parse avoids UTC off-by-one.
export function parseYMD(s) {
  if (!s) return null
  const [y, m, d] = s.split('-').map(Number)
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d)
}

const R = 6371 // km
const toRad = (x) => (x * Math.PI) / 180

// Great-circle distance in km. a, b = [lng, lat].
export function haversine(a, b) {
  const dLat = toRad(b[1] - a[1])
  const dLon = toRad(b[0] - a[0])
  const lat1 = toRad(a[1])
  const lat2 = toRad(b[1])
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return 2 * R * Math.asin(Math.sqrt(h))
}

// Great-circle bearing a->b in degrees 0..360. a, b = [lng, lat].
export function computeBearing(a, b) {
  const lat1 = toRad(a[1])
  const lat2 = toRad(b[1])
  const dLon = toRad(b[0] - a[0])
  const y = Math.sin(dLon) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

// Fraction 0..1 of the voyage elapsed. start/end = Date, now = Date.
export function computeProgress(start, end, now = new Date()) {
  if (!start || !end) return 0
  const s = start.getTime()
  const e = end.getTime()
  if (e <= s) return 1
  return Math.min(Math.max((now.getTime() - s) / (e - s), 0), 1)
}

// Point at fractional distance `progress` along coords [[lng,lat],...].
// Returns { pos:[lng,lat], cut } where `cut` is the index of the segment start.
export function positionAtProgress(coords, progress) {
  if (!coords || coords.length === 0) return { pos: null, cut: 0 }
  if (coords.length === 1) return { pos: coords[0], cut: 0 }
  let total = 0
  for (let i = 0; i < coords.length - 1; i++) total += haversine(coords[i], coords[i + 1])
  const target = total * progress
  let sum = 0
  for (let i = 0; i < coords.length - 1; i++) {
    const seg = haversine(coords[i], coords[i + 1])
    if (sum + seg >= target) {
      const t = seg === 0 ? 0 : (target - sum) / seg
      const pos = [
        coords[i][0] + t * (coords[i + 1][0] - coords[i][0]),
        coords[i][1] + t * (coords[i + 1][1] - coords[i][1]),
      ]
      return { pos, cut: i }
    }
    sum += seg
  }
  return { pos: coords[coords.length - 1], cut: coords.length - 2 }
}

// Golden-angle spiral offset for containers sharing a port (CLAUDE.md §5.4).
// index 0 = exactly on the port; radius compresses past zoom 7. p = [lng, lat].
export function applyContainerOffset([lng, lat], zoom, index = 0) {
  if (index === 0) return [lng, lat]
  const baseOffset = 0.6
  const minZoom = 3
  const maxZoom = 7
  const spiralScale = Math.pow(minZoom / Math.min(zoom, maxZoom), 1.2)
  const compress = zoom > maxZoom ? Math.exp(-(zoom - maxZoom) / 3) : 1
  const j = baseOffset * spiralScale * compress
  const angle = (index * 137.5 * Math.PI) / 180 // golden angle
  return [lng + Math.cos(angle) * j, lat + Math.sin(angle) * j]
}

// Container color rule for the ARRIVED state (CLAUDE.md §7):
// appointment set -> green; else days-at-CY > 3 -> red; else blue.
export function containerColor(s, today = new Date()) {
  if (s.appointment_date && s.appointment_date.trim() !== '') return 'green'
  const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const arrived = parseYMD(s.actual_portdate)
  const daysAtCY = arrived ? Math.floor((todayMid - arrived) / 86400000) : 0
  return daysAtCY > 3 ? 'red' : 'blue'
}

// Three-state classification (CLAUDE.md §7). Today defaults to now's local midnight.
export function shipmentState(s, today = new Date()) {
  const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const start = parseYMD(s.actual_shipping)
  const arrived = parseYMD(s.actual_portdate)
  if (start && start > todayMid) return 'future'
  if (arrived && arrived <= todayMid) return 'arrived'
  return 'enroute'
}
