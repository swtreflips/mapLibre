# CLAUDE.md

Guidance for Claude Code when working in this repository.

## 1. Project overview

This is a **React + Vite + MapLibre GL JS** app that renders an inbound ocean-freight
**vessel-tracking dashboard**: a left sidebar plus a full-bleed world map showing ships
moving along their ocean routes, and containers waiting at ports.

It is a **port of a working vanilla-Leaflet prototype**. The behavioral source of truth is:

- `C:\Users\Mike\OneDrive - Prime Time Packaging\Inboundmap\sidepanelmap.html`

When in doubt about *what a feature should do*, read that file — it is the reference
implementation. This repo reimplements the same mechanics on MapLibre GL (vector tiles,
GeoJSON sources + symbol/line layers) instead of Leaflet (raster tiles + DOM markers), and
**adds real-time vessel animation** that the Leaflet version does not have.

**Stack**
- Build: Vite
- UI: React 19 (functional components + hooks)
- Map: `maplibre-gl@5.24` (vector basemap, GeoJSON sources, symbol/circle/line layers)
- No state library — local component state + a `useRef`-held map instance.
- Backend: **Supabase** (routes, shipments, line-items, issues). See §12–§14 for the
  product scope, users/auth, and the Supabase data model + ingestion flow — read those
  before building data/issue/search features.

## 2. Commands

```bash
npm run dev       # Vite dev server (http://localhost:5173)
npm run build     # production build → dist/
npm run preview   # serve the production build locally
npm run lint      # ESLint
```

## 3. Architecture & conventions

- **One map, held in a ref.** The MapLibre map is created once in a `useEffect` and stored
  in `useRef` (see [src/components/MapView.jsx](src/components/MapView.jsx)) — never in
  React state. The map mutates constantly (pan/zoom/source updates); putting it in state
  would re-render on every change. Build new features by adding sources/layers to this
  existing map, not by recreating it.
- **Single world copy.** [MapView.jsx](src/components/MapView.jsx) sets `minZoom =
  log2(containerWidth / 512)` via `computeMinZoom()` (vector tiles are 512px, so world
  width at zoom *z* is `512 * 2^z`). This keeps exactly one copy of the world filling the
  viewport, and is recomputed on `resize`. Keep this.
- **Coordinate order: `[lng, lat]`.** MapLibre and GeoJSON both use `[lng, lat]`. The
  Leaflet reference uses `[lat, lng]` and flips coordinates everywhere (e.g.
  `route = coords.map(c => [c[1], c[0]])`). **When porting, drop the flips** and keep
  GeoJSON-native `[lng, lat]`. This is the single most common source of porting bugs —
  double-check every formula below for which order it expects.
- **Prefer data-driven layers over DOM markers.** Represent vessels/containers as features
  in a single GeoJSON source, rendered by `symbol`/`circle`/`line` layers, and update them
  with `map.getSource(id).setData(...)`. This scales far better than one
  `maplibregl.Marker` per vessel and is required for smooth animation.
- **Style:** Carto Positron (`https://basemaps.cartocdn.com/gl/positron-gl-style/style.json`).
  The Leaflet version used Carto `light_nolabels` raster tiles — Positron is the vector
  equivalent.

## 4. Data model

> This section documents the **in-app shape** the map mechanics (§5–§8) consume. The
> **production Supabase schema** (shipments, line-items, issues, baseline ETA, health
> status) lives in **§14** — normalize Supabase rows into the shape below before feeding
> the map.

### Shipments (operational data)
In the prototype this is an inline JSON array (`<script id="inbounds-data">`). In the React
app, load it from Supabase (§14). Fields per shipment:

| field | meaning |
|---|---|
| `route` | `"POL - POD"` string; joins to a route feature's `key` |
| `port_of_loading` / `port_of_discharge` | origin / destination port names |
| `Lastcy` | final container yard (drayage destination) |
| `confirmed_carrier` | ocean carrier (ONE, HPL, COS, …) |
| `shipment` | unique shipment id (e.g. `INBSHIP3485`) — use as feature id |
| `container` | container number |
| `vessel` | vessel name |
| `actual_shipping` | `YYYY-MM-DD` departure (route start date) |
| `expected_portdate` | `YYYY-MM-DD` **current** forwarder ETA — moves each snapshot; the route end date that drives map progress + the §6.2 animation |
| `forwarder_initial_eta` | `YYYY-MM-DD` forwarder's **first** ETA — set once, never overwritten. Baseline for delay-vs-plan. See §14 |
| `actual_portdate` | `YYYY-MM-DD` actual arrival, or `""` if not arrived |
| `appointment_date` | drayage appointment, or `""` |
| `arrival_notice` | `"yes"` / `"no"` |
| `last_freeday` | `YYYY-MM-DD` last free day at the yard, or `""` |

**Date parsing:** parse `YYYY-MM-DD` manually into a *local* midnight date
(`new Date(y, m-1, d)`) and compare against today's local midnight. Do **not** use
`new Date("2025-12-01")` (that parses as UTC and causes off-by-one-day bugs).

### Routes (from Supabase, not a bundled file)
Routes are **fetched at runtime from a Supabase DB** (the prototype's `ocean_routes.geojson`
is *not* copied into this app). Whatever the query returns, normalize it into the same shape
the mechanics below expect — one `LineString`-like record per route with:

- `key` — `"POL - POD"`, the join key (matched via `normalizeKey`, below)
- `port_of_loading`, `port_of_discharge`
- `polCoords` — `[lng, lat]` of the loading port
- `podCoords` — `[lng, lat]` of the discharge port
- `coordinates` — array of `[lng, lat]` waypoints (the path POL→POD)

Use GeoJSON-native `[lng, lat]` ordering throughout. Fetch routes once on mount (they're
static per route), join to shipments, then feed the vessel/container GeoJSON sources.

### The join
`normalizeKey(s)` collapses whitespace, normalizes `, ` spacing, trims, and lowercases:

```js
const normalizeKey = (s) =>
  s ? s.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim().toLowerCase() : '';
```

Group shipments by `normalizeKey(shipment.route)`, then for each route feature whose
`normalizeKey(properties.key)` is present, render its shipments. Multiple shipments can
share one route (they get fanned out by the jitter/spiral offsets below).

## 5. Vessel mechanics (port these — keep the math exact)

All constants below come from the reference. Keep them identical unless deliberately
re-tuning. Watch coordinate order — formulas tagged **[lat,lon]** are written as in the
Leaflet source; convert to `[lng, lat]` when you port them.

### 5.1 Progress along the route
`progress = (today - startDate) / (endDate - startDate)`, clamped to `[0, 1]`.
Then find the point at fractional distance `progress` along the polyline:

1. Total length = sum of **Haversine** distances between consecutive waypoints.
2. Target distance = `total * progress`.
3. Walk segments accumulating length; in the segment where the running sum first reaches
   the target, linear-interpolate: `t = (target - sumBefore) / segLength`, and
   `vesselPos = lerp(route[i], route[i+1], t)`. Remember the segment index `cut`.

**Haversine** (R = 6371 km), as written **[lat,lon]**:
```js
function haversineDistance(a, b) {            // a,b = [lat, lon]
  const R = 6371, toRad = x => x * Math.PI / 180;
  const dLat = toRad(b[0] - a[0]), dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]), lat2 = toRad(b[0]);
  const h = Math.sin(dLat/2)**2 + Math.sin(dLon/2)**2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}
```

### 5.2 Bearing / direction
Great-circle bearing from `vesselPos` to the next waypoint `route[min(cut+1, last)]`,
in degrees `0..360`, written **[lat,lon]**:
```js
function computeBearing(a, b) {               // a,b = [lat, lon]
  const toRad = d => d * Math.PI / 180, toDeg = r => r * 180 / Math.PI;
  const lat1 = toRad(a[0]), lon1 = toRad(a[1]);
  const lat2 = toRad(b[0]), lon2 = toRad(b[1]);
  const dLon = lon2 - lon1;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
```
- The reference rotates the marker by `bearing - 90` to match the ship PNG's orientation
  (the PNG points "east" at 0°). In MapLibre, store `bearing` (or `bearing - 90`,
  whichever matches your sprite) as a feature property and drive the symbol with
  `"icon-rotate": ["get", "bearing"]` and `"icon-rotation-alignment": "map"`. Verify the
  sign/offset visually against your actual icon and adjust the `-90` if needed.

### 5.3 Vessel de-cluster — proximity-based, in screen-pixel space

> **This replaces the Leaflet `applyJitter`.** The original offset by *degrees* keyed on a
> per-route-group `index`, so it only de-stacked ships that shared the *exact same route* and
> needed a hand-tuned inverted-logistic to fake "shrink on zoom in." We instead spread any
> vessels whose **icons would visually overlap**, regardless of route. (Containers are
> unaffected — they keep §5.4.)

Icon overlap is a **pixel** phenomenon, not a geographic one, so cluster in screen space.
This makes the effect zoom-aware for free: zoom in → the same geo gap becomes more pixels →
clusters split → offsets vanish, so a vessel sits exactly on its true position once it's
visually distinguishable. It also avoids the latitude distortion of degree-based offsets.

**Algorithm** (operates on the true, post-ETA-easing positions from §5.1/§6):

1. **Project:** `px = map.project([lng, lat])` for every en-route vessel.
2. **Cluster** by pixel distance under a threshold ≈ icon size (`CLUSTER_PX ≈ 36`). For our
   vessel counts (dozens) a simple O(n²) pairwise/union-find pass is plenty; switch to grid-
   binning only if counts reach the thousands.
3. **Fan out** each cluster of *k* from its **centroid** on a golden-angle spiral in pixels
   (Vogel's model — same idea as the container spiral you're keeping, but pixel-based and
   centroid-anchored), then `unproject` back to `[lng, lat]`:
   ```js
   const GOLDEN = 137.5 * Math.PI / 180;     // radians
   const RING_PX = 18;                        // base pixel radius
   // members sorted by shipment id for stable slots (see flicker note)
   members.forEach((v, i) => {
     if (members.length === 1) { v.offsetPx = [0, 0]; return; }  // singleton: no offset
     const r = RING_PX * Math.sqrt(i);        // even packing for large k
     const a = i * GOLDEN;
     v.offsetPx = [centroidPx.x + Math.cos(a) * r, centroidPx.y + Math.sin(a) * r];
   });
   // displayLngLat = map.unproject(v.offsetPx)
   ```
4. **Singletons** (lone vessels) get zero offset — drawn on their true position.

**Avoid per-frame flicker** (two cheap rules, both required):
- **Stable slots:** sort each cluster's members by `shipment` id before assigning spiral
  slots, so a given vessel keeps its slot while the cluster persists — no swapping/popping.
- **Decouple compute from apply:** recompute clusters on `move` / `zoom` / data-refresh
  events (and while an ETA-ease is active), cache each vessel's `offsetPx`, and just *apply*
  the cached offset every frame. Mirrors how the original only recomputed jitter on
  `zoomend`/`moveend`. Optionally ease `offsetPx` toward its new target over ~200 ms so
  transient membership changes never pop.

**Composition order per vessel:** true progress → `vesselPos` (§5.1, incl. easing) →
**project → cluster → spiral offset → unproject** → write feature. Bearing is still taken
from route direction (§5.2); the offset only nudges the icon a few px and never rotates it.

Tunables: `CLUSTER_PX` (overlap threshold) and `RING_PX` (spread tightness).

### 5.4 Container spiral (ports) — golden-angle fan
> Containers keep this original, per-port, index-based offset **unchanged** — it is
> deliberately *not* replaced by the proximity de-cluster in §5.3 (that's vessels only).

Containers parked at the same port are fanned out on a Fibonacci/golden-angle spiral, with
the radius compressed past zoom 7 so they collapse together when zoomed in. `index` is the
per-port slot (0 = exactly on the port, no offset). Written **[lat,lon]**:
```js
function applyContainerOffset([lat, lon], zoom, index = 0) {
  if (index === 0) return [lat, lon];
  const baseOffset = 0.60, minZoom = 3, maxZoom = 7;
  const spiralScale = Math.pow(minZoom / Math.min(zoom, maxZoom), 1.2);
  const compress = zoom > maxZoom ? Math.exp(-(zoom - maxZoom) / 3) : 1;
  const j = baseOffset * spiralScale * compress;
  const angle = (index * 137.5) * Math.PI / 180;        // golden angle
  return [lat + Math.sin(angle) * j, lon + Math.cos(angle) * j];
}
```
- **Future** containers: per-POL index assigned in encounter order.
- **Arrived** containers: per-POD index = position within that port's delivered list.

### 5.5 Zoom-reactive icon sizing
Icon pixel size grows with zoom and is clamped. Ship keeps its PNG aspect ratio `980/606`.
```js
// ship:      size = clamp(20 * (zoom/5)^0.8, 13, 60);  width = size * (980/606)
// container: size = clamp(35 * (zoom/5)^0.8, 30, 50);  square
```
In MapLibre, drive this with a zoom-interpolated `icon-size` expression instead of
recreating icons, e.g. `"icon-size": ["interpolate", ["linear"], ["zoom"], 3, 0.4, 10, 1.0]`
(tune stops to match the clamps above).

## 6. Real-time animation

The Leaflet version computes each vessel position **once** on load and never advances it
within a day — movement only appeared when you reloaded on a later calendar day. This app
runs the **same math continuously** in one `requestAnimationFrame` loop, with two behaviors:
an always-on **standard** mode, and an event-driven **ETA-update easing** mode.

### 6.1 Standard mode (always on)

Drive `progress` from the **real wall clock** — no speed-up factor. Each frame:

1. For each en-route shipment, `progress = (Date.now() − startDate) / (endDate − startDate)`,
   clamped `[0, 1]` (here `endDate` = the current `expected_portdate`).
2. Recompute `vesselPos` (§5.1) and `bearing` (§5.2), apply jitter (§5.3).
3. Write each vessel's `geometry.coordinates` (`[lng, lat]`) and `bearing` property into one
   FeatureCollection, then call `map.getSource('vessels').setData(fc)` **once per frame**
   (batch all vessels — never `setData` per vessel).

**On-screen the ship does not visibly move** — a 30-day voyage advances ~0.0000004% per
frame, below perception. That is expected and fine. The reason to run the loop anyway is
*how the data is processed*: per-frame `setData` + GPU-driven symbol rendering is the smooth,
efficient, "honest" way to render the live position, and it's the same machinery the easing
mode (§6.2) needs. This is the **default** for every en-route vessel.

- Symbol rotation comes "for free" from `"icon-rotate": ["get", "bearing"]`; you only update
  the property, not the layer.
- **Cleanup:** `cancelAnimationFrame(rafRef.current)` in the effect cleanup, alongside
  `map.remove()`. Pause the loop on `visibilitychange` when the tab is hidden.
- Containers (future/arrived) are static — they don't ride the loop, only a jitter/size
  refresh on zoom.

### 6.2 ETA-update easing (event-driven — the visible movement)

Forwarders give an initial ETD (`actual_shipping`) and ETA (`expected_portdate`); the ETA is
**revised during the voyage** — pushed later (delayed), pulled earlier (faster), or left
unchanged. Because `progress`'s denominator is `(endDate − startDate)`, changing the ETA
changes where the vessel *should* be **right now**:

- **Later ETA** → longer trip → the same elapsed time is a smaller fraction → true "now"
  position moves **backward** along the route.
- **Sooner ETA** → shorter trip → true "now" position moves **forward**.
- **Unchanged ETA** → no jump; standard imperceptible drift (§6.1) just continues. **No
  easing fires.**

When a data refresh changes a vessel's `expected_portdate`, **don't snap** to the new
position — **ease the `progress` value** from the currently rendered progress to the new
true-now progress over ~1–2s with an ease-in-out, recomputing `vesselPos` from the polyline
each frame. Because we interpolate *progress* (not lat/lng), the ship **glides along its
actual route**, never cutting across land/ocean.

Two locked-in behaviors for this slide:
- **Path:** progress-based easing along the route (not a straight-line lerp between points).
- **Heading:** the icon **keeps facing forward toward POD** for the whole slide — i.e. take
  `bearing` from the route toward the next waypoint (§5.2), **not** from the frame-to-frame
  motion delta. So a *delayed*-ETA correction looks like the ship drifting backward while
  still pointing ahead, never spinning 180°.

**State to track per vessel** (in a ref-held map keyed by `shipment` id):

```js
// renderedProgress: what's currently drawn (tracks live truth when no transition active)
// transition: null, or { fromProgress, toProgress, startTime, durationMs }
```

Each frame:
```js
const trueProgress = clamp((now - startDate) / (endDate - startDate), 0, 1);
if (v.transition) {
  const t = Math.min((now - v.transition.startTime) / v.transition.durationMs, 1);
  v.renderedProgress = lerp(v.transition.fromProgress, v.transition.toProgress, easeInOut(t));
  if (t >= 1) v.transition = null;        // resume tracking live truth
} else {
  v.renderedProgress = trueProgress;
}
// vesselPos = positionAtProgress(route, v.renderedProgress)   // §5.1 interpolation
```

**Detecting an ETA change:** keep the last-seen `expected_portdate` per `shipment` id. When
new data arrives with a different value, start a transition: `fromProgress = current
renderedProgress`, `toProgress = clamp((now − startDate) / (newEndDate − startDate), 0, 1)`,
`startTime = now`, `durationMs ≈ 1200`. Then adopt `newEndDate` as the vessel's `endDate` so
standard mode continues from the new ETA after the slide completes.

> Note: `toProgress` is snapshotted at transition start. True progress barely moves over ~1s,
> so a fixed target is fine; if you want to be exact, re-evaluate `toProgress` each frame
> against the new `endDate` and the slide will settle onto live truth seamlessly.

## 7. Three-state logic (per shipment)

Decide state from today's local-midnight date:

| state | condition | placement | icon | color rule |
|---|---|---|---|---|
| **Future** | `startDate > today` | `polCoords` + spiral offset | container | blue |
| **Arrived** | `actual_portdate` set and `≤ today` | `podCoords` + spiral offset | container | `appointment_date` set → **green**; else days-at-CY `> 3` → **red**; else **blue** |
| **En route** | otherwise | interpolated `vesselPos` (animated) | ship | `arrival_notice === "yes"` → **green**; else **black** |

- days-at-CY = `floor((today - actual_portdate) / 1 day)`.
- transit days (future popup) = `floor((endDate - startDate) / 1 day)`;
  remaining (en-route popup) = `floor((endDate - today) / 1 day)`.

## 8. Sidebar & stats

Two stacked panels in a 380px-wide sidebar (`#details` over `#stats` in the original).
Implement as React components driven by state; update "Selected" on feature click.

- **Selected shipment** (`updateSidebarSelected` in the original): shipment, container,
  vessel, carrier, `POL → POD`, actual shipping, expected port date, actual port date
  (if any), arrival notice.
- **Snapshot stats** (`updateSidebarStats`) — counts over all shipments:
  - **Total** = number of shipments.
  - **On Water** = `actual_shipping` and `expected_portdate` set, `actual_portdate` empty,
    and `actual_shipping ≤ today ≤ expected_portdate`.
  - **Arrived** = `actual_portdate` is set.
  - **Past Free Day** = `last_freeday` set and `last_freeday < today`.

**Interaction** (en-route ships): clicking a ship opens its popup and draws a dashed
remaining-route line (`vesselPos → end`); clicking another ship clears the previous one;
closing the popup removes the dashed line. In MapLibre, render the dashed remaining route as
a `line` layer (`line-dasharray`) fed by a GeoJSON source you swap on click, and use
`maplibregl.Popup` on the click event.

## 9. What to DROP from the Leaflet version

The original needed several hacks that MapLibre makes unnecessary — **do not port these**:

- `worldCopyJump: true` — MapLibre handles antimeridian/world wrapping natively
  (`renderWorldCopies`, default on). Combined with the `computeMinZoom` single-copy
  constraint already in [MapView.jsx](src/components/MapView.jsx), you don't need it.
- **`[0, -360, 360].forEach` marker cloning** — the original drew three copies of every
  marker at `lng`, `lng-360`, `lng+360` to survive horizontal wrapping. MapLibre renders
  symbol layers across world copies automatically. One feature per vessel/container.
- **`moveend` popup re-anchor** (the `while (newLng - centerLng > 180) …` block) — not
  needed; MapLibre keeps popups anchored to their feature across wraps.

This was the "trick to show only one copy of the map" the prototype relied on for Leaflet;
it is obsolete here.

## 10. Icon assets (already copied into this repo)

The 5 PNG icons `sidepanelmap.html` actually uses are now in [public/icons/](public/icons/):

| file | used for | color key |
|---|---|---|
| `nauticalWhite2.png` | en-route ship, default | `black` (arrival_notice ≠ yes) |
| `nauticalGreen2.png` | en-route ship | `green` (arrival_notice = yes) |
| `blueContainer.png` | container | `blue` |
| `greenContainer.png` | container | `green` (appointment set) |
| `redContainer.png` | container | `red` (>3 days at CY) |

- **Casing fix:** the Leaflet source referenced `Bluecontainer.png`, but the real file is
  **`blueContainer.png`** (lowercase `b`). It only worked because Windows is case-insensitive.
  Use the exact lowercase name — Vite dev on case-sensitive hosts (and production) will 404
  otherwise.
- Routes are **not** bundled — they come from Supabase (§4).
- Register each PNG with `map.loadImage('/icons/<file>', …)` + `map.addImage(name, img)`
  before adding the symbol layers, then select per feature via
  `"icon-image": ["match", ["get", "color"], "green", "shipGreen", …, "shipDefault"]`.
- The ship PNGs point "east" at 0° — keep the `bearing − 90` orientation note from §5.2 in
  mind (verify against the real sprite and adjust the offset if needed).

## 11. Pointers

- **Reference implementation (source of truth):**
  `C:\Users\Mike\OneDrive - Prime Time Packaging\Inboundmap\sidepanelmap.html`
- **Route-data delivery options** (static GeoJSON vs API vs PostGIS vs vector tiles):
  see [polylineApproach.txt](polylineApproach.txt). This app pulls routes from **Supabase**
  (§4) — treat that doc as background on the trade-offs, not the chosen path.
- **Project structure notes:** [structure.txt](structure.txt).
- **Current map component:** [src/components/MapView.jsx](src/components/MapView.jsx) — build
  the dashboard on top of this; do not rewrite the init/`computeMinZoom` logic.

## 12. Product scope & roadmap

This is an **internal, exception-based dashboard** for inbound ocean shipments currently on
water. The map is the supporting view; the real value is **surfacing what needs attention**
and **answering shipment lookups fast**. Two primary jobs:

1. **Flag & resolve issues.** Mark containers with operational problems (broken door at the
   terminal, missed connection, documentation errors, missing documents, missing arrival
   notice, etc.) and **filter the dashboard to show only shipments needing resolution** —
   healthy shipments hide.
2. **Fast lookup.** A customer calls asking how a shipment is doing vs. its planned date.
   Today ops identify the item, then look it up in **NetSuite** data tables. Replace that
   with a search over container # / HBL / MBL / PO / item name / final port that jumps
   straight to the shipment's current progress and **delay vs plan** =
   `expected_portdate − forwarder_initial_eta` (see §14).

**UX stance: search/list-first, map-linked.** Lookups are best served by *search → result
row → detail*, not by hunting on the globe. Grow the sidebar into **search bar → filter
chips → results list → selected detail**; a row click does `map.flyTo` + opens that vessel's
popup. The map and list read from one shared filtered dataset.

**Roadmap**
- **Phase 1 (first deployment):** manual thrice-weekly snapshot push to Supabase (§14); the
  dashboard reads shipments/routes, supports issues/notes, search/filter, and the map
  animation. This is the current target.
- **Phase 2 (later, separate project):** automated API/ETL from forwarder feeds / NetSuite
  into Supabase. Same schema — only ingestion changes (no app rewrite).

## 13. Users & auth

- Internal tool. **~5 team members today, may grow.** No external/customer access.
- **All authenticated users can read everything and write/resolve issues** — no role tiers
  for now. Still record `author` + timestamps on every issue/resolution for accountability
  and a future audit trail, even though permissions are uniform.
- **Supabase Auth.** RLS: the `authenticated` role gets `select` on shipments/routes/
  line-items and `insert`/`update` on issues. **Shipment/route/line-item writes come only
  from the Python push using the service-role key (server-side, bypasses RLS)** — never from
  the browser. Keep the service-role key out of the client bundle.

## 14. Supabase data model & ingestion (v2)

Supersedes the prototype's flat inline JSON. Normalize these rows into the in-app shape §4
expects before feeding the map.

### Tables
- **shipments** — one row per container shipment = the current snapshot; **upserted** by the
  Python job on the shipment-id PK. Fields: `shipment` (PK), `container`, `vessel`,
  `confirmed_carrier`, route `key`, `port_of_loading`, `port_of_discharge`, `Lastcy`,
  `actual_shipping` (ETD), `expected_portdate` (**current** forwarder ETA — changes each
  snapshot), **`forwarder_initial_eta`** (forwarder's first ETA — set once, never
  overwritten), `actual_portdate`, `appointment_date`, `arrival_notice`, `last_freeday`,
  `hbl`, `mbl`, plus a denormalized `search_text` blob, and `first_seen` / `last_updated`
  timestamps. Consider an `active` flag (see ingestion) instead of deleting departed
  shipments.
- **line_items** — container → many items (one-to-many). Fields: `id`, `container` (FK),
  `item_name`, `po_number` / `purchase_order`, `customer`, `qty`. Powers item / PO /
  customer search; fold these into the parent's `search_text`.
- **issues** — collaborative writes (the app's only client write-path). Fields: `id`,
  `shipment`/`container` (FK), `author`, `created_at`, `category` (enum:
  `door_damage`, `missed_connection`, `doc_error`, `missing_documents`,
  `missing_arrival_notice`, `other`), `severity` (low/med/high), `status` (`open`|`resolved`),
  `note` (free text), `resolved_at`, `resolved_by`. **Structured, not a free-text blob** —
  the enum/status are what the urgent filter and metrics key off.
- **routes** — already in Supabase; §4 shape (`key`, `polCoords`, `podCoords`, `coordinates`).

### Derived health status
Per container (client-side, or a SQL view): `needs_attention = has open issue OR past free
day OR (en route AND missing arrival_notice) OR (arrived AND days-at-CY > 3 AND no
appointment)`. Drives both the **urgent filter** and the **icon color** (generalizes the
red/green/blue rules in §7).

### ETA rules (critical) — two dates
- **`expected_portdate`** — current forwarder ETA. The snapshot updates it freely; it drives
  map progress and the §6.2 animation.
- **`forwarder_initial_eta`** — the forwarder's first ETA. The Python upsert sets it **only on
  first insert** (when null) and **never overwrites** it.

**Delay vs plan** = `expected_portdate − forwarder_initial_eta` — reported in the §8 sidebar /
list. A later current ETA (`+++`) means delayed; an earlier one (`---`) means ahead.

**Same data drives the animation:** the §6.2 slide is the change in `expected_portdate`
between snapshots — a `+++` update slides the ship backward, a `---` update slides it forward.
`forwarder_initial_eta` is a static baseline for the delay number; it never moves the ship.
(A customer-facing planned ETA is intentionally **out of scope for now** — to be added later.)

### Ingestion — Phase 1 (manual Python push), Mondays / Wednesdays / Fridays
1. Pull forwarder updates, run the existing inbound report → a **snapshot** file (updated
   dates + newly-documented shipments, i.e. additional vessels/containers/markers).
2. Push to Supabase by **upserting `shipments` on the `shipment` PK** (and `line_items`).
   New shipments insert (new markers appear); existing ones update their dates.
   - **Do NOT delete-all-then-insert.**
   - **Do NOT touch the `issues` table** — issues are keyed to containers and must survive
     every snapshot.
   - **Preserve `baseline_eta`** (set-if-null only).
   - For shipments absent from the latest snapshot (delivered / aged out), flip an `active`
     flag rather than deleting, so their issue history is retained.

### Snapshot cadence ↔ animation
ETA "updates" arrive as new snapshots **3×/week, not continuously**. The §6.2 easing fires
when the client sees a vessel's `expected_portdate` differ from what it last had — on data
reload, or live via a Supabase **realtime** subscription if the dashboard is open when a push
lands. Across reloads the static "behind plan" number (baseline vs current) always shows; the
slide animation is the within-session reveal when fresh data arrives.
