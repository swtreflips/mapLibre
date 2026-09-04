import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { computeStats, SOON_DAYS } from '../lib/stats'
import { voyagePhase, formatDay, sortByPriority } from '../lib/vesselMath'
import { KIND_LABELS } from '../lib/search'
import BrandMark from './BrandMark'
import ContainerCard from './ContainerCard'
import SearchBox from './SearchBox'
import { MIN_WIDTH, MAX_WIDTH, clampWidth, readWidth, writeWidth } from '../lib/panelWidth'
import { signOut } from '../hooks/useSession'
import './Sidebar.css'

// One number in the Overview. A live count is a BUTTON — clicking it filters the sidebar to the
// containers behind it, which is what turns the panel from a readout into the way into a worklist.
//
// A count of ZERO is not a button. There is nothing behind it, and a filter that yields an empty
// list reads as a bug rather than as an empty set.
function Stat({ label, count, tone, group, onPick }) {
  const cls = `stat${tone ? ` stat--${tone}` : ''}`
  const body = (
    <>
      {/* The dot repeats what the word already says. It is never alone — colour carries no meaning
          on its own anywhere in this app (CLAUDE.md §8). */}
      {tone && <span className="stat__dot" aria-hidden="true" />}
      <span className="stat__label">{label}</span>
      <span className="stat__n">{count}</span>
    </>
  )
  if (!count || !onPick) return <div className={cls}>{body}</div>
  return (
    <button type="button" className={`${cls} stat--live`} onClick={() => onPick(group, label)}>
      {body}
    </button>
  )
}

// A group of stats, as a CARD — the same surface the container cards in the tray use, so the two
// panels read as one family rather than two unrelated screens.
//
// The header is its own flex ROW, with the label and the count as SIBLINGS. That is not cosmetic:
// the count used to sit inside the label's <p>, inheriting its 9px mono micro-label treatment, so
// the number summing four rows drew smaller than any of the rows it summed. A sibling can be sized
// on its own terms.
function Group({ title, count, children }) {
  return (
    <section className="statgroup">
      <header className="statgroup__head">
        <p className="statgroup__title">{title}</p>
        {count != null && <p className="statgroup__n">{count}</p>}
      </header>
      <div className="statgroup__rows">{children}</div>
    </section>
  )
}

// THE OVERVIEW — the whole fleet, when nothing is selected.
//
// NOT "snapshot", which this was called: that word already means the thrice-weekly ingestion push
// in this codebase (CLAUDE.md §14), and it sells a live panel as a frozen moment. "Overview" also
// names the CONTENT rather than the format — the count and the two groups below already say that
// this is a summary, so the kicker does not have to.
//
// No per-port breakdown, deliberately: the MAP is the per-port view, and repeating it here would
// push the numbers only this panel can give — on rail, arriving soon — below the fold.
function Overview({ stats, onCommit }) {
  // The id Set comes straight from computeStats rather than being recomputed here. It is also
  // memoised, which matters beyond speed: matchedIds is a dependency of MapView's rebuild effect,
  // and a fresh Set each render would redraw the world.
  const pick = (key) => (group, label) =>
    onCommit({ kind: 'stat', group, value: label, ids: stats.ids[key] })

  return (
    <section className="panel panel--overview">
      <header className="overview__head">
        <p className="overview__kicker">Overview</p>
        <h3 className="overview__total">
          {stats.total}
          <span> container{stats.total === 1 ? '' : 's'}</span>
        </h3>
      </header>

      <Group title="In transit" count={stats.transit.water + stats.transit.rail}>
        <Stat label="On water" count={stats.transit.water} group="In transit" onPick={pick('water')} />
        <Stat label="On rail" count={stats.transit.rail} group="In transit" onPick={pick('rail')} />
        <Stat
          // Derived from SOON_DAYS rather than written out, so the window and the label can never
          // disagree. NOT "this week": the rule is a ROLLING seven days, so on a Friday it still
          // includes next Monday — which is the point. A calendar week would hide Monday's
          // arrivals every Friday afternoon, exactly when someone is planning for them.
          label={`Arriving next ${SOON_DAYS} days`}
          count={stats.transit.arrivingSoon}
          group="In transit"
          onPick={pick('arrivingSoon')}
        />
        {/* Shown even at zero. "4 arriving soon" with the late ones quietly dropped would read as a
            clean pipeline; the whole point of the row is that it is sometimes not. */}
        <Stat label="Overdue" count={stats.transit.overdue} group="In transit" onPick={pick('overdue')} />
      </Group>

      <Group title="At rest" count={stats.atRest.total}>
        {/* Named the way ops already talks about them — "a red container", "a blue container".
            Green keeps its state name because "booked" is the actionable fact about it, and it is
            the one of the three that says what to do rather than how long it has sat.

            Naming a row by its colour also happens to help rather than hurt here: the word tells
            you the colour you would otherwise have to see, which is the opposite of encoding
            meaning in hue alone (§8). */}
        <Stat label="Red containers" count={stats.atRest.red} tone="red" group="At rest" onPick={pick('red')} />
        <Stat label="Blue containers" count={stats.atRest.blue} tone="blue" group="At rest" onPick={pick('blue')} />
        <Stat label="Booked" count={stats.atRest.green} tone="green" group="At rest" onPick={pick('green')} />
      </Group>

      <p className="placeholder">Click a number to see those containers, or a marker on the map.</p>
    </section>
  )
}

// THE TRAY. A holder — a vessel, a train, or a facility — holds 1..N containers, and this is what
// it is holding. The panel used to show one shipment because the map used to select one shipment;
// both changed together (CLAUDE.md §8).
// `origin` is a load port — boxes that have not sailed yet. It reads as a Port here because that
// is what it is; the "Port of loading" subtitle is what separates it from a discharge card.
const HOLDER_KIND = { vessel: 'Vessel', rail: 'Rail', port: 'Port', origin: 'Port' }

function Tray({ holder, matchedIds }) {
  const n = holder.containers.length
  // FACILITIES ONLY — a discharge port or a load port. Either tray is a worklist: at a discharge
  // port red first and longest-sitting first, because everything has stopped and the question is
  // what to clear next; at a load port sortByPriority bands every box as `future` and orders them
  // by ETD, so the next thing to sail is at the top. A vessel or train tray is a manifest of
  // things all in the same situation, so it keeps the id order the holder arrives in and stays
  // comparable between refreshes (holders.js).
  //
  // Sorted HERE rather than in holders.js deliberately: the holder object is shared with the
  // map, whose card reads the same array, and this is a question about one panel.
  const rows = useMemo(
    () =>
      holder.kind === 'port' || holder.kind === 'origin'
        ? sortByPriority(holder.containers)
        : holder.containers,
    [holder],
  )
  // Null for a PORT holder, which has no voyage — a facility is where boxes stop, not something
  // travelling between two dates. Also null for any voyage missing one of its dates, rather than
  // rendering a confident sentence built on a blank.
  const voyage = voyagePhase(holder.etd, holder.eta)
  return (
    <section className="panel panel--tray">
      <header className="tray__head">
        {/* Three kinds of holder now: a ship, a train, and a facility the containers are sitting
            in. The facility is not always a seaport — an inland yard holds boxes that finished a
            rail leg — so holders.js decides that word and this only has to name the kind. */}
        <p className="tray__kind">{HOLDER_KIND[holder.kind] ?? 'Port'}</p>
        <h3 className="tray__name">{holder.name}</h3>
        {/* A VESSEL GETS ONE LINE PER DESTINATION, a facility or a train gets one line total.
            A ship calling at two ports is carrying two deliveries, and rolling them into a single
            "4 containers" against a joined chain hides which boxes come off where — the one thing
            a reader wants from a multi-drop. holders.js builds `manifest` and drops any call with
            nothing left aboard, so this stays a list of work outstanding. */}
        {holder.manifest?.length ? (
          holder.manifest.map((m) => (
            <p className="tray__meta" key={m.key}>
              {m.lane}
              <span className="tray__count">
                {m.count} container{m.count === 1 ? '' : 's'}
              </span>
            </p>
          ))
        ) : (
          <p className="tray__meta">
            {holder.subtitle}
            <span className="tray__count">
              {n} container{n === 1 ? '' : 's'}
            </span>
          </p>
        )}
        {/* THE ETA SHOWS IN EVERY PHASE, including "departed". The phrase answers how soon, the
            date answers on what day, and the whole point of this line is that neither should cost
            anyone a calculation. */}
        {voyage && (
          <p className="tray__voyage" data-phase={voyage.phase}>
            <span className="tray__phase">{voyage.label}</span>
            <span className="tray__eta">ETA {formatDay(holder.eta)}</span>
          </p>
        )}
      </header>
      <div className="tray__list">
        {/* SELECTION WINS OVER THE FILTER: a holder shows everything it holds, filtered or not,
            because "what is on this ship" is the question a click asks and a partial answer to it
            would be a lie. The matches are ringed instead — which is also what the map is doing
            one arm over, so the two views agree. */}
        {rows.map((c) => (
          <ContainerCard key={c.shipment} shipment={c} matched={matchedIds?.has(c.shipment)} />
        ))}
      </div>
    </section>
  )
}

// The committed filter, and the way out of it. Three exits exist (this chip, the input's ✕, and
// Escape) because a filter you cannot leave is a mode, and a dashboard with a hidden mode is how
// someone ends up believing half the fleet has sailed.
function FilterBar({ filter, count, onClear }) {
  return (
    <div className="filterbar">
      <div className="filterbar__chip">
        {/* A stat filter names its own group ("In transit"), because KIND_LABELS exists to group
            SEARCH suggestions and a non-search kind does not belong in it. */}
        <span className="filterbar__kind">
          {filter.group ?? KIND_LABELS[filter.kind] ?? 'Search'}
        </span>
        <span className="filterbar__value">{filter.value}</span>
      </div>
      <span className="filterbar__count">
        {count} container{count === 1 ? '' : 's'}
      </span>
      <button type="button" className="filterbar__clear" onClick={onClear}>
        Clear
      </button>
    </div>
  )
}

function Results({ shipments, matchedIds, filter, onClear }) {
  // THE SAME ORDER A PORT TRAY USES, and deliberately the same function. A search can return
  // containers in every state at once, so this is where the full band order shows: the yard
  // colours first, then everything in motion by soonest arrival, then what has not sailed.
  //
  // A container has one place in the queue; which panel you found it through should not change
  // it. Sorting results by relevance or by id would have given the same box two answers.
  const hits = useMemo(
    () => sortByPriority(shipments.filter((s) => matchedIds.has(s.shipment))),
    [shipments, matchedIds],
  )

  return (
    <section className="panel panel--tray">
      <FilterBar filter={filter} count={hits.length} onClear={onClear} />
      {hits.length === 0 ? (
        <div className="tray__list">
          <p className="placeholder">Nothing matches that. Clear the filter to see the fleet.</p>
        </div>
      ) : (
        <div className="tray__list">
          {hits.map((s) => (
            <ContainerCard key={s.shipment} shipment={s} />
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * The drag handle on the panel's right edge.
 *
 * THE DRAG WRITES TO THE DOM, NOT TO REACT STATE, and that is the whole reason this is a hook
 * rather than a `useState` in the component. `Sidebar` renders every container card it is showing;
 * calling setState on each `pointermove` would re-render that entire list sixty times a second for
 * a number that only CSS consumes. So the pointer handler sets the custom property straight on the
 * node, and state — plus the localStorage write — happens ONCE, on release.
 *
 * State still exists because the width has to survive a re-render for some other reason, and
 * because the handle's `aria-valuenow` has to be able to report it.
 */
function useSidebarWidth() {
  const ref = useRef(null)
  const [width, setWidth] = useState(readWidth)

  // Applied to the node rather than through an inline `style` prop, so a mid-drag React render
  // cannot stomp the value the pointer handler just wrote.
  const paint = useCallback((px) => {
    ref.current?.style.setProperty('--sidebar-w', `${px}px`)
  }, [])

  useEffect(() => { paint(width) }, [width, paint])

  const commit = useCallback((px) => {
    const next = clampWidth(px)
    setWidth(next)
    writeWidth(next)
    return next
  }, [])

  const onPointerDown = useCallback((e) => {
    // Left button only: a right-click on the handle should open the context menu, not start a drag
    // that nothing will ever end.
    if (e.button !== 0) return
    e.preventDefault()
    const el = ref.current
    if (!el) return
    const startX = e.clientX
    const startW = el.getBoundingClientRect().width
    let latest = startW

    // Capture, so the drag survives the pointer leaving the 6px strip — which it does immediately,
    // because the pointer moves faster than the panel edge follows it.
    e.currentTarget.setPointerCapture?.(e.pointerId)
    document.body.classList.add('is-resizing')

    const move = (ev) => {
      latest = clampWidth(startW + (ev.clientX - startX))
      paint(latest)
    }
    const up = () => {
      document.body.classList.remove('is-resizing')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      commit(latest)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    // `pointercancel` fires when the browser takes the pointer over — a touch turning into a
    // scroll, say. Without it the body keeps `is-resizing` and the whole app stays unselectable.
    window.addEventListener('pointercancel', up)
  }, [paint, commit])

  // A drag-only control cannot be used without a mouse, and this is a few lines.
  const onKeyDown = useCallback((e) => {
    const STEP = 16
    const at = {
      ArrowLeft: () => width - STEP,
      ArrowRight: () => width + STEP,
      Home: () => MIN_WIDTH,
      End: () => MAX_WIDTH,
    }[e.key]
    if (!at) return
    e.preventDefault()
    commit(at())
  }, [width, commit])

  // Destructured by the caller rather than used as `panel.x`. The `react-hooks/refs` lint rule
  // treats ANY property read on an object that carries a ref as a ref access during render, so
  // returning a bag and reaching into it in JSX trips it on every field.
  return { ref, width, commit, onPointerDown, onKeyDown }
}

/**
 * How old the data is, and the way out.
 *
 * THE SNAPSHOT DATE IS NOT DECORATION. Shipments arrive as a thrice-weekly push, so what is on
 * screen is always a photograph of some moment — and this codebase's own rule is that a view hiding
 * the age of its data gets trusted once and distrusted permanently. Every arrival, dwell and
 * position on the map is computed against today from dates frozen at that push.
 *
 * Deliberately coarse: the day, not the minute. Nobody plans against minutes, and a timestamp
 * precise to the second invites a confidence in the freshness that a Monday/Wednesday/Friday
 * cadence does not support.
 */
function Footer({ snapshot }) {
  const day = snapshot?.uploadedAt
    ? formatDay(new Date(snapshot.uploadedAt))
    : null

  return (
    <div className="sidebar__foot">
      <p className="sidebar__stamp">
        {day ? (
          <>
            Snapshot {day}
            <span className="sidebar__stamp-n">{snapshot.shipmentCount} shipments</span>
          </>
        ) : (
          'No snapshot pushed yet'
        )}
      </p>
      <button type="button" className="sidebar__signout" onClick={signOut}>
        Sign out
      </button>
    </div>
  )
}

export default function Sidebar({
  shipments,
  snapshot,
  selected,
  index,
  query,
  filter,
  matchedIds,
  onQueryChange,
  onCommit,
  onClear,
}) {
  const stats = useMemo(() => computeStats(shipments), [shipments])
  const {
    ref: panelRef,
    width: panelWidth,
    commit: setPanelWidth,
    onPointerDown: onResizeStart,
    onKeyDown: onResizeKey,
  } = useSidebarWidth()

  return (
    <aside className="sidebar" ref={panelRef}>
      {/* The module's only dark surface. Mesh, grain and chart grid — the same three layers
          Freight's rail carries, so the two dark chromes in the estate match. */}
      <div className="sidebar__cap grain ground-grid ground-grid--chrome">
        <BrandMark tone="dark" />
      </div>

      {/* Its own flex row between the cap and the panel — NOT inside the cap, whose 4rem height is
          a cross-app contract and whose `> * { z-index: 1 }` would trap the dropdown in its
          stacking context. */}
      <SearchBox
        index={index}
        query={query}
        filter={filter}
        onQueryChange={onQueryChange}
        onCommit={onCommit}
        onClear={onClear}
      />

      {/* Three states, never stacked: a selected holder wins, then an active filter's results,
          then the overview. */}
      {selected ? (
        <Tray holder={selected} matchedIds={matchedIds} />
      ) : filter && matchedIds ? (
        <Results shipments={shipments} matchedIds={matchedIds} filter={filter} onClear={onClear} />
      ) : (
        <Overview stats={stats} onCommit={onCommit} />
      )}

      <Footer snapshot={snapshot} />

      {/* Last child, so it paints over the panel's own edge. `separator` with an orientation and a
          value range is what a resize handle is in ARIA — it gives the keyboard case a meaning as
          well as a key handler. */}
      <div
        className="sidebar__resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        aria-valuenow={panelWidth}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        tabIndex={0}
        onPointerDown={onResizeStart}
        onKeyDown={onResizeKey}
        onDoubleClick={() => setPanelWidth(MIN_WIDTH)}
        title="Drag to resize — double-click to reset"
      />
    </aside>
  )
}
