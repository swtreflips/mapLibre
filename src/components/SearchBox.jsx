import { useEffect, useMemo, useRef, useState } from 'react'
import { suggest, KIND_LABELS } from '../lib/search'
import './SearchBox.css'

// The search box, modelled on NetSuite's global search rather than a filter form.
//
// TYPING SUGGESTS; IT DOES NOT FILTER. The filter applies on commit — Enter, or picking a
// suggestion. That split is not a UX preference, it is what keeps the map usable: committing runs
// a full rebuild (vessel setData plus every port card's innerHTML), and doing that per keystroke
// would make the box feel like it was dragging the whole ocean behind it. Suggestions are a cheap
// scan over an in-memory index and can run freely.
//
// It is also the app's first text input and first overlay, so the vocabulary is set here: the
// focus ring, the dropdown surface and the chrome-stripped option rows are all lifted from
// ContainerCard rather than invented, so the two read as one family.

const SearchIcon = () => (
  <svg className="sbox__icon" viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
    <line x1="10.4" y1="10.4" x2="14" y2="14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
)

export default function SearchBox({ index, query, filter, onQueryChange, onCommit, onClear }) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const wrapRef = useRef(null)
  const inputRef = useRef(null)

  const suggestions = useMemo(() => suggest(index, query), [index, query])

  // Grouped for display, and the flat list is rebuilt FROM the groups so the keyboard order is
  // exactly the order on screen. Ranking alone would interleave kinds (a prefix match of one kind
  // outranks a substring match of another), which would either repeat group headers or make ↓ jump
  // around the list.
  const groups = useMemo(() => {
    const out = []
    const byKind = new Map()
    for (const entry of suggestions) {
      let group = byKind.get(entry.kind)
      if (!group) {
        group = { kind: entry.kind, items: [] }
        byKind.set(entry.kind, group)
        out.push(group)
      }
      group.items.push(entry)
    }
    return out
  }, [suggestions])

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups])

  // Click-away. The dropdown is not modal — it should close when you go back to the map, and the
  // map is a sibling that never sees these events otherwise.
  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const commit = (entry) => {
    if (entry) {
      onQueryChange(entry.value)
      onCommit({ kind: entry.kind, value: entry.value })
    } else if (query.trim()) {
      // Raw text, deliberately BROADER than a picked suggestion — the user typed something and
      // chose nothing, so match anything containing it rather than guessing a field.
      onCommit({ kind: 'text', value: query.trim() })
    }
    setOpen(false)
    setActive(-1)
  }

  const clear = () => {
    onClear()
    setOpen(false)
    setActive(-1)
    inputRef.current?.focus()
  }

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!flat.length) return
      e.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      const step = e.key === 'ArrowDown' ? 1 : -1
      // Wraps through -1, which is "no option highlighted" — that slot is what lets you get back
      // to committing the raw text after arrowing into the list.
      setActive((i) => {
        const next = i + step
        if (next < -1) return flat.length - 1
        if (next >= flat.length) return -1
        return next
      })
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      commit(open && active >= 0 ? flat[active] : null)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      // Two-stage: dismiss the dropdown first, then drop the committed filter. Otherwise one
      // Escape while browsing suggestions would throw away the filter you already had.
      if (open) setOpen(false)
      else if (filter || query) clear()
    }
  }

  const showClear = Boolean(query || filter)

  return (
    <div className="sbox" ref={wrapRef}>
      <div className="sbox__field">
        <SearchIcon />
        <input
          ref={inputRef}
          type="text"
          className="sbox__input"
          placeholder="Shipment, container, item, PO…"
          value={query}
          onChange={(e) => {
            onQueryChange(e.target.value)
            setOpen(true)
            // Drop the highlight on every edit. A stale one is worse than none: the list is
            // re-ranked under the cursor, so the slot that meant "PO155550" a keystroke ago can
            // mean a container number now, and Enter would commit something never read.
            setActive(-1)
          }}
          onFocus={() => query && setOpen(true)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={open && flat.length > 0}
          aria-controls="sbox-listbox"
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? `sbox-opt-${active}` : undefined}
          aria-label="Search shipments"
        />
        {showClear && (
          <button type="button" className="sbox__clear" onClick={clear} aria-label="Clear search">
            ✕
          </button>
        )}
      </div>

      {open && flat.length > 0 && (
        // onMouseDown preventDefault, not onClick alone: mousedown blurs the input first, and the
        // click-away listener above would close the list before the click ever landed on an option.
        <ul
          className="sbox__list"
          id="sbox-listbox"
          role="listbox"
          onMouseDown={(e) => e.preventDefault()}
        >
          {groups.map((group) => (
            <li key={group.kind} className="sbox__group" role="presentation">
              <p className="sbox__grouplabel">{KIND_LABELS[group.kind] ?? group.kind}</p>
              <ul role="presentation">
                {group.items.map((entry) => {
                  const i = flat.indexOf(entry)
                  const n = entry.ids.size
                  return (
                    <li
                      key={`${entry.kind}-${entry.folded}`}
                      id={`sbox-opt-${i}`}
                      role="option"
                      aria-selected={i === active}
                      className={i === active ? 'sbox__opt sbox__opt--active' : 'sbox__opt'}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => commit(entry)}
                    >
                      {/* A note is prose, not an identifier: sans rather than mono, and clamped
                          so a long one cannot stretch the dropdown. Everything else is a reference
                          number, where the mono column is what makes them scannable. */}
                      <span
                        className={
                          entry.kind === 'note' ? 'sbox__value sbox__value--note' : 'sbox__value'
                        }
                      >
                        {entry.value}
                      </span>
                      <span className="sbox__count">{n}</span>
                    </li>
                  )
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {open && query.trim() && flat.length === 0 && (
        <div className="sbox__list sbox__empty">No shipment, container, item or PO matches that.</div>
      )}
    </div>
  )
}
