// Hardcoded dev data, derived from InboundShipments.csv (a NetSuite export).
// The CSV is one row PER LINE-ITEM; here it's collapsed to one object per shipment,
// dates converted M/D/YYYY -> YYYY-MM-DD, and `route` built as "POL - POD".
// Later this comes from Supabase (CLAUDE.md §14). Fields not in the CSV are defaulted:
//   confirmed_carrier: ''   arrival_notice: 'no'
// `items[].po_number` is INVENTED for the dev fixture — the CSV carries no PO column. It lives on
// the line item, not the shipment, because one container consolidates several POs and that is
// where the real column sits (CLAUDE.md §14, `line_items.po_number`).
// `route` is the join key to the Supabase `routes` table.

// ── Status fixtures ──────────────────────────────────────────────────────────────────
//
// Dates for the demo containers below are RELATIVE TO TODAY on purpose. containerColor()
// (src/lib/vesselMath.js) reads them against the current clock — blue only while a container is
// ≤ 3 days at the yard — so a hardcoded date quietly flips blue to red a few days after it is
// written. That already happened twice here: INBSHIP3933 and INBSHIP3894 both carry June dates
// and now render red together, which is why the New York card showed one arm instead of three.
//
// Local midnight, not toISOString(): that formats in UTC and would shift the date by a day for
// anyone west of Greenwich (CLAUDE.md §4).
const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const daysAgo = (n) => {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return ymd(d)
}
const daysAhead = (n) => daysAgo(-n)

const inboundShipments = [
  {
    shipment: 'INBSHIP3904',
    container: 'HLBU2124387',
    vessel: 'CAUTIN',
    confirmed_carrier: '',
    freight_forwarder: 'Constellation Logistics LLC',
    drayage_provider: 'Unis Transportation, LLC',
    hbl: 'HLCUSGN2603ARQR8',
    mbl: 'HLCUSGN2603ARQR8',
    port_of_loading: 'Cartagena, Colombia',
    port_of_discharge: 'New York, NY',
    Lastcy: 'New York, NY',
    route: 'Cartagena, Colombia - New York, NY',
    actual_shipping: '2026-06-08',
    expected_portdate: '2026-09-01',
    actual_portdate: '',
    appointment_date: '',
    arrival_notice: 'no',
    last_freeday: '2026-06-09',
    items: [
      { po_number: 'PO155550', item: 'PECO-FH12717-1/6-A-V3', qty: 49, vendor: 'Goldsun Printing And Packaging Jsc' },
      { po_number: 'PO155551', item: 'PECO-FH12717-1/6-A-V3', qty: 1000, vendor: 'Goldsun Printing And Packaging Jsc' },
    ],
  },
  {
    shipment: 'INBSHIP3933',
    container: 'TGHU6461060',
    vessel: 'SAN FRANCISCO BRIDGE',
    confirmed_carrier: '',
    freight_forwarder: 'Constellation Logistics LLC',
    drayage_provider: 'Unis Transportation, LLC',
    hbl: 'ONEYGING08265300',
    mbl: 'ONEYGING08265300',
    port_of_loading: 'Mundra, India',
    port_of_discharge: 'New York, NY',
    Lastcy: 'New York, NY',
    route: 'Mundra, India - New York, NY',
    actual_shipping: '2026-04-21',
    expected_portdate: '2026-06-20',
    actual_portdate: '2026-06-08', // TEST: was written as "arrived 1 day ago -> blue"; now long past 3 days, so RED
    appointment_date: '',
    arrival_notice: 'no',
    last_freeday: '2026-06-09',
    items: [
      { po_number: 'PO155552', item: 'TGET-NK8510', qty: 960, vendor: 'Paras Webcoat Pvt Ltd' },
    ],
  },
  {
    shipment: 'INBSHIP3893',
    container: 'WHSU6872753',
    vessel: 'WAN HAI 272',
    confirmed_carrier: '',
    freight_forwarder: 'Topocean Consolidation Service (Los Angeles)',
    drayage_provider: 'Unis Transportation, LLC',
    hbl: 'TCS1XQ32522',
    mbl: 'WHLC035GX16983',
    port_of_loading: 'Bangkok, Thailand',
    port_of_discharge: 'New York, NY',
    Lastcy: 'New York, NY',
    route: 'Bangkok, Thailand - New York, NY',
    actual_shipping: '2026-03-24',
    expected_portdate: '2026-06-18',
    actual_portdate: '',
    appointment_date: '',
    arrival_notice: 'no',
    last_freeday: '',
    items: [
      { po_number: 'PO155553', item: 'TCCF-NK10712', qty: 687, vendor: 'Junsun Packaging (Thailand) Co., Ltd.' },
      { po_number: 'PO155554', item: 'TCCF-NK141015', qty: 473, vendor: 'Junsun Packaging (Thailand) Co., Ltd.' },
    ],
  },
  {
    shipment: 'INBSHIP3894',
    container: 'WHSU5211044',
    vessel: 'WAN HAI 272',
    confirmed_carrier: '',
    freight_forwarder: 'Topocean Consolidation Service (Los Angeles)',
    drayage_provider: 'Unis Transportation, LLC',
    hbl: 'TCS1XQ32522',
    mbl: 'WHLC035GX16983',
    port_of_loading: 'Bangkok, Thailand',
    port_of_discharge: 'New York, NY',
    Lastcy: 'Cincinnati, OH',
    sea_route: 'Bangkok, Thailand - New York, NY',
    rail_route: 'New York, NY - Cincinnati, OH',
    actual_shipping: '2026-07-01',
    expected_portdate: '2026-08-29',
    actual_portdate: '2026-08-29',
    expected_lastcy_date: '2026-09-10', // TEST: red container at New York (> 3 days at CY, no appointment)
    appointment_date: '',
    arrival_notice: 'no',
    last_freeday: '',
    items: [
      { po_number: 'PO155555', item: 'BLBR-NK13713', qty: 151, vendor: 'Junsun Packaging (Thailand) Co., Ltd.' },
      { po_number: 'PO155556', item: 'PARE-WT10712', qty: 300, vendor: 'Junsun Packaging (Thailand) Co., Ltd.' },
      { po_number: 'PO155557', item: 'DFGR-WT10712', qty: 760, vendor: 'Junsun Packaging (Thailand) Co., Ltd.' },
    ],
  },
  {
    shipment: 'INBSHIP3909',
    container: 'WHSU5445720',
    vessel: 'CHICAGO EXPRESS',
    confirmed_carrier: '',
    freight_forwarder: 'Topocean Consolidation Service (Los Angeles)',
    drayage_provider: '',
    hbl: 'TCS1XQ42854',
    mbl: 'WHLC035GX19186',
    port_of_loading: 'Bangkok, Thailand',
    port_of_discharge: 'Philadelphia, PA',
    Lastcy: 'Philadelphia, PA',
    route: 'Bangkok, Thailand - Philadelphia, PA',
    actual_shipping: '2026-08-23',
    expected_portdate: '2026-08-30',
    actual_portdate: '2026-08-22',
    appointment_date: '',
    arrival_notice: 'no',
    last_freeday: '',
    items: [
      { po_number: 'PO155558', item: 'KRSP-NK161118', qty: 749, vendor: 'Junsun Packaging (Thailand) Co., Ltd.' },
    ],
  },
  {
    // TEST: BLUE — arrived 2 days ago, no appointment yet. Blue = recently landed, nothing wrong.
    // Fills the NORTHWEST arm of the New York card.
    shipment: 'INBSHIP3941',
    container: 'MSCU4471902',
    vessel: 'MSC ISABELLA',
    confirmed_carrier: '',
    freight_forwarder: 'Constellation Logistics LLC',
    drayage_provider: 'Unis Transportation, LLC',
    hbl: 'MEDUQD284416',
    mbl: 'MEDUQD284416',
    port_of_loading: 'Cartagena, Colombia',
    port_of_discharge: 'New York, NY',
    Lastcy: 'New York, NY',
    route: 'Cartagena, Colombia - New York, NY',
    actual_shipping: daysAgo(16),
    expected_portdate: daysAgo(2),
    actual_portdate: daysAgo(2),
    appointment_date: '',
    arrival_notice: 'yes',
    last_freeday: daysAhead(3),
    items: [
      { po_number: 'PO155559', item: 'PECO-FH12717-1/6-A-V3', qty: 640, vendor: 'Goldsun Printing And Packaging Jsc' },
    ],
  },
  {
    // TEST: GREEN — sitting 6 days but a drayage appointment is booked, so it is handled.
    // appointment_date wins over days-at-CY in containerColor(), which is the whole point of the
    // rule: green means "someone is on it", not "recently arrived". Fills the SOUTH arm.
    shipment: 'INBSHIP3942',
    container: 'ONEU7783015',
    vessel: 'ONE OLYMPUS',
    confirmed_carrier: '',
    freight_forwarder: 'Topocean Consolidation Service (Los Angeles)',
    drayage_provider: 'Unis Transportation, LLC',
    hbl: 'ONEYGING08301744',
    mbl: 'ONEYGING08301744',
    port_of_loading: 'Mundra, India',
    port_of_discharge: 'New York, NY',
    Lastcy: 'New York, NY',
    route: 'Mundra, India - New York, NY',
    actual_shipping: daysAgo(52),
    expected_portdate: daysAgo(6),
    actual_portdate: daysAgo(6),
    appointment_date: daysAhead(1),
    arrival_notice: 'yes',
    last_freeday: daysAhead(2),
    items: [
      { po_number: 'PO155560', item: 'TGET-NK8510', qty: 480, vendor: 'Paras Webcoat Pvt Ltd' },
    ],
  },
  // TEST: two more containers on a vessel that already has one, so CAUTIN holds 3 and the vessel
  // tray has something to show. Every en-route vessel held exactly one container while the map's
  // count badge claimed 7 — see CLAUDE.md §8.
  //
  // Same vessel AND same route is what makes the three one holder. Their dates must also track
  // INBSHIP3904's, because a ship is in one place: if these drift apart, holders.js positions the
  // vessel at the LATEST of them and logs the disagreement, which is the warning you will see.
  {
    shipment: 'INBSHIP3951',
    container: 'HLBU2201884',
    vessel: 'CAUTIN',
    confirmed_carrier: 'HPL',
    freight_forwarder: 'Constellation Logistics LLC',
    drayage_provider: 'Unis Transportation, LLC',
    hbl: 'HLCUSGN2603ARQS1',
    mbl: 'HLCUSGN2603ARQS1',
    port_of_loading: 'Cartagena, Colombia',
    port_of_discharge: 'New York, NY',
    Lastcy: 'New York, NY',
    route: 'Cartagena, Colombia - New York, NY',
    actual_shipping: '2026-06-08',
    expected_portdate: '2026-09-30', // tracks INBSHIP3904 — same voyage
    actual_portdate: '',
    appointment_date: '',
    arrival_notice: 'no',
    last_freeday: '',
    items: [
      { po_number: 'PO155561', item: 'PECO-FH12717-1/6-A-V3', qty: 820, vendor: 'Goldsun Printing And Packaging Jsc' },
      { po_number: 'PO155562', item: 'TGET-NK8510', qty: 240, vendor: 'Paras Webcoat Pvt Ltd' },
    ],
  },
  {
    shipment: 'INBSHIP3952',
    container: 'HLBU2318007',
    vessel: 'CAUTIN',
    confirmed_carrier: 'HPL',
    freight_forwarder: 'Constellation Logistics LLC',
    drayage_provider: '',
    hbl: 'HLCUSGN2603ARQS2',
    mbl: 'HLCUSGN2603ARQS1',
    port_of_loading: 'Cartagena, Colombia',
    port_of_discharge: 'New York, NY',
    Lastcy: 'New York, NY',
    route: 'Cartagena, Colombia - New York, NY',
    actual_shipping: '2026-06-08',
    expected_portdate: '2026-09-01', // tracks INBSHIP3904 — same voyage
    actual_portdate: '',
    appointment_date: '',
    arrival_notice: 'yes',
    last_freeday: '',
    items: [
      { po_number: 'PO155563', item: 'KRSP-NK161118', qty: 1180, vendor: 'Junsun Packaging (Thailand) Co., Ltd.' },
    ],
  },
]

export default inboundShipments
