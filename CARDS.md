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

### Empty sections get a pad

A section with no containers draws a faint neutral ground quad where its pile would be, so an
absent status reads as "no red here" rather than as an ambiguous gap. **Only empty sections** — a
partly-filled slot would show its unused half as a grey shard beside the box, which is noise when
the pile already marks the section. The pad is neutral grey (R=G=B) on purpose: it is structure,
not data, and must not read as a fourth status.

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

## 4. Sizing

**The SVG `viewBox` does the shrink-to-fit.** The stack is drawn at natural size, the viewBox is
set to its bounding box, and the `<svg>` gets a fixed rendered size with
`preserveAspectRatio="xMidYMax meet"`. SVG scales it — a taller stack simply comes out smaller,
with no manual maths.

- **`xMidYMax`**, not `xMidYMid`: it pins the stack to the bottom of the box so its base lands on
  the port when the marker is anchored `'bottom'`. `xMidYMid` floats short stacks above the port.
- **`vector-effect="non-scaling-stroke"`** is load-bearing. Without it the outline is in user units
  and shrinks with the viewBox, so a tall stack or a low zoom drives it under one device pixel and
  the edges break up — the exact failure the vessel hull hit (CLAUDE.md §5.5). With it, the stroke
  is constant in render space at any stack height.
- **`CARD_BASE_PX = 64`.** Cards are DOM markers, so they do not scale with the map like the
  sprites they replaced; `--card-scale` on `.map-container` is driven from the map's `zoom` event
  on the sprites' old curve (z2→0.6, z6→0.8, z10→1.1). The tri-arm card is **~2× wider** than the
  single mixed stack it replaced (three 2-wide footprints side by side), and the square viewBox
  fits by width — so at the old 44 the boxes came out half-size. 64 splits the difference. This is
  the lever if cards feel heavy at world zoom.
- **`xMidYMax` + `anchor: 'bottom'` puts the card's baseline on the port, not its centre.** So the
  arms sit above and around the port rather than radiating from it symmetrically — a red-only pile
  reads as displaced NE. Anchoring the *pie centre* on the port would be truer to the model, but it
  needs a per-card marker offset (the origin's position in the rendered box moves with stack
  height) and it would put the green pile on top of the port's dot and label.

**No cap on stack height** — every container is drawn. The consequence, accepted knowingly: a
20-container port split 9/7/4 puts a 5-row tower in one arm, shrunk into the card box, and at world
zoom each box becomes a sliver where the colour stops being readable. Splitting into three arms
softens this — the tallest arm is shorter than one mixed stack of the same total — but does not
remove it. If that bites, the lever is a minimum box height with
a `×N` overflow, **not** a bigger card.

---

## 5. Why DOM markers

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

## 6. Known gap

**Cards are not interactive** (`pointer-events: none`). Clicking a container used to fill the
sidebar with that shipment; one card standing for N containers has no single shipment to show — the
same collision the vessel count badge hit. The resolution is the port summary in CLAUDE.md §8, and
choosing DOM markers is what makes wiring it straightforward.
