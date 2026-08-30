import { useMemo } from 'react'
import { parseYMD } from '../lib/vesselMath'
import { KIND_LABELS } from '../lib/search'
import BrandMark from './BrandMark'
import ContainerCard from './ContainerCard'
import SearchBox from './SearchBox'
import './Sidebar.css'

// Snapshot counts over all shipments (CLAUDE.md §8).
function computeStats(shipments) {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  let onWater = 0
  let arrived = 0
  let pastFreeDay = 0

  for (const s of shipments) {
    const start = parseYMD(s.actual_shipping)
    const end = parseYMD(s.expected_portdate)
    const actual = parseYMD(s.actual_portdate)
    const lastFree = parseYMD(s.last_freeday)

    if (start && end && !actual && today >= start && today <= end) onWater += 1
    if (actual) arrived += 1
    if (lastFree && lastFree < today) pastFreeDay += 1
  }

  return { total: shipments.length, onWater, arrived, pastFreeDay }
}

function Row({ label, value }) {
  return (
    <div className="row">
      <span className="label">{label}</span>
      <span className="value">{value || '—'}</span>
    </div>
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
        <span className="filterbar__kind">{KIND_LABELS[filter.kind] ?? 'Search'}</span>
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
        <section className="panel">
          <h3>Snapshot</h3>
          <div className="details">
            <Row label="Total Shipments" value={stats.total} />
            <Row label="On Water" value={stats.onWater} />
            <Row label="Arrived" value={stats.arrived} />
            <Row label="Past Free Day" value={stats.pastFreeDay} />
          </div>
          <p className="placeholder">Click a vessel or a port to see the containers it holds…</p>
        </section>
      )}
    </aside>
  )
}
