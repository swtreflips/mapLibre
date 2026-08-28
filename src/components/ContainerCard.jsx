import { useState, useSyncExternalStore } from 'react'
import { containerStatus } from '../lib/vesselMath'
import { openCount, subscribe } from '../lib/notes'
import NotesPad from './NotesPad'
import './ContainerCard.css'

// One container, as a card in the tray.
//
// FAMILY, NOT A COPY. RatesApp builds its cards from Tailwind utilities over the shared `linen`
// skin (src/components/ui/DashboardPrimitives.jsx); this app has no Tailwind, so the resemblance
// comes from reusing the same SKIN TOKENS and the same shape language — 2xl radius, fog-200
// hairline, white ground, shadow-card, a 2px status bar across the top, mono micro-labels in
// uppercase with wide tracking, and figures in tabular numerals. Both apps re-skin together
// because both read the same variables.
//
// WHAT THE COLLAPSED FACE IS FOR: answering a phone call. It carries only the fields ops reads
// off to identify and place a box — shipment no., container no., the three dates, the lane it is
// travelling, and the three parties on the paperwork. Everything commercial (PO, item, quantity)
// is behind the expander. Fields the card used to show and deliberately no longer does — vessel,
// carrier, HBL, last free day, appointment date, arrival notice — were dropped, not moved. Note
// that last free day and appointment still MATTER: they feed containerStatus() below, so they
// reach the card as the chip's tone and word rather than as their own rows.

const dash = (v) => (v && String(v).trim() !== '' ? v : '—')

function Fact({ label, children, wide }) {
  return (
    <div className={wide ? 'ccard__fact ccard__fact--wide' : 'ccard__fact'}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

// `matched` is only meaningful inside a HOLDER tray while a search filter is active: the tray
// shows everything the holder holds, so the ring is what says which of those the search was
// about. In the results list every card matched by definition, so it is left undefined there and
// no ring is drawn.
export default function ContainerCard({ shipment: s, matched }) {
  const [open, setOpen] = useState(false)
  // Which FACE is showing. The card does not grow to fit notes — it swaps what occupies its body,
  // because the tray only fits about three cards and anything additive makes that worse.
  const [notesFace, setNotesFace] = useState(false)
  // The count on the toggle is the only sign, from the facts face, that anything is on the other
  // one — so it has to track writes made anywhere, including from a second card showing the same
  // shipment in a search result.
  const notes = useSyncExternalStore(
    subscribe,
    () => openCount(s.shipment),
    () => openCount(s.shipment),
  )
  const status = containerStatus(s)
  const items = s.items ?? []

  return (
    <article className={`ccard ccard--${status.tone}${matched ? ' ccard--matched' : ''}`}>
      {/*
        LEGACY NOTE, kept because the reasoning still applies to the expand control below:
        the caret rides inside the control it operates rather than sitting in a footer a hairline
        away from it. A <button> rather than a click handler on the
        <article> so it is reachable by Tab and announces its state. The caret rides INSIDE the
        button so the affordance sits on the control — an earlier version put "Show more" in a
        footer, a hairline away from the thing that actually toggled.
      */}
      {/* The header is a ROW of two sibling controls, not one button: a button inside a button is
          invalid, and the caret lives inside the expand control on purpose (the affordance sits on
          the thing it operates). So the notes toggle sits beside it rather than within it. */}
      <div className="ccard__head">
        <button
          type="button"
          className="ccard__expand"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="ccard__id">{dash(s.shipment)}</span>
          {/* The chip carries a WORD as well as a tone. On the map, which arm a container sits in
              encodes status independently of hue; a flat tray has no arms, so the label does that
              job here. Never show the tone alone. */}
          <span className="ccard__chip">{status.label}</span>
          {/* Hidden on the notes face — line items belong to the facts. */}
          {!notesFace && <span className="ccard__caret" aria-hidden="true" />}
        </button>
        {/* A sticky note, not a word. The header already carries a shipment id and a status chip;
            a third piece of text would compete with both, and the icon reads instantly as "the
            written-on side of this card". aria-label and title carry the name for everyone else. */}
        <button
          type="button"
          className={notesFace ? 'ccard__notes ccard__notes--on' : 'ccard__notes'}
          aria-pressed={notesFace}
          aria-label={notesFace ? 'Show shipment details' : 'Show notes'}
          title={notesFace ? 'Show shipment details' : 'Notes'}
          onClick={() => setNotesFace((v) => !v)}
        >
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
            {/* Square with the bottom-right corner turned up — the folded-corner note everyone
                recognises. Two paths so the fold reads as a fold rather than a notch. */}
            <path
              d="M2.6 2.6h10.8v7.2L9.8 13.4H2.6z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
            <path
              d="M13.4 9.8H9.8v3.6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
          </svg>
          {/* OPEN notes only. A count that included finished ones would keep nagging about work
              already done, which is how a badge stops meaning anything. */}
          {notes > 0 && <span className="ccard__notes-count">{notes}</span>}
        </button>
      </div>

      <p className="ccard__sub">{dash(s.container)}</p>

      {/* BOTH FACES STAY MOUNTED, stacked in one grid cell, so the card's height is the max of the
          two and flipping never reflows the tray beneath it. No measuring, no fixed height, no
          jump. `inert` keeps Tab out of the hidden one — otherwise focus lands in an invisible
          textarea. */}
      <div className="ccard__faces">
        <div className="ccard__face" data-on={!notesFace} inert={notesFace ? '' : undefined}>
          <dl className="ccard__facts">
            {/* Ends at Lastcy, NOT at the port of discharge. The box's journey finishes at the yard,
            and the drayage leg beyond the port is the part ops still has to arrange. */}
            <Fact label="Route" wide>
              {dash(s.port_of_loading)} <span className="ccard__arrow">→</span> {dash(s.Lastcy)}
            </Fact>
            <Fact label="ETD">{dash(s.actual_shipping)}</Fact>
            <Fact label="ETA">
              {dash(s.expected_portdate)}
              {status.detail ? <span className="ccard__muted">{status.detail}</span> : null}
            </Fact>
            {/* Always rendered, '—' while at sea. It used to swap places with the ETA, which meant a
            card silently changed shape on arrival and the two dates could never be read together
            — the exact comparison you want when a box lands late. */}
            <Fact label="Actual port date" wide>
              {dash(s.actual_portdate)}
            </Fact>
            <Fact label="Forwarder">{dash(s.freight_forwarder)}</Fact>
            <Fact label="Drayage">{dash(s.drayage_provider)}</Fact>
            <Fact label="MBL" wide>
              {dash(s.mbl)}
            </Fact>
          </dl>

          {open && (
            <dl className="ccard__facts ccard__facts--more">
              <Fact label="Line items" wide>
                {items.length === 0 ? (
                  <span className="ccard__muted ccard__muted--bare">No line items</span>
                ) : (
                  <ul className="ccard__items">
                    {items.map((i, n) => (
                      <li key={`${i.po_number}-${i.item}-${n}`}>
                        <span className="ccard__item-po">{dash(i.po_number)}</span>
                        <span className="ccard__item-name">{dash(i.item)}</span>
                        <span className="ccard__item-qty">
                          {Number(i.qty || 0).toLocaleString()}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Fact>
            </dl>
          )}
        </div>

        <div
          className="ccard__face ccard__face--notes"
          data-on={notesFace}
          inert={notesFace ? undefined : ''}
        >
          <NotesPad shipment={s.shipment} active={notesFace} />
        </div>
      </div>
    </article>
  )
}
