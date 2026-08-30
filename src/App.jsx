import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import MapView from './components/MapView'
import Sidebar from './components/Sidebar'
import inboundShipments from './data/inboundShipments'
import { buildSearchIndex, matchIds } from './lib/search'
import { subscribe, notesRevision, allNotes } from './lib/notes'
import './App.css'

function App() {
  const [selected, setSelected] = useState(null)
  // `query` is what is in the box, live. `filter` is what has been COMMITTED — Enter or a picked
  // suggestion. They are separate on purpose: typing must not touch the map, because committing
  // runs a full rebuild of every vessel feature and every port card's SVG.
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState(null)

  // The index is derived from two sources with different lifetimes: shipments, which are static,
  // and notes, which a user writes at runtime. Subscribing to the notes revision is what makes a
  // note searchable the moment it is saved rather than on the next reload.
  const notesRev = useSyncExternalStore(subscribe, notesRevision, notesRevision)
  const index = useMemo(
    () => buildSearchIndex(inboundShipments, allNotes()),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- allNotes() is read through notesRev
    [notesRev],
  )

  // MEMOIZED, and that is load-bearing rather than an optimisation. This Set is a dependency of
  // MapView's rebuild effect, which compares by identity — rebuilt inline it would tear down and
  // re-register the map's zoomend/rotateend listeners and redraw the world on every render.
  const matchedIds = useMemo(() => matchIds(index, filter), [index, filter])

  const clearFilter = useCallback(() => {
    setQuery('')
    setFilter(null)
  }, [])

  // Committing while a holder is open would leave the tray showing a selection and hide the
  // results behind it — so a search drops the selection and answers the question that was asked.
  const commitFilter = useCallback((next) => {
    setFilter(next)
    setSelected(null)
  }, [])

  return (
    <div className="app-layout">
      <Sidebar
        shipments={inboundShipments}
        selected={selected}
        index={index}
        query={query}
        filter={filter}
        matchedIds={matchedIds}
        onQueryChange={setQuery}
        onCommit={commitFilter}
        onClear={clearFilter}
      />
      <MapView shipments={inboundShipments} onSelect={setSelected} matchedIds={matchedIds} />
    </div>
  )
}

export default App
