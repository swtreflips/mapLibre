import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { listNotes, addNote, setDone, removeNote, subscribe, relativeTime } from '../lib/notes'
import './NotesPad.css'

// The container card's second face. Same footprint as the fact grid — flipping swaps them rather
// than stacking, which is the whole point: the tray is tight enough that three cards fill it.

export default function NotesPad({ shipment, active }) {
  // useSyncExternalStore, not useState + useEffect: notes live outside React, and this is the API
  // built for that. It also stays correct if the same shipment is mounted twice — a tray card and
  // a search result — because both read the one store rather than each caching a copy.
  // listNotes returns a stable array between writes, which this REQUIRES (see notes.js).
  const notes = useSyncExternalStore(
    subscribe,
    () => listNotes(shipment),
    () => listNotes(shipment),
  )
  const [draft, setDraft] = useState('')
  const inputRef = useRef(null)

  // Focus the composer when the card flips to this face, but NOT on mount: both faces stay in the
  // DOM so the height never jumps, which means every pad in the tray would otherwise fight for
  // focus the moment the list rendered.
  useEffect(() => {
    if (active) inputRef.current?.focus()
  }, [active])

  const save = () => {
    if (!draft.trim()) return
    addNote(shipment, draft)
    setDraft('')
    inputRef.current?.focus()
  }

  return (
    <div className="pad">
      <div className="pad__compose">
        <textarea
          ref={inputRef}
          className="pad__input"
          rows={2}
          value={draft}
          placeholder="Needs a Telex release…"
          onChange={(e) => setDraft(e.target.value)}
          // Cmd/Ctrl+Enter, the conventional accelerator for a multi-line composer. Plain Enter
          // stays a newline — these are operational notes, not chat messages, and losing a
          // half-typed sentence to a stray Return is the worse failure.
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              save()
            }
          }}
        />
        <button type="button" className="pad__save" onClick={save} disabled={!draft.trim()}>
          Add note
        </button>
      </div>

      {notes.length === 0 ? (
        <p className="pad__empty">
          Nothing flagged. Add a reminder or a situation to chase — it stays with this shipment.
        </p>
      ) : (
        <ul className="pad__list">
          {notes.map((n) => (
            <li key={n.id} className={n.done ? 'pad__note pad__note--done' : 'pad__note'}>
              <label className="pad__check">
                <input
                  type="checkbox"
                  checked={n.done}
                  onChange={(e) => setDone(shipment, n.id, e.target.checked)}
                />
                {/* The checkbox needs a name of its own or a screen reader announces a bare
                    control; the visible text is the note itself. */}
                <span className="sr-only">Mark done</span>
              </label>
              <div className="pad__body">
                <p className="pad__text">{n.text}</p>
                <p className="pad__meta">{relativeTime(n.created_at)}</p>
              </div>
              <button
                type="button"
                className="pad__del"
                onClick={() => removeNote(shipment, n.id)}
                aria-label="Delete note"
                title="Delete note"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
