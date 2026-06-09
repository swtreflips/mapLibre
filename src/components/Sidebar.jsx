import { useMemo } from 'react'
import { parseYMD } from '../lib/vesselMath'
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

export default function Sidebar({ shipments, selected }) {
  const stats = useMemo(() => computeStats(shipments), [shipments])

  return (
    <aside className="sidebar">
      <section className="panel">
        <h3>Selected Shipment</h3>
        {selected ? (
          <div className="details">
            <Row label="Shipment" value={selected.shipment} />
            <Row label="Container" value={selected.container} />
            <Row label="Vessel" value={selected.vessel} />
            <Row label="Carrier" value={selected.confirmed_carrier} />
            <Row label="Forwarder" value={selected.freight_forwarder} />
            <Row label="Route" value={`${selected.port_of_loading} → ${selected.port_of_discharge}`} />
            <Row label="Actual Shipping" value={selected.actual_shipping} />
            <Row label="Expected Port Date" value={selected.expected_portdate} />
            {selected.actual_portdate ? (
              <Row label="Actual Port Date" value={selected.actual_portdate} />
            ) : null}
            <Row label="Arrival Notice" value={selected.arrival_notice} />
          </div>
        ) : (
          <p className="placeholder">Click a ship to see its details…</p>
        )}
      </section>

      <section className="panel">
        <h3>Snapshot</h3>
        <div className="details">
          <Row label="Total Shipments" value={stats.total} />
          <Row label="On Water" value={stats.onWater} />
          <Row label="Arrived" value={stats.arrived} />
          <Row label="Past Free Day" value={stats.pastFreeDay} />
        </div>
      </section>
    </aside>
  )
}
