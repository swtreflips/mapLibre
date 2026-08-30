import { useMemo } from 'react'
import { computeStats, SOON_DAYS } from '../lib/stats'
import { KIND_LABELS } from '../lib/search'
import BrandMark from './BrandMark'
import ContainerCard from './ContainerCard'
import SearchBox from './SearchBox'
import './Sidebar.css'

// One number in the Snapshot. A live count is a BUTTON — clicking it filters the sidebar to the
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

function Group({ title, count, children }) {
  return (
    <div className="statgroup">
      <p className="statgroup__title">
        {title}
        {count != null && <span className="statgroup__n">{count}</span>}
      </p>
      <div className="statgroup__rows">{children}</div>
    </div>
  )
}

// THE SNAPSHOT — the whole fleet, when nothing is selected.
//
// No per-port breakdown, deliberately: the MAP is the per-port view, and repeating it here would
// push the numbers only this panel can give — on rail, arriving soon — below the fold.
function Snapshot({ stats, onCommit }) {
  // The id Set comes straight from computeStats rather than being recomputed here. It is also
  // memoised, which matters beyond speed: matchedIds is a dependency of MapView's rebuild effect,
  // and a fresh Set each render would redraw the world.
  const pick = (key) => (group, label) =>
    onCommit({ kind: 'stat', group, value: label, ids: stats.ids[key] })

  return (
    <section className="panel panel--snapshot">
      <header className="snap__head">
        <p className="snap__kicker">Snapshot</p>
        <h3 className="snap__total">
          {stats.total}
          <span> container{stats.total === 1 ? '' : 's'}</span>
        </h3>
      </header>

      <Group title="In transit" count={stats.transit.water + stats.transit.rail}>
        <Stat label="On water" count={stats.transit.water} group="In transit" onPick={pick('water')} />
        <Stat label="On rail" count={stats.transit.rail} group="In transit" onPick={pick('rail')} />
        <Stat
          label={`Arriving ${SOON_DAYS}d`}
          count={stats.transit.arrivingSoon}
          group="In transit"
          onPick={pick('arrivingSoon')}
        />
        {/* Shown even at zero. "4 arriving soon" with the late ones quietly dropped would read as a
            clean pipeline; the whole point of the row is that it is sometimes not. */}
        <Stat label="Overdue" count={stats.transit.overdue} group="In transit" onPick={pick('overdue')} />
      </Group>

      <Group title="At rest" count={stats.atRest.total}>
        <Stat label="Aging" count={stats.atRest.red} tone="red" group="At rest" onPick={pick('red')} />
        <Stat label="At yard" count={stats.atRest.blue} tone="blue" group="At rest" onPick={pick('blue')} />
        <Stat label="Booked" count={stats.atRest.green} tone="green" group="At rest" onPick={pick('green')} />
      </Group>

      <p className="placeholder">Click a number to see those containers, or a marker on the map.</p>
    </section>
  )
}

// THE TRAY. A holder — a vessel, a train, or a facility — holds 1..N containers, and this is what
// it is holding. The panel used to show one shipment because the map used to select one shipment;
// both changed together (CLAUDE.md §8).
const HOLDER_KIND = { vessel: 'Vessel', rail: 'Rail', port: 'Port' }

function Tray({ holder, matchedIds }) {
  const n = holder.containers.length
  return (
    <section className="panel panel--tray">
      <header className="tray__head">
        {/* Three kinds of holder now: a ship, a train, and a facility the containers are sitting
            in. The facility is not always a seaport — an inland yard holds boxes that finished a
            rail leg — so holders.js decides that word and this only has to name the kind. */}
        <p className="tray__kind">{HOLDER_KIND[holder.kind] ?? 'Port'}</p>
        <h3 className="tray__name">{holder.name}</h3>
        <p className="tray__meta">
          {holder.subtitle}
          <span className="tray__count">
            {n} container{n === 1 ? '' : 's'}
          </span>
        </p>
      </header>
      <div className="tray__list">
        {/* SELECTION WINS OVER THE FILTER: a holder shows everything it holds, filtered or not,
            because "what is on this ship" is the question a click asks and a partial answer to it
            would be a lie. The matches are ringed instead — which is also what the map is doing
            one arm over, so the two views agree. */}
        {holder.containers.map((c) => (
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
  const hits = useMemo(
    () => shipments.filter((s) => matchedIds.has(s.shipment)),
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

export default function Sidebar({
  shipments,
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

  return (
    <aside className="sidebar">
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
          then the snapshot. */}
      {selected ? (
        <Tray holder={selected} matchedIds={matchedIds} />
      ) : filter && matchedIds ? (
        <Results shipments={shipments} matchedIds={matchedIds} filter={filter} onClear={onClear} />
      ) : (
        <Snapshot stats={stats} onCommit={onCommit} />
      )}
    </aside>
  )
}
