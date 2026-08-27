import { useState } from 'react'
import { containerStatus } from '../lib/vesselMath'
import './ContainerCard.css'

// One container, as a card in the tray.
//
// FAMILY, NOT A COPY. RatesApp builds its cards from Tailwind utilities over the shared `linen`
// skin (src/components/ui/DashboardPrimitives.jsx); this app has no Tailwind, so the resemblance
// comes from reusing the same SKIN TOKENS and the same shape language — 2xl radius, fog-200
// hairline, white ground, shadow-card, a 2px status bar across the top, mono micro-labels in
// uppercase with wide tracking, and figures in tabular numerals. Both apps re-skin together
// because both read the same variables.

const dash = (v) => (v && String(v).trim() !== '' ? v : '—')

function Fact({ label, children, wide }) {
  return (
    <div className={wide ? 'ccard__fact ccard__fact--wide' : 'ccard__fact'}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

export default function ContainerCard({ shipment: s }) {
  const [open, setOpen] = useState(false)
  const status = containerStatus(s)
  const items = s.items ?? []
  const units = items.reduce((n, i) => n + (Number(i.qty) || 0), 0)

  return (
    <article className={`ccard ccard--${status.tone}`}>
      {/*
        The whole header is the toggle, not a separate chevron: the card is one target and the
        target is the thing you are looking at. A <button> rather than a click handler on the
        <article> so it is reachable by Tab and announces its state.
      */}
      <button
        type="button"
        className="ccard__head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ccard__id">{dash(s.container)}</span>
        {/* The chip carries a WORD as well as a tone. On the map, which arm a container sits in
            encodes status independently of hue; a flat tray has no arms, so the label does that
            job here. Never show the tone alone. */}
        <span className="ccard__chip">{status.label}</span>
      </button>

      <p className="ccard__sub">
        {dash(s.shipment)}
        <span className="ccard__dot">·</span>
        {dash(s.vessel)}
      </p>

      <dl className="ccard__facts">
        <Fact label="Route" wide>
          {dash(s.port_of_loading)} <span className="ccard__arrow">→</span> {dash(s.port_of_discharge)}
        </Fact>
        {s.actual_portdate ? (
          <Fact label="Arrived">{s.actual_portdate}</Fact>
        ) : (
          <Fact label="ETA">
            {dash(s.expected_portdate)}
            {status.detail ? <span className="ccard__muted">{status.detail}</span> : null}
          </Fact>
        )}
        <Fact label="Last free day">{dash(s.last_freeday)}</Fact>
        <Fact label="Appointment">{dash(s.appointment_date)}</Fact>
      </dl>

      {open && (
        <dl className="ccard__facts ccard__facts--more">
          <Fact label="Carrier">{dash(s.confirmed_carrier)}</Fact>
          <Fact label="Arrival notice">{dash(s.arrival_notice)}</Fact>
          <Fact label="Forwarder" wide>
            {dash(s.freight_forwarder)}
          </Fact>
          <Fact label="HBL">{dash(s.hbl)}</Fact>
          <Fact label="MBL">{dash(s.mbl)}</Fact>
          {items.length > 0 && (
            <Fact label="Items" wide>
              <ul className="ccard__items">
                {items.map((i, n) => (
                  <li key={`${i.item}-${n}`}>
                    <span className="ccard__item-name">{i.item}</span>
                    <span className="ccard__item-qty">{Number(i.qty).toLocaleString()}</span>
                    <span className="ccard__item-vendor">{i.vendor}</span>
                  </li>
                ))}
              </ul>
            </Fact>
          )}
        </dl>
      )}

      <p className="ccard__foot">
        {items.length === 0
          ? 'No line items'
          : `${items.length} item${items.length === 1 ? '' : 's'} · ${units.toLocaleString()} units`}
        <span className="ccard__more">{open ? 'Show less' : 'Show more'}</span>
      </p>
    </article>
  )
}
