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
GeoJSON sources + symbol/line layers) instead of Leaflet (raster tiles + DOM markers).
Vessel positions are estimates interpolated from shipping dates and are **static between
data refreshes** — there is no animation loop (§6).

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
  `maplibregl.Marker` per vessel, and lets you update all positions in one call on refresh.
- **Style:** Carto **Voyager**
  (`https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json`) — colorful/Google-Maps-like,
  clean for overlays. Set as `STYLE_URL` in [MapView.jsx](src/components/MapView.jsx), with
  Positron (grey, minimal) and OpenFreeMap Liberty (streetier) noted there as one-line swaps.

## 4. Data model

> This section documents the **in-app shape** the map mechanics (§5–§8) consume. The
> **production Supabase schema** (shipments, line-items, issues, health status) lives in
> **§14** — normalize Supabase rows into the shape below before feeding the map.

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
| `expected_portdate` | `YYYY-MM-DD` latest forwarder ETA (from the most recent push); the route end date that drives map progress (§6) |
| `actual_portdate` | `YYYY-MM-DD` actual arrival, or `""` if not arrived |
| `appointment_date` | drayage appointment, or `""` |
| `arrival_notice` | `"yes"` / `"no"` |
| `last_freeday` | `YYYY-MM-DD` last free day at the yard, or `""` |

**Date parsing:** parse `YYYY-MM-DD` manually into a *local* midnight date
(`new Date(y, m-1, d)`) and compare against today's local midnight. Do **not** use
`new Date("2025-12-01")` (that parses as UTC and causes off-by-one-day bugs).

### Routes (from Supabase, not a bundled file)
Routes are **fetched at runtime from the Supabase `routes` table** (the prototype's
`ocean_routes.geojson` is *not* copied into this app). Actual columns:

- `origin_port`, `destination_port` — port name strings (generated by `searoute` in Python)
- `route_geom` — a GeoJSON `LineString` (`[lng, lat]` coordinates, ordered POL→POD)
- `geojson` — a GeoJSON `Feature` wrapper (unused; `route_geom` is enough)

[useRoutes.js](src/hooks/useRoutes.js) fetches `origin_port,destination_port,route_geom` and
normalizes each row to `{ key, coordinates }` keyed by `normalizeKey("origin - destination")`.
Derive port points from the geometry: **`polCoords = coordinates[0]`,
`podCoords = coordinates[coordinates.length - 1]`** (no separate columns). Fetch once on mount;
join to shipments by key; feed the vessel/container sources. Note: routes are searoute graph
paths, so some lanes take non-obvious passages — that's data, not a plotting bug.

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

> **Status: not yet implemented.** Ships currently render on their true interpolated positions
> (en-route vessels are spread across oceans, so overlap is rare so far). This is the design for
> when vessels start to stack. The **container** spiral (§5.4) already uses this pixel-space model.

> **This replaces the Leaflet `applyJitter`.** The original offset by *degrees* keyed on a
> per-route-group `index`, so it only de-stacked ships that shared the *exact same route* and
> needed a hand-tuned inverted-logistic to fake "shrink on zoom in." We instead spread any
> vessels whose **icons would visually overlap**, regardless of route. (Containers are
> unaffected — they keep §5.4.)

Icon overlap is a **pixel** phenomenon, not a geographic one, so cluster in screen space.
This makes the effect zoom-aware for free: zoom in → the same geo gap becomes more pixels →
clusters split → offsets vanish, so a vessel sits exactly on its true position once it's
visually distinguishable. It also avoids the latitude distortion of degree-based offsets.

**Algorithm** (operates on the vessel positions computed in §5.1/§6):

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
- **Recompute on the right events:** positions are static between refreshes (§6), so
  recompute clusters on `move` / `zoom` / data-refresh only — not on a timer. Mirrors how the
  original recomputed jitter on `zoomend`/`moveend`. Cache each vessel's `offsetPx` and reuse
  it until the next such event.

**Composition order per vessel:** progress → `vesselPos` (§5.1) → **project → cluster →
spiral offset → unproject** → write feature. Bearing is taken from route direction (§5.2);
the offset only nudges the icon a few px and never rotates it.

Tunables: `CLUSTER_PX` (overlap threshold) and `RING_PX` (spread tightness).

### 5.4 Container spiral (ports) — pixel-space golden-angle fan
Arrived containers are placed at their **discharge port** and fanned so multiple at the same
port don't fully stack. Implemented in [MapView.jsx](src/components/MapView.jsx) `buildFeatures`
(this replaced the Leaflet degree-based `applyContainerOffset`):

- **Group by discharge port**, regardless of route / port of loading. All containers at a port
  share **one canonical anchor** (the first matched route's `podCoords` for that port), so
  containers arriving via different lanes still spiral around the same center.
- **Pixel-space spiral** (same model as §5.3): project the port to pixels, place slot *i* at
  radius `ring · √i`, angle `i · 137.5°`, then `unproject`. Slot 0 sits exactly on the port.
  Doing it in pixels keeps the fan a **constant on-screen size at every zoom** — the original
  degree-based offset ballooned in pixels when zoomed in (degrees shrink slower than
  pixels-per-degree grow).
- **Ring ramps with zoom:** `CONTAINER_RING_MIN_PX` (12, fully zoomed out) →
  `CONTAINER_RING_MAX_PX` (16, by ~zoom 6), then steady — a touch tighter at the low end.
- **Stable slots:** sort each port's containers by `shipment` id, so a container keeps its
  slot/position across refreshes and zoom (no jumping). Recompute on data refresh + `zoomend`.

Future containers at the POL are **deferred** (not yet implemented).
Tunables: `CONTAINER_RING_MIN_PX` / `CONTAINER_RING_MAX_PX`.

### 5.5 Icon sizing (pre-baked PNGs + zoom-interpolated `icon-size`)
Icons are **pre-downscaled with Pillow/LANCZOS** from the originals and registered with
`map.addImage(..., { pixelRatio: 2 })`. This matters: letting the GPU minify the full-res PNGs
(980/500px) down to ~20–40px shattered the thin outlines. Bake near display size instead, then
size with a zoom-interpolated `icon-size` expression on the layer (re-bake the PNG, don't just
change `icon-size`, if you need it crisp at a very different size):
- **Ships** `60×49` — length squashed from native 980×606 so the ship reads shorter (not
  pointy). `icon-size` stops (zoom 2→0.6, 6→1.0, 10→1.4) ⇒ ~15px tall zoomed out.
- **Containers** `80×80` square. `icon-size` stops (zoom 2→0.6, 6→0.8, 10→1.1).
Asset files/colors are in §10.

## 6. Vessel positions — computed once per refresh (no animation)

**There is no animation loop, and no ETA-change tracking.** The map simply renders each
vessel at the position implied by the **latest** `expected_portdate` (the most recent push
state). Positions are **static** between data refreshes — computed once when data loads, and
recomputed only when the data changes or the map view changes. The app keeps no prior ETA and
draws no "delayed/ahead" indicator; whatever the forwarder last reported is the truth it
shows. The feed updates ~3×/week, so a vessel's position barely moves between refreshes and a
continuous `requestAnimationFrame` loop would redraw imperceptible sub-pixel motion every
frame — it buys nothing.

### When to (re)compute positions

Compute the vessel/container GeoJSON and call `map.getSource(...).setData(fc)` only on:

1. **Data load / refresh** — initial fetch, and any later refresh (manual reload, or a
   Supabase realtime event if you add one). Recompute `progress` (§5.1) → `vesselPos`,
   `bearing` (§5.2) for every en-route shipment; place containers (§5.4).
2. **`zoomend`** — re-run the pixel-space container spiral (§5.4, and the vessel de-cluster
   §5.3 once added), since those depend on the projection, then `setData` once. The current
   code rebuilds everything on `zoomend` (cheap for our counts). Icon size is a layer zoom
   expression, so it needs no JS (§5.5).

That's it — no per-frame work, no `cancelAnimationFrame` to manage. `progress` uses the
client clock at compute time:
`progress = clamp((Date.now() − startDate) / (expected_portdate − startDate), 0, 1)`.

- Symbol rotation: `"icon-rotate": ["get", "bearing"]`; bearing is written once per compute.
- Containers (future/arrived) were already static — unchanged.
- Honest-position note: the dot is an **estimate** interpolated from ETD→ETA by distance, not
  a live GPS fix. Worth a small "estimated · updated <date>" caption in the UI.

## 7. Three-state logic (per shipment)

Decide state from today's local-midnight date:

| state | condition | placement | icon | color rule |
|---|---|---|---|---|
| **Future** | `startDate > today` | `polCoords` + spiral offset | container | blue |
| **Arrived** | `actual_portdate` set and `≤ today` | `podCoords` + spiral offset | container | `appointment_date` set → **green**; else days-at-CY `> 3` → **red**; else **blue** |
| **En route** | otherwise | interpolated `vesselPos` (estimated, static between refreshes) | ship | `arrival_notice === "yes"` → **green**; else **black** |

- days-at-CY = `floor((today - actual_portdate) / 1 day)`.
- transit days (future popup) = `floor((endDate - startDate) / 1 day)`;
  remaining (en-route popup) = `floor((endDate - today) / 1 day)`.

## 8. Sidebar & stats

Two stacked panels in a 380px-wide sidebar. Implemented as
[Sidebar.jsx](src/components/Sidebar.jsx), driven by `selected` state lifted to
[App.jsx](src/App.jsx) and updated on feature click.

- **Selected shipment** (`updateSidebarSelected` in the original): shipment, container,
  vessel, carrier, `POL → POD`, actual shipping, expected port date, actual port date
  (if any), arrival notice.
- **Snapshot stats** (`updateSidebarStats`) — counts over all shipments:
  - **Total** = number of shipments.
  - **On Water** = `actual_shipping` and `expected_portdate` set, `actual_portdate` empty,
    and `actual_shipping ≤ today ≤ expected_portdate`.
  - **Arrived** = `actual_portdate` is set.
  - **Past Free Day** = `last_freeday` set and `last_freeday < today`.

**Interaction** (implemented in [MapView.jsx](src/components/MapView.jsx); details fill the
**sidebar**, not a popup):
- **One selection at a time**, click to **toggle** (clicking the selected feature deselects;
  clicking empty water deselects). Selecting **flies to** the feature
  (`flyTo`, `zoom = max(current, SELECT_ZOOM)` — only zooms in, never out).
- **En-route ships:** selecting draws a dashed **remaining-route** line (`vesselPos → POD`) via
  a `line` layer (`line-dasharray`) whose GeoJSON source is swapped on click.
- **Arrived containers:** selecting fills the sidebar + flies to, but draws **no** dashed line.

**Planned — port summary (not built):** clicking an individual container is low-value and
fiddly (overlapping icon hit-boxes). Intended model: **click a port → aggregate summary** of
its containers (total, aging >3 days at CY, recently arrived, has-appointment, past-free-day,
oldest dwell, shipment list). Map = geographic aggregate ("what's piling up where"); search =
individual lookup. Ships stay individually selectable. Cheapest first step: route any
container/port click to the port summary (dissolves the click-ambiguity).

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

## 10. Icon assets

Icons live in [public/icons/](public/icons/), **pre-baked with Pillow** from the originals
(§5.5) and registered with `addImage(..., { pixelRatio: 2 })`:

| image name | file | used for | selected when |
|---|---|---|---|
| `shipDefault` | `nauticalDefault2.png` | en-route ship, default | `arrival_notice ≠ yes` |
| `shipGreen` | `nauticalGreen2.png` | en-route ship | `arrival_notice = yes` |
| `containerBlue` | `blueContainer.png` | arrived container | recent (≤3 days at CY) |
| `containerGreen` | `greenContainer.png` | arrived container | appointment set |
| `containerRed` | `redContainer.png` | arrived container | > 3 days at CY |

- **Default ship = MarineTraffic green.** `nauticalDefault2.png` is `nauticalWhite2.png`
  recolored (Pillow `colorize`: dark-green outline `(8,106,8)` + light-green fill
  `(144,238,144)`, sampled from a MarineTraffic marker) and squashed to 60×49. `nauticalWhite2`
  stays in the repo as the recolor source (unused at runtime).
- Register each PNG with `map.loadImage('/icons/<file>')` + `map.addImage(name, img, {
  pixelRatio: 2 })` before the symbol layers, then select per feature via
  `"icon-image": ["match", ["get", "color"], …]`.
- The ship PNGs point "east" at 0° — the layer rotates by `bearing − 90` (written to each
  feature's `rotation` property); verified against the real sprite.
- **Casing:** the file is `blueContainer.png` (lowercase `b`); the Leaflet source's
  `Bluecontainer.png` only worked because Windows is case-insensitive. Use the exact name.
- Routes are **not** bundled — they come from Supabase (§4).

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
2. **Fast lookup.** A customer calls asking how a shipment is doing. Today ops identify the
   item, then look it up in **NetSuite** data tables. Replace that with a search over
   container # / HBL / MBL / PO / item name / final port that jumps straight to the
   shipment's current progress and latest ETA (`expected_portdate`).

**UX stance: search/list-first, map-linked.** Lookups are best served by *search → result
row → detail*, not by hunting on the globe. Grow the sidebar into **search bar → filter
chips → results list → selected detail**; a row click does `map.flyTo` + opens that vessel's
popup. The map and list read from one shared filtered dataset.

**Roadmap**
- **Phase 1 (first deployment):** manual thrice-weekly snapshot push to Supabase (§14); the
  dashboard reads shipments/routes and renders the fleet as static estimated positions (§6),
  with issues/notes and search/filter. This is the current target.
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
  `actual_shipping` (ETD), `expected_portdate` (latest forwarder ETA — the push overwrites it
  freely; drives map position, §6), `actual_portdate`, `appointment_date`, `arrival_notice`,
  `last_freeday`, `hbl`, `mbl`, plus a denormalized `search_text` blob, and `first_seen` /
  `last_updated` timestamps. Consider an `active` flag (see ingestion) instead of deleting
  departed shipments.
- **line_items** — container → many items (one-to-many). Fields: `id`, `container` (FK),
  `item_name`, `po_number` / `purchase_order`, `customer`, `qty`. Powers item / PO /
  customer search; fold these into the parent's `search_text`.
- **issues** — collaborative writes (the app's only client write-path). Fields: `id`,
  `shipment` (FK → shipments PK), `author`, `created_at`, `category` (enum:
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

### ETA — a single date
**`expected_portdate`** is the only ETA: whatever the latest push reported. The snapshot
overwrites it freely; it sets the vessel's position on the map (§6). The app keeps **no prior
ETA, no baseline, and no delay/“behind plan” indicator** — it always shows the latest reported
truth. (Comparing against an original/planned ETA is intentionally out of scope for now.)

### Ingestion — Phase 1 (manual Python push), Mondays / Wednesdays / Fridays
1. Pull forwarder updates, run the existing inbound report → a **snapshot** file (updated
   dates + newly-documented shipments, i.e. additional vessels/containers/markers).
2. Push to Supabase by **upserting `shipments` on the `shipment` PK** (and `line_items`).
   New shipments insert (new markers appear); existing ones update their dates.
   - **Do NOT delete-all-then-insert.**
   - **Do NOT touch the `issues` table** — issues are keyed to the `shipment` id (the
     NetSuite-generated Inbound Shipment number: stable + unique) and must survive every
     snapshot.
   - For shipments absent from the latest snapshot (delivered / aged out), flip an `active`
     flag rather than deleting, so their issue history is retained.

### Snapshot cadence
New snapshots arrive **3×/week, not continuously**, so vessel positions only change on a data
refresh. The map just renders the latest pushed `expected_portdate` for each vessel as a
**static** position (§6) — no prior state is kept and no change is tracked between pushes.
