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

**Dev instrumentation** (in [MapView.jsx](src/components/MapView.jsx), guarded by
`import.meta.env.DEV`, so Vite folds it to `false` and the minifier removes it — verified absent
from `dist/`):

- **`window.__map`** — a console handle on the map. It lives in a `useRef` and never in state (§3),
  which also puts it out of devtools' reach, so without this there is no way to run
  `__map.getZoom()` / `__map.setZoom(4)` / `__map.getCenter()` while tuning anything zoom-staged.
- **A zoom readout** bottom-left: current zoom, the card's scale/px/form, the vessel `icon-size`,
  and `devicePixelRatio`. The last two matter because both the icon bake (§5.5) and the card sizing
  are judged per-DPR. Note the ship figure is a **mirror** of the layer expression computed in JS,
  not a readback — both are linear interpolation over the same stop table, so they agree today, but
  it would go stale silently if that layer switched to an exponential base.

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
  **One deliberate exception:** port container cards are DOM markers, because there is one per
  *port* rather than per container and the trade inverts — see §5.4 and CARDS.md §5.
- **Style: self-authored, no vendor basemap.** [src/map/basemapStyle.js](src/map/basemapStyle.js)
  exports `buildBasemapStyle()`, a full MapLibre style object passed straight to `style:`
  (the option takes an object, not just a URL — that's the whole seam). It draws water, a flat
  land, water and roads from OpenMapTiles plus the continental-US contour, and
  **no text whatsoever**. Every label
  on the map comes from the curated list in [src/data/places.js](src/data/places.js). This
  replaced Carto Voyager, which drew every country border and thousands of place labels that
  competed with the vessel icons. See §15 for the full stack and how to regenerate its assets.

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
Routes are **fetched at runtime from `public.sea_routes` in the shared Supabase project** — the
RatesApp consolidation (`sfozxpibfpqsdlxoheyl`), *not* a project of this app's own. The original
standalone project was deprovisioned and its `routes` table came across renamed to `sea_routes`.
(The prototype's `ocean_routes.geojson` is *not* copied into this app.) Actual columns:

- `origin_port`, `destination_port` — port name strings (generated by `searoute` in Python)
- `route_geom` — `geometry(LineString, 4326)`, `[lng, lat]` ordered POL→POD
- `geojson` — a GeoJSON `Feature` wrapper (a fallback; see below)
- `routing_variant` — see below. `distance_km`, `duration_hours`, `generated_at` are unused here.

**`routing_variant` is pinned to `'default'`, deliberately.** The PK is
`(origin_port, destination_port, routing_variant)` because one port pair can be sailed two
genuinely different ways — Nhava Sheva → Rotterdam via Suez or via the Cape. Every row is
`'default'` today, so an unfiltered query still works; but `routesByKey` is keyed on `"POL - POD"`
alone, so the moment variant rows land, two rows collide on one key and the last silently wins.

**Both geometry columns are selected** because PostgREST can return a PostGIS column as GeoJSON
*or* as hex WKB depending on configuration; `normalizeRoute` falls back
(`row.route_geom ?? row.geojson?.geometry`) and survives either. If `route_geom` is confirmed to
arrive as GeoJSON, drop `geojson` — it duplicates the full geometry across ~180 rows.

**Access:** `sea_routes` has RLS enabled. Its original grant/policy were `authenticated` +
`my_org_type() = 'internal'`, which this app cannot satisfy — it uses the anon key with no sign-in.
Reading it needs **both** a grant and a policy for `anon`:

```sql
grant select on public.sea_routes to anon;
create policy sea_routes_anon_read on public.sea_routes for select to anon using (true);
```

That repo's migration history is drifted — **`supabase db push` must not be run on it**; apply SQL
in the editor and add a migration file afterwards as a record.

**READ IN PAGES, NOT IN ONE SHOT.** PostgREST caps a response at **1000 rows** and says nothing
about it — no error, no flag, just a shorter array in no particular order. `sea_routes` held 486
rows when this hook was written, so a single `select` was fine; the port matrices took it to
**2,373**, and the app quietly kept seeing 1000 of them. The lane that fell outside happened to be
`Nhava Sheva - Pipavav`, so a vessel whose first leg had no geometry was dropped from the map
entirely, with nothing anywhere saying why. Use `fetchAllRows` from
[lib/supabase.js](src/lib/supabase.js) for any table read without a narrow filter.

[useRoutes.js](src/hooks/useRoutes.js) normalizes each row to `{ key, coordinates }` keyed by
`normalizeKey("origin - destination")`. Derive port points from the geometry:
**`polCoords = coordinates[0]`, `podCoords = coordinates[coordinates.length - 1]`** (no separate
columns). Fetch once on mount; join to shipments by key; feed the vessel/container sources.

Two data caveats: routes are searoute graph paths, so some lanes take non-obvious passages —
that's data, not a plotting bug. And port names in this table are **not normalised** at the source
(`Singapore`, `SINGAPORE` and `Singapore, Singapore` are three legal origins), so a lane that fails
to join is more likely a name mismatch than a missing route.

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

> **Once per LEG, not once per voyage.** A sailing that calls at several ports is a chain of legs
> (§8), and `positionOnItinerary` picks the leg today falls in before running exactly the maths
> below within it. There is no new geometry — the multi-drop case is the single-lane case applied
> one leg at a time. `remaining` becomes one coordinate array **per remaining leg**, which is why
> selecting a ship short of its first call draws two dashed lines rather than one.

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

### 5.4 Port container cards — three isometric stacks per port
Arrived containers are drawn as **one card per discharge port**, split into **three arms radiating
from a shared centre — blue NW, red NE, green S**, 120° apart on screen. Each arm is its own stack:
two containers wide, growing upward. A port with no containers renders nothing, and an empty arm
draws nothing — only real containers are ever painted.

**Two forms, chosen by zoom.** At or above `FIRST_LABEL_ZOOM` (= `PORT_BAND_START`, the zoom the
first port label appears at, exported from [places.js](src/data/places.js) rather than copied) a
port draws the card. Below it, a neutral **count bubble** with the port's total and no status
breakdown: zoomed out the question is "where is the volume", and a dozen stacks at 6 px per box is
clutter, not information. The swap runs on `zoom` rather than `zoomend` so it lands mid-gesture,
guarded on the mode actually changing. See CARDS.md §5.
Full reference in **[CARDS.md](CARDS.md)**; implementation in
[src/map/portCard.js](src/map/portCard.js) + `syncPortCards` in
[MapView.jsx](src/components/MapView.jsx).

**This replaced a golden-angle spiral of one sprite per container.** The spiral answered the wrong
question — you counted scattered boxes instead of reading a port's load at a glance, and a busy
port became a smear.

- **Group by discharge port**, regardless of route / port of loading. All containers at a port
  share one anchor: **the port's own coordinate — the exact point its label is drawn at**, via
  `portPointsByKey` in [places.js](src/data/places.js), which derives it from `buildPlacesFC`'s own
  output so a card and its label cannot drift apart. The **last vertex of the sea route** is only a
  fallback now: those are `searoute` graph paths, so the endpoint is a lane node near the port
  rather than the port (2.8 km out at New York). A card that falls back is named in the DEV log —
  it means the POD matched no row in `us_ports` / `world_ports`, nearly always a drifted name.
- **Arrived containers are resolved before the route lookup**, so a lane that fails to join no
  longer takes its arrived containers with it. A container at a port is placed by the port.
- **DOM markers, not a symbol layer** — a deliberate exception to §3, argued in CARDS.md §5. One
  marker per *port* (under a dozen) inverts the trade that rule is about, and buys vector crispness
  with no bake step plus a real click target for the §8 port summary.
- **The three arm directions are the isometric ground plane's own axes** — `-x` projects up-left,
  `-y` up-right, `+x+y` straight down, all at the same screen radius. Not an arbitrary rosette.
- **Position encodes status a second time, independently of hue** — which corner a pile sits in
  *is* its status. The frame is measured from all three slots whether or not they are occupied, so
  a lone pile is never re-centred and that signal survives.
- **The SVG viewBox does the shrink-to-fit**; `vector-effect="non-scaling-stroke"` keeps the
  outline from going sub-pixel on tall stacks — the §5.5 failure, in a different disguise.
- **The card is centred on the port exactly**, at the point the arms radiate from. `anchor` alone
  cannot do it — the shrink-to-fit moves that origin within the box as a port fills up — so
  `portCardSvg` returns a per-card translate with the markup. It previously hung by its bottom edge,
  which put New York's containers past Boston at z3.
- **Our transform goes on an INNER div, never the marker element.** MapLibre writes
  `element.style.transform` inline there, and inline beats a stylesheet rule — `--card-scale` was
  silently inert for several iterations because of this. See CARDS.md §4.
- **Cards do not scale with the map** the way sprites do: `--card-scale` on `.map-container` is
  driven from the `zoom` event on the old sprite curve (z2→0.6, z6→0.8, z10→1.1).

Future containers at the POL are **deferred** (not yet implemented).
Tunables: `CARD_BASE_PX` in MapView (the tri-arm card is ~2× wider than the single stack it
replaced, so it sits at 64 rather than 44), and `ARM_R` in portCard.js.

### 5.5 Icon sizing (baked PNGs + zoom-interpolated `icon-size`)
Icons are baked near display size and registered with `map.addImage(..., { pixelRatio: 2 })`, then
sized by a zoom-interpolated `icon-size` on the layer. Re-bake the source if you need it crisp at
a very different size — don't just change `icon-size`.

- **Ships** — **two size tiers**, both from [assets/vessel.svg](assets/vessel.svg) via
  `npm run build:icons`, swapped by an `icon-image` step at **z4**:
  - `nautical*2.png` — `66×55`, 2px stroke, `pixelRatio: 2`. Used z4 and above.
  - `nautical*2-sm.png` — `33×28`, 3.4 stroke, `pixelRatio: 1`. Used below z4.

  Both report **~33 CSS px logical width**, so one `icon-size` expression drives both and the
  switch changes outline *weight*, never size. `icon-size` stops
  (**1.6→0.48**, 2.2→0.62, **5.4→0.94, 11.2→1.0**), shared by the vessel and rail layers.

  **One long, nearly flat segment from 5.4 to 11.2**, replacing a climb to 1.4. Past ~z5 the map
  shows a coastline, then a port, then a terminal, and a marker that keeps growing through all of
  that stops being a locator and becomes an obstruction — the old curve reached 46 px, enough ship
  to cover the berth it points at. Holding near 1.0 lets the icon mark a place while the map
  describes it.

  **Spread wide on purpose.** A short band at the top was tried and reverted: it made the size
  change abruptly and, worse, made the curve *peak and come back down* — a marker that shrinks as
  you zoom in. Over 5.8 zooms it simply rises and never reverses.

  It settles at 1.0, which is the **33 px the artwork is baked at**, so at street zoom the sprite
  draws 1:1 and is never resampled up.

  The bottom segment is separate because below z2 the curve used to **clamp** at 0.6, so an icon at
  the fully-zoomed-out view was the same size as one at z2 — and down there it floats on an ocean
  with nothing to be read against, competing with the port bubbles rather than adding to them.
  **Both band edges are deliberate rejoins, not round numbers.** 0.62 is exactly what the old 2→6
  line evaluated to at 2.2, and 0.94 is exactly what the 2.2→6 line evaluated to at 5.4 — so each
  retune left everything outside its own band unchanged to the last decimal.
- **Containers** are no longer sprites — each port draws one isometric SVG card (§5.4, CARDS.md).

**The ships were rebuilt from vector because a raster master rotted the contour.** The old art was
a 980×606 original LANCZOS-shrunk to 60×49, and by the time it shipped the intended `#086A08`
outline existed in **zero pixels** — replaced by a 175-colour gradient, 1px on the stern and 2–3px
on the diagonals with irregular stair-stepping. Under `icon-rotate` that read as a vsync tear.
Three rules keep it fixed:

1. **The SVG is the master.** Never edit the PNGs; edit `assets/vessel.svg` and re-bake.
2. **Rasterise once, at target size.** Don't render big and downscale — analytic antialiasing
   beats resampling, and resampling is what caused the fault.
3. **Keep the ~3px transparent margin and the 2px stroke floor.** Both are load-bearing; §10.

**Why two tiers, measured on the real renderer.** MapLibre scales sprites with GPU bilinear
filtering and **no mipmaps**, so a single 66px bitmap is minified hard at low zoom. At
`devicePixelRatio 2, z1.5` it drew at ~40 device px, putting the 2px stroke at **0.94 device px** —
the dark contour survived on barely half the silhouette, in *different* places at each heading, so
it crawled as ships turned. Baking a second bitmap near its display size (so the GPU barely
resamples) with a proportionally heavier stroke took the outline from 172 to **326 device pixels**
at the same peak darkness. Note a LANCZOS simulation said 2× displays would be fine; they are not
— **measure this on the real renderer at the real `devicePixelRatio`, not in Pillow.**

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

That's it — no per-frame work, no `cancelAnimationFrame` to manage. `progress` is measured at the
client's **local midnight**, not at the current instant:
`progress = clamp((todayLocalMidnight − startDate) / (endDate − startDate), 0, 1)`.

**Midnight is the whole point, and it was a real bug.** `parseYMD` returns local midnight, so
comparing against `Date.now()` measured a timestamp against two midnights: a container was already
part-way down its leg on the day it started, by however far through the day it happened to be.
Measured on a 13-day rail leg at 19:39, that put the marker at 14% instead of 7.7% — about 70 km
past where the dates said it was. **The inputs are dates**; a day is the finest thing this data
knows, so interpolating inside one is precision it does not have. Progress now steps once a day,
which is also the cadence the feed updates on.

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
| **En route** | otherwise | interpolated `vesselPos` (estimated, static between refreshes) | ship | **any** container aboard with `arrival_notice === "yes"` → **green**; else **amber** |

The hull is one object holding many containers, so arrival notice is an *any* over the group — the
per-container breakdown is what the tray is for (§8).

### The inland leg — a fourth state

**`port_of_discharge` vs `Lastcy` is the whole rule.** Equal means the box is delivered at the port
it landed at and the table above is complete. Different means it has an **inland leg**: it moves by
rail to an interior yard, and the port is a waypoint.

**Compared on CANONICAL keys, not raw names** (`facilityKey`, §8). A box discharged at Los Angeles
and delivered to a Long Beach yard has crossed a harbour — 4.6 km — not the country. The plain name
comparison called that intermodal and drew a railcar creeping between them for a fortnight. Inside
one complex it stays an ordinary arrival: `actual_portdate` decides when it lands, dwell counts from
that date, and it joins the complex's single card. A genuine inland leg out of the same port
(Los Angeles → Cincinnati) is unaffected.

| state | condition | placement | icon |
|---|---|---|---|
| **rail** | `actual_portdate` set, POD ≠ Lastcy, today < `expected_lastcy_date` | interpolated along the `rail_route` lane | railcar |
| **arrived (inland)** | as above but today ≥ `expected_lastcy_date` | **the Lastcy facility's own coordinate** | container card |

- Progress runs `actual_portdate` → `expected_lastcy_date`, using the same `computeProgress` /
  `positionAtProgress` the vessel uses. It is the same problem: a thing travelling a polyline
  between two dates.
- **Dwell is measured from arrival at the facility the box is actually in** — `arrivedAtFacility()`
  returns `expected_lastcy_date` for an inland box, `actual_portdate` for a port one. Without that
  split, a box that cleared its seaport in June arrives at its inland yard already reading
  `AT YARD 84D`.
- **`expected_lastcy_date` is an estimate and there is no `actual_lastcy_date`**, so the box appears
  at the yard on that date whether or not it truly arrived — the same honest-position caveat as §6.
- A shipment with an inland leg carries **`sea_route` + `rail_route`** instead of `route`. Read
  `s.sea_route ?? s.route` for the sea lane: reading only `route` silently drops an intermodal
  shipment that is still at sea, because the lane lookup misses and the loop skips it.

- days-at-CY = `floor((today - actual_portdate) / 1 day)`.
- transit days (future popup) = `floor((endDate - startDate) / 1 day)`;
  remaining (en-route popup) = `floor((endDate - today) / 1 day)`.

## 8. Holders, the tray & stats

**The unit of interaction is a HOLDER, not a container.** A container is always somewhere, and that
somewhere is a **vessel** carrying it, a **train** carrying it, or a **facility** it is sitting at —
which is either the port it will load from or the yard it has landed at. All hold 1..N. Clicking any
of them fills the sidebar with a **tray** — one card per container it holds.
[src/lib/holders.js](src/lib/holders.js) owns the grouping and knows nothing about the map.

| holder | grouped by | anchored at |
|---|---|---|
| vessel | `vessel + POL + ETD` — a **sailing**, not a name and not a lane (see below) | interpolated along its **itinerary** (§5.1) |
| rail | `POD + Lastcy + actual_portdate + expected_lastcy_date` — a **movement**, not a lane | interpolated along the rail lane (§7) |
| port | the facility the box is AT — discharge port, or inland yard once railed | the port's own coordinate (§5.4) |
| origin | `origin\|<load port>` — containers that have **not sailed yet** | the load port's own coordinate |

**`future` used to be drawn NOWHERE**, and that was a real hole rather than a deferral. The state
existed in `shipmentState`, `containerStatus` returned `NOT SAILED / ETD …`, `sortByPriority` gave it
a band and the Overview counted it — but `buildHolders` dropped it on `state !== 'enroute'`, so a
booked container was countable and searchable while being absent from the only place you would look
for it. It now sits on an **origin card at its port of loading**.

**Its own kind, not a port card.** A facility card says "these boxes have stopped and the question is
what to clear next", and its whole colour language is dwell: red at three days, green once an
appointment exists. A container waiting to load has no dwell and no demurrage risk, so folding it
into that vocabulary would state something false about it. The `origin|` key prefix also means a port
that is **both** an origin and a destination keeps two cards — not today's data, where load ports are
international and discharge ports are not, but the merge would silently mix waiting boxes with landed
ones and hand them one count.

**The holder key is prefixed; the ANCHOR is not.** Cards resolve their coordinate through
`portKey`, which is the bare `facilityKey`. Looking up the prefixed key in `portPoints` would miss
every time and report every load port as "not matched to a port row". A load port with no
`world_ports` row falls back to the first vertex of its own sea lane — the mirror of the `routeEnd`
fallback a discharge card uses.

**Drawn however far out the ETD is.** No horizon: a threshold would make a container silently
invisible until it crossed one, and put the Overview's `future` count back out of step with the map.

**Two-port complexes merge into one card.** `PORT_ALIASES` in [places.js](src/data/places.js) folds
Long Beach into `Los Angeles, CA` and Port Everglades into `Miami, FL`, because each pair works as
one gateway and their anchors are close enough that two cards collide — Los Angeles and Long Beach
are **4.6 km apart**. Grouping goes through `facilityKey()`, which resolves the alias, so it must be
used on BOTH sides of any comparison: a container whose `Lastcy` is Long Beach would never match a
card keyed on Los Angeles otherwise.

**Display only.** It merges the holder, its name and its anchor; it never rewrites a shipment, so
every container card in the tray still names the port its box is actually at. The alias VALUE must
be a real `us_ports` row or the merged card has nothing to anchor to.

**A SAILING IS A CLUSTER, NOT A KEY**, and that is the single most surprising thing in this file.
`assignSailings` groups per vessel and splits the run wherever two consecutive load dates are more
than **`LOAD_WINDOW_DAYS` (21)** apart.

**A SHIP CALLS AT MORE THAN ONE PORT AT BOTH ENDS.** It discharges at New York and again at Norfolk
nine days later; it loads at Nhava Sheva and again at Pipavav seven days later. Both broke a
different key:

| | it was | what broke it |
|---|---|---|
| `vessel + ETD + ETA + POL + POD` | one lane, one pair of dates | **multi-discharge** — differing POD split one hull into two markers, the second on a direct Cartagena → Norfolk lane the ship never sails |
| `vessel + POL + ETD` | one departure, many discharges | **multi-load** — the Nhava Sheva box and the Pipavav box differ in *both* POL and ETD, so no key read off one row could ever join them |

**And the feed has no voyage number.** Nothing in a shipment says which voyage it is — `mbl` is a
booking, not a hull. So the only thing separating "two load calls on one sailing" from "two sailings
of one ship" is how far apart the load dates are, and the threshold is a **judgement about the
trade, not a fact in the data**. WAN HAI 272 is the case that decides it: two real Bangkok sailings
99 days apart, which must not merge.

**Gaps chain off the PREVIOUS load, not the first.** A ship working three ports over eighteen days is
one voyage, and anchoring on the first load would cut it in half. The cost is that a long enough
chain of small gaps merges; at 21 days that needs a ship loading fortnightly for months, which no
round trip does.

### The itinerary

`buildItinerary` turns a sailing's ports into ordered **calls** and the **legs** between them. Six
rules, each of which is a way of getting it wrong:

1. **Built from every shipment on the sailing, in any state — not just the en-route ones.** Once the
   New York box reports an `actual_portdate` it stops being `enroute` and leaves the holder. If the
   itinerary were assembled from the manifest, the call would leave with it and the ship would snap
   back onto a direct line to Norfolk. **The manifest shrinks as boxes come off and grows as they go
   on; the itinerary does neither.**
2. **Calls at both ends.** Every distinct port of loading is a call dated by `actual_shipping`, every
   distinct port of discharge one dated by `actual_portdate` falling back to `expected_portdate`. So
   Nhava Sheva → Pipavav → Los Angeles is three calls and two legs.
3. **Loads always precede discharges**, ordered by date *within* each half rather than merged into
   one date sort. On an inbound feed that is simply true, and asserting it means one bad date cannot
   interleave a load into the middle of the discharge chain and send the ship back across an ocean.
4. **One call per port complex, through `facilityKey`** — the same fold used for cards and for the
   rail-leg test. This REVERSES the old rule, which kept Long Beach and Los Angeles apart because a
   holder could only ride one polyline. An itinerary has a leg per call, so that reason is gone, and
   keeping them apart now costs a spurious **13.6 km leg across one harbour** ordered by two ETAs a
   day apart. MSC ANNA in the fixture is exactly that case.
5. **Latest date wins within a call, at both ends** — a ship leaves when the last box is aboard, and
   leaves again when the last box is off.
6. **Legs are looked up by their two port NAMES**, `"<from> - <to>"`, not from a container's derived
   `route` field. For a single-load single-discharge sailing the two strings are identical.
   Otherwise they differ on purpose: the Norfolk box's `route` says Cartagena → Norfolk and the
   Pipavav box's says Pipavav → Los Angeles, while the ship sails Cartagena → New York → Norfolk and
   Nhava Sheva → Pipavav → Los Angeles. **The ship's own path is what gets drawn.**

**The port-to-port legs are real geometry, and they exist because something generates them ahead of
time.** No shipment is ever booked "Nhava Sheva to Pipavav", so nothing in the feed would ever ask
for that lane — `polylines/populate_port_matrix.py` builds the full **2,256-pair matrix** over the
48 ports the map shows (33 `us_ports` type P, the 13 in `map_loading_ports`, and Cai Mep and Vung
Tau passed with `--port` because they are transshipment ports the load-side view cannot see). `New York, NY -
Norfolk, VA` is 568.9 km and `Nhava Sheva, India - Pipavav, India` is 460.4 km, not guesses.

**A missing leg truncates the chain; it does not delete the ship.** Keep the calls that resolve, hold
the hull at the last reachable one, and set `missingLeg` for MapView to warn on. The containers are
still aboard and still in the tray — the map has only stopped claiming a path it has no geometry
for. A missing **first** leg still yields no holder, which is the old "no route, no marker" rule.

**`activeLegAt` decides which leg the ship is on, and BOTH `holders.js` and `MapView` call it** —
holders for the tray's `etd`/`eta`, MapView for the icon. One function, because a second copy is
exactly how the stats panel and the map came to disagree about `arrived`: the tray would name one
leg's dates while the hull sat on another's. The holder's `etd`/`eta` therefore describe the
**current leg** — past New York, the ship departed New York and is due at Norfolk.

**A blank POL is fatal, a blank ETD is not.** Without an origin there is no first leg to look up.
Without a departure date the lane is perfectly known and only the progress along it is not, so the
leg is built with a null start, `computeProgress` returns 0, and the hull sits at the load port. The
alternative would take the container off the map altogether — it is `enroute`, so no port card would
catch it either.

**The dates are compared as RAW STRINGS** in the key. Same `YYYY-MM-DD` field, same feed, so equal
sailings give equal keys; parsing first would only add a way for two identical strings to disagree.

**Any of the three missing falls back to the shipment id**, so that row stands alone. Unnamed rows
would otherwise collapse into one ghost ship, and two unknown dates are not the same date.

**The tray shows one line per LANE ABOARD, not the joined chain** — `holder.manifest`:

```
Cartagena, Colombia - New York, NY    3 containers
Cartagena, Colombia - Norfolk, VA     1 container
```

Each line names the lane **the box was booked on** — its own load port to its own discharge port.
Not the sailing's first call: on a multi-load sailing the Pipavav box was never at Nhava Sheva, and
reading "Nhava Sheva - Los Angeles" against it would be false. Built from the manifest, so a lane
with nothing aboard is simply absent and the tray reads as work outstanding rather than history;
ordered by the itinerary, so the lines run in the order the boxes will land. `subtitle` still
carries the full chain and is what the DEV logs print.

**`vesselSplits` got sharper.** While a holder was one voyage, one name in two places could mean
"two sailings" *or* "one sailing cut in half by its own PODs", and the log could not tell you which.
Now a sailing carries its whole itinerary, so only the first reading survives: two holders of one
name are two departures. Often simply true — a ship really does sail many voyages.

**The `lanes` mixed-lane warning is gone, replaced by the missing-leg warning.** It fired when a
holder's containers named more than one `route`, which was a fault while a holder rode one polyline.
A multi-drop names a different lane per container *by design*, so that check would now cry wolf on
every one. What actually degrades the drawing is a leg with no geometry, and that is what MapView
warns about. The rail side keeps `lanes` unchanged — a train is still one lane, and `rail_route` is
still a derived field that can contradict its own endpoints.

**THE INLAND LEG GROUPS THE SAME WAY, ONE LEG LOWER:**
`port_of_discharge + Lastcy + actual_portdate + expected_lastcy_date`. Four fields rather than five
because a train has no name in this data — the two facilities are the endpoints of the rail lane
exactly as POL and POD are of the sea lane, so they do the work `vessel` cannot. It replaced
`rail_route + both dates`, which keyed on the derived lane string rather than the facilities it is
assembled from: the same fault the sea side had.

The dates matter as much here as at sea, and for a sharper reason: boxes that left the port on
different days are at genuinely different points on the track, so merging them would draw half the
containers hundreds of miles from where they are.

`normalizeKey`, not `facilityKey`, for the reason above — with one extra guard worth knowing:
`isIntermodal` has *already* compared these two through `facilityKey` to decide the leg is rail at
all, so a move inside one port complex never reaches the key (§7). What is left are genuine inland
legs, where `Los Angeles → Denver` and `Long Beach → Denver` are two different tracks.

**Both holder kinds carry `lanes`, and MapView warns on either.** The failure is identical on both:
the group agrees on its endpoints by construction, but `route` / `rail_route` are *separate, derived*
fields and are what the polyline is looked up by, so one contradicting its own endpoints puts the
marker on a line its containers are not on.

**Guarded by `npm run test:grouping`** ([tools/check-voyage-grouping.mjs](tools/check-voyage-grouping.mjs)),
133 checks over the rules — each field varied one at a time, every blank fallback, the LA/Long Beach
fold, spelling drift, the multi-drop suite (two calls from one departure, ordering by date rather
than row order, the itinerary surviving a discharge, a truncated chain, the tray's per-lane lines),
the multi-load suite (two load ports on one hull, the 21-day window either side of the line, gaps
chaining, and a ship mid-load with one box aboard and one still on the quay), the two-origins-and-
two-destinations case where loads and discharges interleave across four calls no two boxes share,
`positionOnItinerary` putting the hull on the right leg, the origin cards (including a port that is
both an origin and a destination), and the live fixture. Running the
app demonstrates the vessel match succeeding and almost nothing else — not one of the ways either
rule must fail, and not the rail rule at all. Every one of those failures is silent: group two
containers that are not on one hull and you get a confident badge over a position right for only one
of them; split two that are, and the marker appears twice. Neither throws, and neither looks wrong.

**One feature per holder**, so a vessel carrying three containers is one icon whose badge reads 3.
That badge was a hardcoded `MOCK_CONTAINER_COUNT = 7` for several iterations while every vessel in
the data held exactly 1 — grouping is what made it honest.

### The panel is resizable — [panelWidth.js](src/lib/panelWidth.js), [Sidebar.css](src/components/Sidebar.css)

**380px to 760px, two columns of cards from 660px.** A fixed panel is right while the map is the
subject and wrong the moment it is not: working a search result list means reading one card-wide
column against a map nobody is looking at. Dragging the right edge trades map width for list width.

**The stops are arithmetic, not taste.** A card gets ~356px today (380 minus the list's 12px padding
either side). At the 760px stop two columns come out at **~363px each — wider than the single column
is now**, so doubling is exactly the width at which a second column costs nothing. The 660px
threshold puts them at ~313px, 12% tighter than today, so the second column arrives while there is
still drag left rather than in the last few pixels.

**Three decisions worth keeping:**

- **The width is a CSS custom property**, and the two-column switch is a **container query on
  `.tray__list`** — not a class React sets. The query asks how much room the cards actually have,
  after padding, rather than trusting a number derived from the panel width somewhere else. There
  is no second source of truth to fall out of step.
- **The drag writes to the DOM, not to state.** `Sidebar` renders every visible container card;
  setState on each `pointermove` would re-render that list 60×/second for a number only CSS reads.
  The handler sets the property on the node through a ref; state and `localStorage` are written
  once, on release.
- **Both lists get it free.** The holder `Tray` and the search `Results` render into the same
  `.tray__list`, which is the case the feature exists for.

`clampWidth` turns anything non-finite into the minimum, because **a NaN width does not throw** — it
reaches CSS as an invalid declaration the browser silently drops, leaving the panel at whatever the
stylesheet last said. Storage is guarded exactly as [notes.js](src/lib/notes.js) guards notes, and
for the same reasons. Both are covered by `npm run test:panel`.

**The map needs no code.** MapLibre 5.24's `trackResize` defaults on and observes the container, so
the canvas follows; the existing `map.on('resize')` already recomputes `minZoom` from the new width.

### The tray — [Sidebar.jsx](src/components/Sidebar.jsx), [ContainerCard.jsx](src/components/ContainerCard.jsx)

- **Nothing selected** → the Overview counts below. Selecting a holder replaces them; the two
  never stack.
- **Holder selected** → header (kind · name · count) over a scrolling list of container cards.
  Cards show container no + status chip, shipment/vessel, route, dates, free day and appointment,
  with an items summary; clicking one **expands it in place** for carrier, forwarder, HBL/MBL and
  the item lines.
- **A PORT tray and SEARCH RESULTS are both ordered by PRIORITY; a vessel or rail tray is not.**
  `sortByPriority()` in [vesselMath.js](src/lib/vesselMath.js) sorts into **five bands**:

  | band | | within it |
  |---|---|---|
  | 0 | **red** — at a yard, past its free time | longest dwell first |
  | 1 | **blue** — at a yard, not yet late | longest dwell first |
  | 2 | **green** — at a yard, appointment booked | longest dwell first |
  | 3 | **moving** — on a ship *or* a train | soonest arrival first |
  | 4 | **future** — not sailed | soonest departure first |

  **One function serves both panels deliberately.** A container has one place in the queue, and it
  must not depend on which panel you found it through. A port tray only ever holds `arrived`
  containers, so it only ever shows bands 0–2 — bands 3 and 4 exist for search results, and are
  reachable *only* through search.

  The distinction against a VESSEL tray is what the tray is *for*. A vessel tray is a **manifest**
  — everything in it is at sea on one voyage, in the same situation, so the id order it arrives in
  is as good as any and stays comparable between refreshes. A port tray or a result list is a
  **worklist**: the order is the answer to "what do I deal with next". Red is aging past its free
  time and may already be accruing demurrage, blue is sitting but not late, green has an
  appointment and is handled for now — and the longest-sitting box in a band is both the most
  expensive and the likeliest to be forgotten.

  **THE BAND COMES FROM `shipmentState`, AND ONLY THEN THE TONE FROM `containerStatus`.** That
  order is the trap: `containerStatus` returns tone `blue` for an en-route or on-rail container
  too, so ranking on tone alone files every ship under "blue containers at a yard". Invisible in a
  port tray, where everything is arrived — wrong the moment a search returns a mixed list.

  **Rail and sea share band 3, on one axis: when the box actually lands.** A rail leg arriving in
  two days is more imminent than a ship four weeks out, and separate bands would have said
  otherwise. The date is `finalYardEta` — for a port-delivered container that *is* the vessel ETA,
  and for an intermodal one it is the inland CY date. It is also what the Overview's
  `Arriving next 7 days` row counts, so the list and the count agree. A missing date sorts to the
  **bottom** of its band (`Infinity`, not `0`): a blank is not an imminent arrival.

  **Sorted in the tray, NOT in holders.js.** The holder object is shared with the map, whose port
  card reads the same `containers` array; ordering it there would reach past the panel that asked.
  `sortByPriority` returns a **new array** for the same reason.

  **Tones come from `containerStatus`, never a rule written at the call site** — the same function
  the chip and the map card use, so the row at the top of the list is red in all three places. And
  dwell comes from `daysAtCY`, which measures from the facility the box is **actually in**: an
  intermodal container counts from the day it reached its inland yard, not from the day it cleared
  the seaport months earlier (§7). Sorting on the wrong one puts a box that landed two days ago at
  the head of the red band.

  Ties fall through to shipment id, which is what keeps rows from swapping places between
  refreshes. Guarded by `npm run test:order`
  ([tools/check-tray-order.mjs](tools/check-tray-order.mjs), 40 checks) — a wrong order is
  **invisible**: every row still shows the right container, the right chip and the right dwell, so
  the panel looks entirely correct while burying the box someone should be dealing with. The suite
  also asserts that widening the function for search left port trays byte-for-byte unchanged.
- **The header carries a VOYAGE LINE** — `ARRIVING IN 31 DAYS` opposite `ETA 30 Sep` — from
  `voyagePhase(etd, eta, today)` in [vesselMath.js](src/lib/vesselMath.js). It answers the question
  the header otherwise left to whoever was reading it: *how soon, or how long ago*. Under 50%
  elapsed the interesting fact is that it **departed**; at or over 50% it is that it is **arriving**.

  **The fraction is `computeProgress` — the same call that positions the icon** ([MapView.jsx](src/components/MapView.jsx)).
  Deliberate reuse, not coincidence: a second copy of a rule is how the stats panel and the map came
  to disagree about `arrived`. One number, or the sentence and the ship end up in different places
  on the same ocean.

  **OVERDUE IS TESTED BEFORE THE FRACTION, and that ordering is the whole subtlety.**
  `computeProgress` *clamps to 1*, so once an ETA passes the fraction stops moving and can no longer
  tell "lands today" from "three weeks late" — only the raw day delta can. Get it backwards and the
  panel renders `ARRIVING IN -1 DAYS` the first day an ETA slips, which is not a loud failure: it is
  a confident sentence about exactly the container that needs attention. `overdue` phrasing mirrors
  the container chips' `Xd past ETA` so the header and the cards beneath it speak the same way.

  **Vessels and rail share it unchanged** — both are a thing travelling between two dates, so it
  takes the two Dates rather than a holder (a train's are `actual_portdate` →
  `expected_lastcy_date`). **Ports get no line**: a facility is where boxes stop, not something in
  transit, and it would need a dwell rule instead. `voyagePhase` returns `null` there, and for any
  voyage missing a date — `computeProgress` returns 0 for a null input, which would otherwise render
  a confident `DEPARTED NaN DAYS AGO`.

  **`formatDay` spells the month out rather than calling `toLocaleDateString`.** A pinned `'en-GB'`
  was tried first, for deterministic day-month order — it renders September as **"Sept"**, four
  letters where every other month gets three. Locale data is not a fixed target either: Node's ICU
  and the browser's need not agree, so the app could render what the test never saw. The **year
  appears only when it differs from today's**, because transits here run to 114 days and a bare
  "15 Jan" read in August means *last* January.

  Guarded by `npm run test:voyage` ([tools/check-voyage-phase.mjs](tools/check-voyage-phase.mjs)),
  which exists because **the live fixture cannot reach two of the three branches** — both en-route
  vessels sat past halfway when this was written, so clicking around the app exercises `arriving`
  and nothing else.
- **The chip carries a WORD, not just a tone** (`AT YARD 83D`, `BOOKED`, `ON WATER`, `ON RAIL`).
  On the map, which arm a container sits in encodes status independently of hue (CARDS.md §2); a
  flat tray has no arms, so the label does that job there. `containerStatus()` in
  [vesselMath.js](src/lib/vesselMath.js) returns both; `containerColor` is now a wrapper on it.

  **The two dwell states share one wording, and that is the app's one concession on this rule.**
  Red used to read `AGING 83D` against blue's `AT YARD 2D`; both now say `AT YARD ${days}D` and
  only the tone forks. So the WORD no longer separates red from blue — the **number** does,
  exactly and by definition, since the threshold is three days: `AT YARD 12D` can only be red and
  `AT YARD 2D` can only be blue. That is real redundancy, but weaker, because it needs the reader
  to know the rule where "AGING" stated the conclusion outright. Two further channels carry it:
  the card's 2px tone bar, and the Overview's `Red containers` / `Blue containers` rows. If the
  distinction ever needs to be louder again, this is the line to change.
- **The card has TWO FACES, and a sticky-note icon flips between them.** Face one is the fact grid;
  face two is a notepad ([NotesPad.jsx](src/components/NotesPad.jsx),
  [notes.js](src/lib/notes.js)). Notes replace the facts rather than sitting under them — the tray
  fits about three cards, so anything additive makes the space problem worse. The icon carries a
  badge of **open** notes, which is the only sign from the facts side that anything is on the other.

  **Only the facts face is in flow**; the notes face is `position: absolute` over it. That is what
  keeps a card the same height whether it holds notes or not — stacking both in flow makes the card
  as tall as the taller one, and a shipment with two notes grew ~56 px and carried that dead space
  on the facts side too. A long note list scrolls inside itself instead.

  Notes are **free text plus a `done` flag**, not §14's `category`/`severity` enum: a reminder needs
  to be completable, and a required dropdown would tax every note for an urgent filter that does not
  exist yet. The record already carries §14's field names, so adding the enum later touches no
  stored data.

  **Notes are searchable** ([search.js](src/lib/search.js), kind `note`). Two things make prose
  behave unlike the identifier kinds beside it:

  - **The whole note is one index entry, not its words.** Tokenising would index `door` and
    `broken` separately and then be unable to answer `"container door"` — the phrase someone would
    actually type. Matching the raw text handles single words and phrases with one rule.
  - **Notes only match at a WORD BOUNDARY** (`wordish` on the entry). Identifiers match anywhere,
    because the middle of a reference number is a normal thing to half-remember; prose cannot use
    that rule, or `"on"` hits *container* and *broken* and buries the real results.

  The index is rebuilt from `notesRevision()` rather than only from shipments, so a note is
  findable the moment it is saved rather than after a reload. `search.js` stays pure — notes are
  passed in, never imported.

  **Storage is localStorage, deliberately** — `notes.js` is shaped like the Supabase table it
  becomes, so the swap is one file. There is no auth (§13) and the anon key ships in a public
  bundle from a public repo; granting anon `insert` would open a public write path into the
  database, which is a different thing from the read-only exposure that exists today. The cost,
  stated plainly: **notes live in one browser and the team cannot see each other's** until auth
  lands. Components read the store through `useSyncExternalStore`, so `listNotes` must keep
  returning a referentially stable array — it memoises for exactly that reason.

- **Family with RatesApp, not a copy.** Both apps load the *same* `linen` skin, so the resemblance
  is token + shape reuse — 2xl radius, fog-200 hairline, white ground, `--shadow-card`, a 2px
  status bar, mono uppercase micro-labels, tabular numerals. RatesApp reaches those variables
  through Tailwind; this app writes them longhand. They re-skin together.
- **`--font-mono` (DM Mono) is loaded at 400/500 ONLY** ([index.html](index.html)). Anything
  heavier is synthesised — the browser smears the 400 glyph, which at 9px reads as a malformed
  letter (capital S worst). Add size or tracking for emphasis, not weight.

### The Overview — [src/lib/stats.js](src/lib/stats.js)

What the sidebar shows when nothing is selected: the whole fleet in numbers, each one a way into
the containers behind it.

**Not "Snapshot", which this panel was called.** That word is already taken here — §12/§14 use it
for the thrice-weekly ingestion push — and it sold a live, clickable panel as a frozen moment.
"Overview" also names the CONTENT rather than the format: the big count and the two groups under it
already say this is a summary, so the kicker does not have to spend its one line saying so.

**Each group is a CARD**, on the surface the container cards already use — white ground, fog-200
hairline, `--radius-2xl`, `--shadow-card`, written longhand as in
[ContainerCard.css](src/components/ContainerCard.css). The Overview and the tray read as one family
of surfaces rather than two unrelated screens.

**THE GROUP COUNT NEEDS ITS OWN SIZE, and that is the trap this layout exists to fix.** It used to
sit *inside* the group title's `<p>`, inheriting the 9px mono micro-label treatment — so the number
summing four rows drew smaller than any row it summed, and the whole panel read flat. The header is
now a flex row with the label and the count as **siblings**, which is the only reason they can be
sized apart. Rendered sizes, and the order is the design: **total 30 › group count 24 › row number
15 › row label 13 › micro-label 10**.

**The group count is SANS, not the mono the row figures use.** At 24px the heaviest mono this app
loads (500) reads visibly lighter than the 30px sans total above it, and a 600 is not available to
reach for — the browser synthesises it and the glyphs smear (§8, DM Mono). Tabular numerals keep it
in the same numeric vocabulary without borrowing that problem.

**`.overview__total` needs TWO classes** (`.panel--overview .overview__total`). It is an `<h3>`, and
`.sidebar h3` is specificity 0,1,1 — so the single-class rule lost, and the `26px/700` written there
drew at `17px/600` from `032d14e` until it was measured. Only `font-variant-numeric` ever got
through, because that is the one property `.sidebar h3` does not set, which is exactly why the rule
looked like it was working. **`.tray__name` still carries the identical dead declaration** — same
one-line fix, not yet applied.

| group | rows |
|---|---|
| **In transit** | On water · On rail · Arriving next 7 days · Overdue |
| **At rest** | Red containers · Blue containers · Booked (green) |

**Every classification comes from `shipmentState` / `containerStatus`.** `computeStats` used to
live inside Sidebar.jsx with its own date arithmetic, and the two drifted: the panel reported
**8 arrived** while the map drew **7 at rest and 1 on rail**, because "has an `actual_portdate`"
counts a container riding a train as sitting in a yard it never reached. One state machine, or two
views of one fleet give two answers.

- **The at-rest rows are named the way ops talks** — "a red container", "a blue container" —
  rather than by state. Green keeps `Booked`, because that is the actionable fact about it and the
  only one of the three that says what to do rather than how long it has sat. Naming a row by its
  colour helps rather than hurts here: the word tells you the colour you would otherwise have to
  see. The tray chips read `AT YARD 83D` / `AT YARD 2D` — the same wording for both, with the
  dwell count this summary has no room for. So the two panels name the same container two ways
  on purpose: here by its colour, there by how long it has sat.
- **`Arriving next 7 days` is a ROLLING window, not the calendar week.** On a Friday it still
  includes next Monday, which is the point: a calendar week hides Monday's arrivals every Friday
  afternoon, exactly when someone is planning for them. The label is derived from `SOON_DAYS` so
  the window and the wording cannot disagree.
- **Arriving next 7 days / Overdue** use `finalYardEta(s)` — `expected_lastcy_date` for an intermodal box,
  `expected_portdate` otherwise, since for a port-delivered container the port date *is* the CY
  date. Built on `isIntermodal`, so the port-complex exception (§7) applies for free.
- **Overdue is shown even at zero.** "4 arriving soon" with the late ones quietly dropped would
  read as a clean pipeline; the row exists because sometimes it is not.
- **No per-port breakdown, deliberately.** The map is the per-port view — that is what the
  container cards are — and a table here would push the numbers only this panel can give below the
  fold.

**Every live count is a filter.** Clicking one fills the Results list and dims the map to match,
through the same `matchedIds` a search uses. `computeStats` returns the **id Set behind each
count**, so a click carries its own answer (`filter.ids`) rather than resolving through the search
index — recomputing "which containers are aging" at click time would be a third copy of a rule that
has already drifted once. A count of **zero is not a button**: nothing is behind it, and a filter
yielding an empty list reads as a bug rather than an empty set.

### Map interaction ([MapView.jsx](src/components/MapView.jsx))

- **One selection at a time**, click to **toggle**; clicking empty water deselects. Selecting
  **flies to** the holder (`flyTo`, `zoom = max(current, SELECT_ZOOM)` — only zooms in).
- **En-route vessels:** selecting draws the dashed **remaining-route** line (position → POD).
- **Rail movers draw their track ahead ALWAYS**, from the `rail-remaining` layer — every container
  on rail, not just a selected one, and only the portion still to travel. So it is styled quiet: a
  thin neutral dash, not the accent `remaining-route` uses, because that accent means "this is the
  one you picked" and using it here would say that about every rail leg at once. Selecting a
  railcar therefore fills the tray and does nothing to the map — its holder carries
  `remaining: null` so the selection line stays empty.
- **Ports:** selecting fills the tray and flies to; no dashed line.
- **Close ports are de-cluttered in pixel space** — `relaxOverlaps` in
  [declutter.js](src/map/declutter.js) pushes overlapping markers apart along the line between
  them, so relative bearing survives, and the offset goes on the `Marker` rather than the `lngLat`.
  DOM markers get no collision handling (§3); this is what pays for that. Offsets fall to zero on
  their own as zoom separates the ports. See CARDS.md §7.
- **Port cards are DOM markers, so hit testing goes on the SVG SHAPES, not the `<svg>`.**
  `pointer-events: auto` on an `<svg>` root makes its whole border box clickable like any replaced
  element — measured, a click on an empty corner of the 64px marker hit the card instead of panning
  the map. `visiblePainted` only governs SVG *child* shapes, so the root stays `none` and each
  polygon/circle/glyph opts in.

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

Icons live in [public/icons/](public/icons/), baked from source art (§5.5) and registered with
`addImage(..., { pixelRatio: 2 })`. **The ships come from [assets/vessel.svg](assets/vessel.svg)
via `npm run build:icons`. Containers are no longer icons at all — each port draws one
isometric SVG card (§5.4).**

| image name | file | used for | selected when |
|---|---|---|---|
| `shipDefault` | `nauticalDefault2.png` | en-route ship, **amber** | `arrival_notice ≠ yes` |
| `shipGreen` | `nauticalGreen2.png` | en-route ship, **green** | `arrival_notice = yes` |
| `railcar` / `railcarSm` | `railcar.png`, `railcar-sm.png` | the inland rail leg | `shipmentState = rail` |

- **Ships: edit [assets/vessel.svg](assets/vessel.svg), then `npm run build:icons`.** One polygon
  (bow apex, straight flanks, concave notched stern) drives both variants; the bake swaps two
  literal hex values, so the two can never drift out of shape. Outline `#086A08` on **both** — same
  contour, different hull, so they read as one family and the count numeral (which uses that colour,
  held constant across variants) stays true to the icon it trails. On amber it reads as a dark olive
  edge.

  **Two states, two colours: `#FFC220` amber = no arrival notice, `#23B14D` green = one received.**
  The default was previously a pale green, which made *both* variants green and left the whole
  signal resting on a lightness step — the thing the colour exists to say was the thing hardest to
  see. The pair is still separated by lightness as well as hue (amber L*≈81, green L*≈63), so it
  does not lean on the red-green axis, and the polarity is unchanged: the lighter hull is the one
  with no notice. Keep that gap if you retune either.
  - **The ~3px transparent margin is load-bearing.** MapLibre packs icons into a sprite atlas;
    with ink flush to the canvas edge, bilinear sampling under `icon-rotate` reaches past the
    icon and drags in its atlas neighbours. Don't tighten the viewBox.
  - **`stroke-width: 2` is a floor, not a style.** At `pixelRatio: 2` it lands at 1 CSS px. The
    old 1px stern edge fell below a device pixel once `icon-size` dropped to 0.6 and flickered as
    the icon turned. If it reads thin at the lowest zoom, raise the stroke — don't scale the icon.
- **Rail is a THIRD VARIANT of the same artwork**, not a second file. It shares the vessel's
  polygon exactly, so `icon-size`, both tiers and the z4 step are identical by construction rather
  than by being kept in step. An earlier version was its own blunt-car SVG; sharing the geometry
  removed the file that could drift.

  **`#4A4A4A` dark grey, and the one variant whose stroke is NOT the family green.** `#086A08` on
  a fill this dark is two close values, so the contour would simply disappear; white inverts it and
  keeps a hard edge against everything the marker crosses — pale land, blue water, the port cards,
  and its own track dashes.

  **Sharing a silhouette is safe here because the difference is LIGHTNESS, not hue** — L* 31.5
  against amber 81.8 and green 63.6. A hue step would not survive colour blindness; a 32-point
  lightness step survives anything.

  The value was **measured against its neighbours, not picked by eye**: `#2F2F2F` (L* 19.4) read
  as black rather than grey, and `#555555` (L* 36.1) sits 2.1 points off the `rail-remaining`
  dashes it rides on — the same value twice. `#4A4A4A` is 6.8 off those dashes, with the white
  contour covering the rest. Neutral R=G=B, like every grey on this map (§15).

  The rail count numeral takes `palette.railInk` (the FILL) rather than the contour the ships use,
  because rail's contour is white and a white numeral would be invisible. `railInk` must match the
  rail variant's fill in [tools/build-icons.mjs](tools/build-icons.mjs) — the bake carries its own
  literal, so the two are kept in step by hand.
- `nauticalWhite2.png` is the **obsolete** recolour source from the raster era; the SVG replaced
  it and nothing reads it at runtime.
- `exemplar.png` is a **MarineTraffic screenshot**, not an icon — 0% transparency, opaque
  `(244,244,245)` background. Visual reference only; nothing can be traced from its alpha.
- Register each PNG with `map.loadImage('/icons/<file>')` + `map.addImage(name, img, {
  pixelRatio: 2 })` before the symbol layers, then select per feature via
  `"icon-image": ["match", ["get", "color"], …]`.
- The ship PNGs point "east" at 0° — the layer rotates by `bearing − 90` (written to each
  feature's `rotation` property); verified against the real sprite.
- Routes are **not** bundled — they come from Supabase (§4).
- **Basemap geometry and glyphs** are bundled, in `public/data/` and `public/fonts/` — see §15.
- `blueContainer.png` / `greenContainer.png` / `redContainer.png` are **unreferenced** since the
  port cards landed (§5.4). Kept for one iteration in case the card needs rolling back.

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

> **Status check — most of this section is intent, not schema.** The app now points at the shared
> RatesApp project (`sfozxpibfpqsdlxoheyl`), and **only `sea_routes` exists there** (§4).
> `shipments`, `line_items` and `issues` have **not been created**. Nothing is blocked today —
> the map reads shipments from [src/data/inboundShipments.js](src/data/inboundShipments.js) — but
> treat the tables below as the design to build, and check what is actually live before coding
> against them. Note also that the shared project already has its own `us_ports`, `sched_vessels`,
> `drayage_routes` and `drayage_rates`, which may cover some of this ground already.

### Tables
- **shipments** — one row per container shipment = the current snapshot; **upserted** by the
  Python job on the shipment-id PK. Fields: `shipment` (PK), `container`, `vessel`,
  `confirmed_carrier`, route `key`, `port_of_loading`, `port_of_discharge`, `Lastcy`,
  `actual_shipping` (ETD), `expected_portdate` (latest forwarder ETA — the push overwrites it
  freely; drives map position, §6), `actual_portdate`, `appointment_date`, `arrival_notice`,
  `last_freeday`, `hbl`, `mbl`, plus `sea_route` / `rail_route` and `expected_lastcy_date` for the
  inland leg (§7), a denormalized `search_text` blob, and `first_seen` /
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

## 15. The basemap

Self-authored (§3). The style is built the other way round from a normal basemap: **nothing is
drawn unless we asked for it.** In particular it draws no text at all — OSM's own `place` and
`boundary` layers are simply never referenced, so the curated list in §15 "Labels" is the only
text that can appear.

### Two data sources, each doing what only it can

- **`openmaptiles`** — [OpenFreeMap](https://openfreemap.org)'s free, no-key planet tiles
  (OpenMapTiles schema, z0–14, overzoomed above). Owns water, land cover, roads and buildings.
  This is what makes street-level detail possible for drayage routes; a vendored GeoJSON
  coastline never could, at any file size.
- **`countries` / `states`** — our own vendored Natural Earth geometry. Owns the **continental-US
  contour** and state hairlines, because OSM's `boundary` layer is all-or-nothing and the entire
  point is that *one* country gets an outline. Fades out z8.5→10.

  **Only the US gets a contour, deliberately.** Goods move *into* the US, so the destination is
  the thing worth outlining. Outlining the origin countries (Colombia, India, Vietnam) was tried
  and **removed** — it cluttered the map and diluted what the border is for. The origin ports
  already read as labelled dots. Don't re-add them without a clear reason.

  The `COUNTRIES` list in [tools/build-basemap-data.mjs](tools/build-basemap-data.mjs) stays a
  list anyway, because it costs nothing and keeps the mainland-clipping logic honest. Entries are
  **mainland only** via one of two tools: `clip` (a bbox, when the offshore parts fall outside the
  mainland's box) or `minIsland` (drop detached landmasses under N km², when they don't — India's
  Andaman & Nicobar Islands share a longitude band with its northeastern states, so no bbox can
  separate them).

**Runtime dependency:** the map now calls OpenFreeMap for tiles — if that host is down, the
basemap is blank. `OMT_URL` in [basemapStyle.js](src/map/basemapStyle.js) is the single line to
change to move to self-hosted PMTiles or a commercial provider; the schema and every layer below
it stay identical. Glyphs and US geometry remain vendored under `public/`.

### Layer stack (bottom → top)

| layer | source | note |
|---|---|---|
| `land` | — | `background` in the land colour |
| `water`, `waterway` | omt | **water is painted ON TOP of a land background** — there is no land polygon to reference, only the absence of water |
| `park` | omt | fades in z9→10.5 |
| `building` | omt | z14+, **under** the roads |
| `countries-fill`, `us-states`, `countries-outline` | vendored | fade out z8.5→10; contour above state lines so the outer edge is unbroken. State lines are **dashed** — `line-dasharray` units are multiples of line width, not pixels, and butt caps are required (round caps extend each dash and quietly close the gaps). The contour is a **perfectly neutral** dark grey (R=G=B); warm greys read as reddish-brown at hairline widths |
| `road-minor` → `road-motorway` | omt | casing + fill per tier, minor first so majors win at junctions |
| `place-dots` | `places` | added in `load` **before** the vessels, so a ship covers a port |
| `remaining-route`, `vessels`, `containers` | — | the existing dashboard layers |
| `place-labels` | `places` | added **after** the vessels, so a name is never hidden |

Roads **cascade in by importance** rather than all at once, the way Google does it — motorways
z7.5→9, primary z9→10.5, secondary z10.5→12, minor z12→13. Turning them all on at one zoom
either clutters the metro view or leaves it empty.

### Colour: geography is deliberately NOT skinned

`mapPalette()` in [basemapStyle.js](src/map/basemapStyle.js) returns **fixed cartographic
colours** — Google-Maps-like blue water and warm off-white land — not skin tokens. An earlier
pass ran the map off the linen ramps (harbor water, fog land); those are built for UI surfaces
that sit behind text, so the map came out as one flat warm field with barely a visible coastline.
A map needs the familiar contract instead: blue reads as water, off-white reads as land.

The skin still owns everything that carries **app** meaning rather than geography — the dashed
route line and the accent ring on our own ports. Those go through `skinRgb()`, because skin
tokens are space-separated **RGB channels** (`"173 85 42"`) that MapLibre cannot parse directly.

### Labels

The only text on the map is the port list, and **all of it is database-driven** — nothing is
hand-typed. [src/data/places.js](src/data/places.js) shapes the rows into features; `kind` drives
colour and weight across **three tiers**.

| places | kind | source | selection | band |
|---|---|---|---|---|
| US ports & inland facilities | `us_port` / `rail_yard` | `us_ports` ([useUsPorts.js](src/hooks/useUsPorts.js)) | `type in ('P','I')`, **live** — minus `US_PORT_EXCLUSIONS` | z3–4 |
| International load ports | `intl_port` | `world_ports` ([useLoadingPorts.js](src/hooks/useLoadingPorts.js)) | **fixed** list `INTL_PORTS` | z3–4 |
| Transshipment ports | `ts_port` | `world_ports` (same hook, one query) | **fixed** list `TRANSSHIPMENT_PORTS` | z4–5 |

**The third tier is background, and `sort` is what keeps it there.** It arrives at Prince Rupert's
band (type P size M → z4), so it shares a band with the smaller US seaports rather than sitting far
behind them. It is painted quieter — Google's tertiary grey, a smaller ring, ~1.5px smaller text.

**`symbol-sort-key` is `sort`, NOT `minzoom`, and the two coming apart is the point.** They were the
same number while the tiers occupied separate bands, and that ranked them for free. Overlapping
bands mean a tie, which MapLibre breaks arbitrarily — sometimes dropping the port the work is about
in favour of one a box merely passes through. `sort` carries a fixed `TS_SORT_OFFSET` (100) for the
tier, so **every existing tag sorts ≤ 4 and every `ts_port` ≥ 104**: a load port keeps its name in a
collision whatever band either is staged into. Move `TS_BAND_START` freely; the ranking cannot
follow it into a tie.

Note the label layer's `match` expressions **fall through to the US styling** (bold, dark). A new
kind that forgets to name itself in all three — font, size, colour — gets the loudest treatment on
the map, which is the opposite of what a background tier wants.

**The expressions live in [src/map/placeStyle.js](src/map/placeStyle.js), not inline, and
`npm run test:style` validates them against the real style spec.** A malformed expression is the
quietest failure in this codebase: MapLibre rejects the LAYER and draws nothing, so lint passes, the
build passes, every other test passes, and the map is blank. Adding this tier nested a zoom
`interpolate` inside a `match` — forbidden, *"Only one zoom-based step or interpolate subexpression
may be used"* — and emptied the map of all 118 places, including the ones that had worked for
months. **A zoom `interpolate` must be the OUTERMOST expression**; to vary by zoom AND by kind,
interpolate on zoom and put the `match` in each STOP VALUE.

**Transshipment ports have no route geometry.** `populate_port_matrix.py` does not cover them, so a
sailing calling at one truncates its itinerary. Fine while they are only labels; if a vessel is ever
drawn calling there, they need adding to that matrix (`--port`).

**The two sides behave differently on purpose.** The US list is *live*: whatever operations add to
`us_ports` appears on the map with no code change, minus the explicit `US_PORT_EXCLUSIONS` set in
[places.js](src/data/places.js) — ports that are in the table but not part of this network. The international list is
*fixed*, so an unfamiliar port turning up in the schedules feed never silently rewrites the map —
adding one is a deliberate edit to `INTL_PORTS`. Coordinates always come from `world_ports`, so a
corrected coordinate takes effect with no redeploy.

Both lists match on `canonical_name` **exactly** (an `in` filter and a `Set` lookup), so a drifted
string fails silently — no port, no error. `useLoadingPorts` therefore logs any `INTL_PORTS` entry
it could not resolve, and the exclusion strings were each verified to exist before being added.

**`canonical_name` is both the label and the join key**, on both sides. It is the only clean form
in these tables — `name` is inconsistently cased row to row (`"LONG BEACH"` beside `"Cincinnati"`)
— and it already carries the state/country the way shipment data spells ports, so
`normalizeKey(canonical_name)` joins straight to `port_of_discharge` with nothing to assemble.

### Re-deriving the international list

`INTL_PORTS` was derived once from the distinct `schedules.port_of_loading` values. The app does
**not** read `schedules` at runtime — that table holds carrier codes and `raw_schedule` payloads,
and the anon key ships in the JS bundle, so it is not readable from the browser by design. (It
would also be wrong to try: PostgREST caps a response at 1000 rows, and `schedules` is the
warehouse — deduping in the browser would silently truncate and yield a *wrong* port list.)

The `map_loading_ports` view is the tool for re-deriving the list when the network changes. Query
it, paste the result into `INTL_PORTS`. It is not a runtime dependency.

```sql
-- Distinct load ports actually present in schedules, resolved to coordinates.
-- LOWER(TRIM(canonical_name)) is the same match set_schedule_geoms uses, and the
-- world_ports lower() index is built for it.
create or replace view public.map_loading_ports as
  select distinct on (lower(trim(s.port_of_loading)))
         w.canonical_name, w.latitude, w.longitude, w.country_name, w.size, w.unlocode
    from public.schedules s
    join public.world_ports w
      on lower(trim(w.canonical_name)) = lower(trim(s.port_of_loading))
   where s.port_of_loading is not null
     and w.latitude is not null and w.longitude is not null
   order by lower(trim(s.port_of_loading));

grant select on public.map_loading_ports to anon;
```

A view runs with its **owner's** privileges (`security_invoker` is off by default), which is what
lets it read `schedules` at all without granting anon on that table. Swap `schedules` for
`schedules_latest` to derive only currently-served ports rather than every port ever loaded from.

The runtime read of `world_ports` needs its own access — that table is global port reference data
(names, UN/LOCODEs, coordinates), and RLS is enabled on it:

```sql
grant select on public.world_ports to anon;
create policy world_ports_anon_read on public.world_ports for select to anon using (true);
```

**Audit the join** — the inner join silently drops any `port_of_loading` with no matching
`world_ports.canonical_name`, and port names in this data are known not to be normalised:

```sql
select distinct s.port_of_loading
  from public.schedules s
  left join public.world_ports w
    on lower(trim(w.canonical_name)) = lower(trim(s.port_of_loading))
 where s.port_of_loading is not null and w.canonical_name is null;
```

**`minzoom` stages places the way Google Maps does:** nothing is labelled at the fully-zoomed-out
world view, and places arrive in order of importance as you zoom (3 = major gateway, 5 =
secondary, 7 = inland yard). One filter, `['<=', ['get','minzoom'], ['zoom']]`, gates both the
dot and the name, so a place appears whole. Use **whole numbers** — MapLibre re-evaluates
zoom-dependent filters only at integer zoom levels, so 4.5 behaves exactly like 5.

`symbol-sort-key` is that same `minzoom`, so where two places are too close to both fit,
collision keeps the more important name and the lesser place stays a bare dot until you zoom
further (New York vs. the Northampton yard beside it). Note that `symbol-sort-key` only ranks
*within* a layer — if you ever split these into several label layers, MapLibre resolves
cross-layer collisions in favour of the **topmost** layer, which is the reverse of what you'd
expect and previously let a minor yard steal a major port's label.

### Regenerating the assets

```bash
npm run build:basemap   # public/data/*.geojson  (Natural Earth, via mapshaper)
npm run build:glyphs    # public/fonts/**/*.pbf  (SDF glyph ranges)
```

Both write committed files and are only needed when changing resolution or fonts.

- **`build:basemap`** ([tools/build-basemap-data.mjs](tools/build-basemap-data.mjs)) — builds
  *only* the country contours and US state lines, driven by the `COUNTRIES` list. `-innerlines`
  gives the state borders *without* re-drawing the outer contour, so the faint dashes never double
  up on the crisp outline over them. **Simplify percentages are set by the zoom these layers
  survive to, not taste** (higher % = more detail kept): 5% left the coast visibly faceted by z6,
  with Long Island a triangle. `precision` is not the lever; 0.0005° is ~55 m, well under a pixel.
  Note the two Natural Earth files disagree on field casing — `ADM0_A3` in admin_0, `adm0_a3` in
  admin_1.
- **`build:glyphs`** ([tools/build-glyphs.mjs](tools/build-glyphs.mjs)) — MapLibre draws canvas
  text from pre-baked SDF glyph PBFs and cannot use the skin's CSS font. These are **Noto Sans**,
  not the skin's DM Sans: baking an arbitrary TTF needs `fontnik`, which does not build on current
  Node/Windows, and Google ships DM Sans only as a variable font. Only the downloaded ranges
  (`0-255`, `256-511`) exist — a place name using a character outside them renders **blank**.

### Drayage routes — what's still missing

The basemap is now ready for them; the remaining piece is **route geometry**, and the map is not
where that comes from. A drayage leg (port → CY / rail yard) has to follow real roads, so it needs
a routing engine — self-hosted OSRM/Valhalla on an OSM extract, or a commercial Directions API.
Feed it the POD and `Lastcy` coordinates, get a GeoJSON `LineString` back, cache it (roads change
slowly; don't re-route on every render), and draw it exactly like the existing `remaining-route`
layer — a `line` layer whose source is swapped on selection. Nothing about the basemap needs to
change for that.
