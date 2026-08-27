# CARDS.md — port container cards

How arrived containers are drawn on the map, and why the geometry is the way it is.
Implementation: [src/map/portCard.js](src/map/portCard.js) + `syncPortCards` in
[src/components/MapView.jsx](src/components/MapView.jsx).

---

## 1. What changed, and why

Containers used to be **one sprite per container**, fanned around the discharge port on a
golden-angle spiral. It worked, but it answered the wrong question: you counted scattered boxes
instead of reading a port's load at a glance, and a busy port became a smear of overlapping icons.

Now: **one card per port**, an isometric stack two containers wide growing upward. A port with no
arrived containers renders nothing at all — no empty card, no placeholder.

---

## 2. Three arms, one per status

The card is not one mixed pile. Each status gets **its own stack on its own axis**, radiating from
a shared centre — blue northwest, red northeast, green due south, 120° apart on screen:

```
        blue  \   /  red
               \ /
                +          <- card centre
                |
              green
```

**The isometric ground plane hands us exactly those three directions**, which is why the layout is
this and not an arbitrary rosette:

| world offset | screen vector | direction | arm |
|---|---|---|---|
| `-x` | `(-cos30, -sin30)` | up-and-left | **blue**, NW |
| `-y` | `(+cos30, -sin30)` | up-and-right | **red**, NE |
| `+x +y` | `(0, +1)` | straight down | **green**, S |

All three have the same length, so the arms are evenly spread with no per-arm fudge. `ARM_R` is
that shared screen radius.

**Why arms instead of one mixed stack: position now carries status independently of hue.** A card
with a single pile in the northwest is a blue-only port whether or not you can see the blue —
which matters on a map read by someone colour-blind. Colour and position say the same thing twice.

### The frame is fixed

Horizontal extent and the baseline are measured from **all three arm slots, present or not** —
never from the geometry actually drawn. Without that, the viewBox would tighten around a lone pile
and `xMid` would re-centre it, so a blue-only port and a red-only port would render as the same
picture in different colours and the positional signal would be gone. The cost is whitespace on a
single-status card. The frame *is* the feature.

Only the top grows with the tallest stack.

**Only real containers are ever painted.** An empty section draws nothing at all — the frame is
measured, not drawn. (A faint ground pad marking the empty slot was tried and removed: it added a
grey shard next to every partly-filled pile and read as a fourth status.) The pile's offset from
the marker's anchor is what identifies the section, and by this zoom the port's own label is on
screen to read it against.

### Within an arm

Containers fill the **bottom row first, left to right, then upward**:

```
        [2]                index 0 -> back-left,  bottom
   [0 ][ 1]                index 1 -> front-right, bottom
                           index 2 -> back-left,  second level

col   = i % 2              0 = back-left, 1 = front-right
level = floor(i / 2)
```

### Isometric projection

World axes: `x` across (containers sit side by side along x), `y` along the container's **length**,
`z` up.

```
sx = (x - y) * cos30
sy = (x + y) * sin30 - z
```

`+x` maps right-and-down, `+y` left-and-down, `+z` straight up. That orientation is deliberate: it
puts the **long corrugated flank on the lower-right** and the **door end on the lower-left**, which
is how a container is conventionally drawn. Swapping which axis carries the length flips both.

Box proportions are a 20ft container — 2.44 × 6.06 × 2.59 m → `12 : 30 : 13` user units. Each arm's
footprint is **centred on its axis point**, so the piles sit symmetrically around the centre rather
than hanging off it. `ARM_R = 27` leaves 3 user units of clearance between neighbouring piles.

### Painter's order — two keys

Arms first, then depth within the arm:

```js
boxes.sort((a, b) => ARMS[a.arm].depth - ARMS[b.arm].depth || a.key - b.key)
```

**Across arms**, green is nearest the viewer and blue/red sit behind it. Blue and red never overlap
on screen (opposite sides of the card), so their relative order is arbitrary.

**Within an arm**, every box shares the same `y` extent, so depth collapses to `x + z` and the whole
overlap problem becomes a single ascending sort — the front column occludes the back one, and an
upper box occludes the lid of the one beneath it. No special cases.

### Faces

Three parallelograms per box — top, long side, door end — in three shades of the container's
status colour. That is the entire depth cue. At 26–48 CSS px on a map, silhouette and shading are
all that read; the corrugation and corner castings of a real container would be invisible noise.
**Minimal is the accurate choice here, not a shortcut.**

## 3. Colour

From `containerColor()` in [src/lib/vesselMath.js](src/lib/vesselMath.js), unchanged:

| status | meaning | base |
|---|---|---|
| red | > 3 days at CY, no appointment | `#C0392B` |
| blue | recently arrived (≤ 3 days) | `#3B7DD8` |
| green | appointment set | `#57C785` |

**The three are separated by lightness as well as hue** (roughly L 44 / 51 / 72), so they stay
distinguishable without relying on hue alone — this map is read by someone colour-blind. The arm
layout (§2) carries the same signal a third time: which corner a pile sits in *is* its status. If
you retune these, keep the lightness spread.

Each box uses three shades of its base: top lightest, long side mid, door end darkest.

---

## 4. Sizing and placement

**The SVG `viewBox` does the shrink-to-fit.** The stack is drawn at natural size, the viewBox is
set to its bounding box, and the `<svg>` gets a fixed rendered size with
`preserveAspectRatio="xMidYMid meet"`. SVG scales it — a taller stack simply comes out smaller,
with no manual maths.

- **`vector-effect="non-scaling-stroke"`** is load-bearing. Without it the outline is in user units
  and shrinks with the viewBox, so a tall stack or a low zoom drives it under one device pixel and
  the edges break up — the exact failure the vessel hull hit (CLAUDE.md §5.5). With it, the stroke
  is constant in render space at any stack height.
- **`CARD_BASE_PX = 64`.** The tri-arm card is **~2× wider** than the single mixed stack it
  replaced (three 2-wide footprints side by side), and the square viewBox fits by width — so at the
  old 44 the boxes came out half-size.
- **`CARD_SCALE_STOPS` is currently FLAT at 1.0** — a constant 64 CSS px at every zoom. The ramp
  is switched off, not removed: 35 px at z3 read as too small, and running it flat reproduces
  exactly what was on screen before the centring fix (`--card-scale` was inert then — see the trap
  below), so what is being judged now is the centring alone.

  The trade it re-accepts: **the arms scale with the card**, so at full size a single-status pile
  sits ~265 km from its port at z3 — in from the 592 km it was, but the reason a ramp existed. Two
  different levers if it needs pulling back:

  | lever | effect |
  |---|---|
  | `CARD_SCALE_STOPS` middle stop | shrinks the whole card — piles tighten, boxes shrink with them |
  | `ARM_R` in portCard.js, ramped by zoom | pulls the arms in **without** shrinking the containers |

  The second is the one to reach for if the boxes must stay legible; it costs regenerating the SVG
  on zoom steps rather than only on `zoomend`. The curve starts at `FIRST_LABEL_ZOOM`, where cards
  start existing — below it a port draws a bubble, which opts out of this scale.

### Two elements, and why

`.port-card` is the marker element and carries **no `transform` of ours**. MapLibre writes
`element.style.transform` inline on it every reposition, and an inline style beats a stylesheet rule
on the same element, so anything we set there is silently discarded. Ours goes on `.port-card__inner`
inside it.

**This is not hypothetical.** `--card-scale` was written onto the marker element and was therefore
inert for several iterations: every card rendered at a flat `CARD_BASE_PX` at all zooms, two rounds
of curve tuning changed nothing on screen, and `getBoundingClientRect` quietly returned the same
64×64 the whole time. If you ever merge these two divs, it comes straight back. §7's live check
exists to catch it.

### The card is centred on the port, exactly

The port belongs at the point the three arms radiate from — viewBox `(0,0)` — so the marker is
anchored `'center'` and the card carries a per-card translate that puts that origin on the box
centre:

```css
transform: scale(var(--card-scale)) translate(var(--card-dx), var(--card-dy));
transform-origin: 50% 50%;
```

Rightmost applies first, so the translate lands in **unscaled** px and then everything scales about
the centre — which the marker has pinned to the port.

**The anchor alone cannot do this.** The shrink-to-fit means the origin's place inside the box moves
with stack height, so any fixed anchor drifts as a port fills up: measured, the needed correction is
+0.2 px for a 2-container card but −13.9 px at 12 containers. `portCardSvg` therefore returns
`{ markup, dx, dy }` and solves for it — four lines, residual ~0.003 px.

The card used to hang by its bottom edge (`anchor: 'bottom'` + `xMidYMax`), which floated the arms'
origin **413 km north** of the port at z3 and drew New York's red containers 592 km out — past
Boston, which is 306 km away. That is the failure mode this section exists to prevent: the error is
a fixed number of *screen pixels*, so it is invisible when zoomed in and enormous when zoomed out.

**No cap on stack height** — every container is drawn. The consequence, accepted knowingly: a
20-container port split 9/7/4 puts a 5-row tower in one arm, shrunk into the card box, and at world
zoom each box becomes a sliver where the colour stops being readable. Splitting into three arms
softens this — the tallest arm is shorter than one mixed stack of the same total — but does not
remove it. If that bites, the lever is a minimum box height with
a `×N` overflow, **not** a bigger card.

---

## 5. Two forms: card and bubble

A port draws one of two things, chosen by zoom:

| zoom | form | shows |
|---|---|---|
| ≥ `FIRST_LABEL_ZOOM` | the isometric **card** | full breakdown — which statuses, how many of each |
| below | a count **bubble** | the port's total, no breakdown |

**The threshold is the zoom the first port label appears at** — `PORT_BAND_START` in
[src/data/places.js](src/data/places.js), exported as `FIRST_LABEL_ZOOM` rather than copied as a
number, so moving the label staging moves this with it. That is the right seam because the card
*depends* on labels: below it there are no names on the map, so a stack has nothing to be read
against, and a dozen of them are clutter rather than information.

The two questions are genuinely different. Zoomed out: *where is the volume — east coast or west?*
A total answers that; a status breakdown at 6 px per box does not. Zoomed in: *what is going on at
this port?* — several blue and a couple of red says a batch just landed and a few have been sitting
without an appointment. So the bubble carries **no status colour at all**, deliberately, and is a
true neutral (R=G=B): it aggregates all three statuses, so any tint would read as one of them, and
warm greys read reddish at this size to a colour-blind eye (CLAUDE.md §15).

**A white disc, not a dark one.** A dark slug carried far more visual weight than a count deserves —
it read as the loudest thing on the map when it is only a summary. White sits in the same family as
the label halos and reads as paper laid on the map.

The **hairline ring is not decoration**, it is what makes white viable: land is `#f2efe9`, so a
white fill has almost no edge against it and the ring supplies the entire silhouette there, while
over `#aadaff` water the fill does that job alone. Both were checked side by side before choosing.
A translucent fill was the other candidate and lost: it takes on whatever is beneath it, so the disc
goes muddy over water and the numeral loses contrast exactly where the basemap is busiest.

Bubble radius follows a gentle `sqrt` ramp (10–16 px, saturating at 25 containers) so area tracks
count the way people read circles. The range is deliberately narrow — it is a legibility aid for
two-digit numerals at world zoom, not a proportional-symbol map. The number carries the value.

On top of that, **`BUBBLE_SCALE_STOPS` ramps the whole disc across the bottom of its zoom band** —
0.72 at z1.6 up to full size by z2.2, then flat until `FIRST_LABEL_ZOOM` hands over to the card.
That band is where a port is a dot on a continent and the disc reads heavy for what it says; the
numbers came off the DEV readout at the zooms where it actually looked wrong. It is a **separate**
table from `CARD_SCALE_STOPS` on purpose: the two forms never coexist and their bands barely touch,
so one curve spanning both would be fitted to nothing.

The bubble takes **no `will-change: transform`**, unlike the card. Promoting it to its own layer
risks the compositor scaling a cached raster, which would soften the numeral — the one thing on it
that must stay sharp. Verified crisp across the ramp at dpr 2.

**The swap runs on `zoom`, not `zoomend`**, so it lands as you cross the threshold instead of
snapping after you let go. The handler is guarded on the mode actually changing, so it costs one
comparison per frame and does real work only on a crossing. Positions still recompute on `zoomend`
only (CLAUDE.md §6).

Both forms centre on the port, so a crossing swaps the class and the markup and nothing else —
no marker is rebuilt. The bubble opts out of `--card-scale` (and needs no centring translate, being
drawn about its own origin): the card scales because it stands for physical containers at a place,
but a readout that shrinks as you zoom out is the opposite of what it is for.

---

## 6. Where a card is anchored

**At the port's own coordinate — the exact point its label is drawn at.** `portPointsByKey` in
[src/data/places.js](src/data/places.js) builds that lookup from `buildPlacesFC`'s own output, so
the card and the label read the same coordinate through the same code path and cannot drift apart.
A place excluded from the map is excluded here too.

Cards used to sit at **the last vertex of the sea route** instead. Those routes are `searoute`
graph paths, so the endpoint is a node in a shipping-lane network — near the port, but not the
port. At New York the two are 2.8 km apart: invisible at world zoom, plainly wrong once you zoom
in, and potentially much worse for a lane whose graph node sits well offshore.

The route endpoint survives **only as a fallback**, for a `port_of_discharge` with no row in
`us_ports` / `world_ports`. That is nearly always a drifted name rather than a missing port
(CLAUDE.md §4), so the DEV rebuild log names any port that fell back — the card still draws, and
the miss would otherwise be invisible.

**Arrived containers no longer need a route at all**, which closes a silent drop: a lane that
failed to join used to take its arrived containers down with it, because the route lookup ran
before the state check. A container sitting at a port is placed by the port, not by how it got
there.

---

## 7. Why DOM markers

This is a deliberate departure from CLAUDE.md §3's "prefer data-driven layers over DOM markers".
That rule exists because one `Marker` *per vessel* does not scale. This is one per **port** — under
a dozen — where the trade inverts:

- **Vector-crisp at every zoom and DPR** with no bake step and no sprite atlas. Given how much
  effort the vessel icon's bitmap aliasing took, that matters.
- A real DOM click target and free hover states, which is what the **port summary** (CLAUDE.md §8)
  will need.

`syncPortCards` reconciles markers against the current ports: update, create, then **remove
departed**. The removal pass is the one that matters — a marker that is never removed is a card
stuck on screen for the session, showing containers that have since been delivered. `innerHTML` is
only reassigned when the stack actually changed, so refreshes do not rebuild the SVG DOM.

---

## 8. Cards are the click target

A card selects its port and fills the tray (CLAUDE.md §8) — the gap this file used to record as
open. Choosing DOM markers is what made it straightforward, exactly as §7 predicted.

**The hit test lives on the SHAPES, not the `<svg>`.** `pointer-events: auto` on an `<svg>` root
makes its whole border box clickable like any replaced element; measured, that let an empty corner
of the 64px marker swallow a click meant for the map. `visiblePainted` only governs SVG *child*
shapes, so the root stays `none` and each polygon (and the bubble's circle and numeral) opts in.
Only painted containers take the click; the gaps between arms still belong to the map.
