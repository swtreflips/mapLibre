import { useMemo } from 'react'
import { parseYMD } from '../lib/vesselMath'
import BrandMark from './BrandMark'
import ContainerCard from './ContainerCard'
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

// THE TRAY. A holder — a vessel or a port — holds 1..N containers, and this is what it is
// holding. The panel used to show one shipment because the map used to select one shipment; both
// changed together (CLAUDE.md §8).
function Tray({ holder }) {
  const n = holder.containers.length
  return (
    <section className="panel panel--tray">
      <header className="tray__head">
        <p className="tray__kind">{holder.kind === 'vessel' ? 'Vessel' : 'Port'}</p>
        <h3 className="tray__name">{holder.name}</h3>
        <p className="tray__meta">
          {holder.subtitle}
          <span className="tray__count">
            {n} container{n === 1 ? '' : 's'}
          </span>
        </p>
      </header>
      <div className="tray__list">
        {holder.containers.map((c) => (
          <ContainerCard key={c.shipment} shipment={c} />
        ))}
      </div>
    </section>
  )
}

export default function Sidebar({ shipments, selected }) {
  const stats = useMemo(() => computeStats(shipments), [shipments])

  return (
    <aside className="sidebar">
      {/* The module's only dark surface. Mesh, grain and chart grid — the same three layers
          Freight's rail carries, so the two dark chromes in the estate match. */}
      <div className="sidebar__cap grain ground-grid ground-grid--chrome">
        <BrandMark tone="dark" />
      </div>

      {/* With nothing selected the snapshot IS the panel, rather than an empty placeholder above
          a stats block. Selecting a holder replaces it wholesale — the two never stack. */}
      {selected ? (
        <Tray holder={selected} />
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
