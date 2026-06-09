import { useState } from 'react'
import MapView from './components/MapView'
import Sidebar from './components/Sidebar'
import inboundShipments from './data/inboundShipments'
import './App.css'

function App() {
  const [selected, setSelected] = useState(null)

  return (
    <div className="app-layout">
      <Sidebar shipments={inboundShipments} selected={selected} />
      <MapView shipments={inboundShipments} onSelect={setSelected} />
    </div>
  )
}

export default App
