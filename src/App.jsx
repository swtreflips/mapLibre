import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import MapView from './components/MapView'
import Sidebar from './components/Sidebar'
import LoginPage from './components/LoginPage'
import LoadingScreen from './components/LoadingScreen'
import { useSession } from './hooks/useSession'
import { useInboundSnapshot } from './hooks/useInboundSnapshot'
import { buildSearchIndex, matchIds } from './lib/search'
import { subscribe, notesRevision, allNotes } from './lib/notes'
import './App.css'

/**
 * THE SHIPMENTS NO LONGER COME FROM src/data/inboundShipments.js.
 *
 * That file was a hardcoded fixture compiled into the JS bundle, which is impossible to deploy: the
 * bundle carries container numbers, BOLs, forwarders, vendors and PO numbers, and a static bundle is
 * readable by anyone who loads the page. They now come from the latest `inbound_shipments` snapshot,
 * which grants nothing to anon and needs a session.
 *
 * The fixture STAYS in the repo — tools/check-voyage-grouping.mjs asserts against CAUTIN and
 * BUDAPEST by name — but nothing in the app imports it any more.
 */
function App() {
  const { session, loading: authLoading } = useSession()
  const { shipments, snapshot, loading: dataLoading } = useInboundSnapshot(session)
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
    () => buildSearchIndex(shipments, allNotes()),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- allNotes() is read through notesRev
    [shipments, notesRev],
  )

  // MEMOIZED, and that is load-bearing rather than an optimisation. This Set is a dependency of
  // MapView's rebuild effect, which compares by identity — rebuilt inline it would tear down and
  // re-register the map's zoomend/rotateend listeners and redraw the world on every render.
  //
  // A filter arrives one of two ways. A SEARCH names a value and the index resolves it. A SNAPSHOT
  // STAT already knows its answer — computeStats built the Set while counting — so it carries the
  // ids and skips the index entirely. Recomputing "which containers are aging" here would be a
  // second copy of a rule that already exists in two places too many.
  const matchedIds = useMemo(() => filter?.ids ?? matchIds(index, filter), [index, filter])

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

  // THREE GATES, IN THIS ORDER, and the order is the point. `authLoading` must be checked before
  // `session`, or the login screen flashes in front of someone who is already signed in on every
  // single reload — getSession is a round trip, and "not known yet" is not "signed out".
  if (authLoading) return <LoadingScreen message="Checking access…" />
  if (!session) return <LoginPage />
  if (dataLoading) return <LoadingScreen message="Loading shipments…" />

  return (
    <div className="app-layout">
      <Sidebar
        shipments={shipments}
        snapshot={snapshot}
        selected={selected}
        index={index}
        query={query}
        filter={filter}
        matchedIds={matchedIds}
        onQueryChange={setQuery}
        onCommit={commitFilter}
        onClear={clearFilter}
      />
      <MapView shipments={shipments} onSelect={setSelected} matchedIds={matchedIds} />
    </div>
  )
}

export default App
