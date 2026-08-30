// Container notes — what ops needs to say about a box that the feed cannot tell them.
// "INBSHIP3941 needs a Telex release." A reminder, an exception, a thing to chase.
//
// LOCAL FOR NOW, BUT SHAPED LIKE THE TABLE IT BECOMES. Every record carries the fields
// CLAUDE.md §14's `issues` table specifies, so moving to Supabase is this one file — no component
// changes, no shape migration. That is the whole reason the API is functions rather than a bare
// localStorage call at each call site.
//
// WHY NOT SUPABASE ALREADY: there is no auth (§13), and the anon key ships inside a public JS
// bundle from a public repo. Granting anon INSERT would let anyone who finds it write into the
// database, and notes carry customer and operational detail. Read-only exposure is a different
// thing from a public write path. The cost, stated plainly: notes live in ONE BROWSER and the team
// does not see each other's until auth lands.

const KEY = 'inbound.notes.v1'

// Notes are keyed on `shipment` — the NetSuite Inbound Shipment number — because §14 requires them
// to survive every snapshot push, and that id is the stable, unique one. Container numbers get
// reused across voyages; shipment ids do not.

// localStorage throws, and not only in exotic cases: a private window can deny access outright and
// a full quota rejects the write. A notepad that takes the whole dashboard down with it is worse
// than one that quietly forgets, so every read and write is guarded and failure degrades to "no
// notes" rather than an exception.
function readAll() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeAll(all) {
  try {
    localStorage.setItem(KEY, JSON.stringify(all))
    return true
  } catch {
    return false
  }
}

// ── The store, and why it is cached ──────────────────────────────────────────────────
//
// Components read this through useSyncExternalStore, which re-runs the snapshot on every render
// and bails only if the result is REFERENTIALLY equal. A `listNotes` that parsed and sorted afresh
// each call would return a new array every time and spin forever. So the parsed store and each
// shipment's sorted view are memoised, and writes clear the memo.
//
// It doubles as the obvious win: no JSON.parse on every keystroke in the composer.
let store = null
let revision = 0
const snapshots = new Map()
const EMPTY = Object.freeze([])

function load() {
  if (!store) store = readAll()
  return store
}

// The same shipment can be on screen twice — once in a holder's tray, once in a search result — so
// a write in one has to reach the other. A module-level listener set is enough; this does not earn
// a state library.
const listeners = new Set()

export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function commit() {
  writeAll(store)
  snapshots.clear() // identities must change for useSyncExternalStore to see the write
  revision += 1
  for (const fn of listeners) fn()
}

/**
 * A number that changes on every write. For consumers that need to REBUILD something when notes
 * change rather than re-read a list — the search index, which is derived from notes plus static
 * shipment data and so cannot just take a snapshot of either.
 *
 * A counter rather than the store itself, because useSyncExternalStore compares snapshots by
 * identity and `allNotes()` hands back a live object that mutates in place.
 */
export const notesRevision = () => revision

/**
 * Every note, keyed by shipment. Exposed for the search index, which needs all of them at once.
 * The returned object is the LIVE store — read it, do not mutate it.
 */
export const allNotes = () => load()

const newId = () =>
  // crypto.randomUUID is unavailable on plain-http origins in some browsers; this is an id for a
  // local record, not a security token, so a timestamp + random suffix is the right amount of
  // machinery.
  `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

/**
 * All notes for a shipment. OPEN FIRST, then done — newest first within each group.
 * The returned array is STABLE between writes; see the memo above.
 */
export function listNotes(shipment) {
  if (!shipment) return EMPTY
  if (snapshots.has(shipment)) return snapshots.get(shipment)
  const notes = load()[shipment] ?? []
  const sorted =
    notes.length === 0
      ? EMPTY
      : [...notes].sort(
          (a, b) =>
            Number(a.done) - Number(b.done) ||
            // Descending created_at, so the newest open note is the first thing read.
            String(b.created_at).localeCompare(String(a.created_at)),
        )
  snapshots.set(shipment, sorted)
  return sorted
}

/** How many are still outstanding — the number the card's toggle shows. */
export const openCount = (shipment) => listNotes(shipment).filter((n) => !n.done).length

export function addNote(shipment, text) {
  const body = (text ?? '').trim()
  if (!shipment || !body) return null
  const note = {
    id: newId(),
    shipment,
    text: body,
    // Recorded but never populated yet: there is no sign-in, so every note here has one author by
    // definition. The field exists so the record shape does not change when auth lands (§13), and
    // NotesPad deliberately renders no author line for a value that is always empty.
    author: null,
    created_at: new Date().toISOString(),
    done: false,
    done_at: null,
  }
  const all = load()
  all[shipment] = [...(all[shipment] ?? []), note]
  commit()
  return note
}

export function setDone(shipment, id, done) {
  const all = load()
  const notes = all[shipment]
  if (!notes) return
  all[shipment] = notes.map((n) =>
    n.id === id ? { ...n, done, done_at: done ? new Date().toISOString() : null } : n,
  )
  commit()
}

export function removeNote(shipment, id) {
  const all = load()
  const notes = all[shipment]
  if (!notes) return
  const next = notes.filter((n) => n.id !== id)
  if (next.length) all[shipment] = next
  else delete all[shipment] // don't leave empty arrays behind to grow the blob forever
  commit()
}

// Compact relative time. Short by design: the notepad column is ~300px and a full timestamp would
// wrap, while "2h" answers the only question being asked — is this fresh or stale.
export function relativeTime(iso, now = new Date()) {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const secs = Math.round((now.getTime() - t) / 1000)
  if (secs < 60) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  if (days < 7) return `${days}d ago`
  return new Date(t).toISOString().slice(0, 10)
}
