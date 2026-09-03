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
    actual_shipping: daysAgo(83),
    expected_portdate: daysAhead(31),
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
    expected_portdate: '2026-08-30',
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
    port_of_discharge: 'Los Angeles, CA',
    Lastcy: 'Denver, CO',
    sea_route: 'Bangkok, Thailand - Los Angeles, CA',
    rail_route: 'Los Angeles, CA - Denver, CO',
    actual_shipping: '2026-07-01',
    expected_portdate: '2026-08-29',
    actual_portdate: '2026-08-20',
    expected_lastcy_date: '2026-09-01', // TEST: red container at New York (> 3 days at CY, no appointment)
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
  // WHAT MAKES THESE THREE ONE VOYAGE: same vessel name, same actual_shipping, same
  // expected_portdate. All three, or holders.js gives the odd one out its own hull — the rule is
  // vessel + ETD + ETA, and neither a shared route nor a shared name will substitute for a date.
  //
  // They previously carried ETAs a month apart (2026-09-01 and 2026-09-30) while claiming to be
  // one voyage, and that claim is what the "3 containers" badge was really counting. Under the
  // current rule those dates would draw CAUTIN twice, in two places — the honest picture of them.
  //
  // RELATIVE, not hardcoded, for the reason at the top of this file: an absolute date silently
  // changes what the fixture demonstrates once the clock moves past it. daysAgo(83) ->
  // daysAhead(31) pins this voyage at 73% elapsed — the only mid-ocean vessel here — for good.
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
    actual_shipping: daysAgo(83),
    expected_portdate: daysAhead(31), // one voyage with 3904/3952 — vessel + ETD + ETA all match
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
    actual_shipping: daysAgo(83),
    expected_portdate: daysAhead(31), // one sailing with 3904/3951 — vessel + POL + ETD all match
    actual_portdate: '',
    appointment_date: '',
    arrival_notice: 'yes',
    last_freeday: '',
    items: [
      { po_number: 'PO155563', item: 'KRSP-NK161118', qty: 1180, vendor: 'Junsun Packaging (Thailand) Co., Ltd.' },
    ],
  },
  // TEST: the MULTI-DROP SAILING. Same hull, same origin and the same departure as 3904 / 3951 /
  // 3952 — and a different discharge port, nine days further on. CAUTIN calls at New York, drops
  // three boxes, then carries this one down to Norfolk.
  //
  // Grouped on vessel + POL + ETD (holders.js), so all four are ONE marker: badge 4 while the ship
  // is short of New York, badge 1 once those three report an actual_portdate.
  //
  // Its `route` says Cartagena -> Norfolk and is deliberately NOT what the ship is drawn on. The
  // itinerary is Cartagena -> New York -> Norfolk, and that second leg is real geometry from the
  // US matrix now in sea_routes (568.9 km, 23 points).
  //
  // Under the old five-field voyage key this row was a SECOND CAUTIN, standing alone on a direct
  // Cartagena -> Norfolk line the ship never sails. That is the bug it exists to hold shut.
  {
    shipment: 'INBSHIP3953',
    container: 'HLBU2401993',
    vessel: 'CAUTIN',
    confirmed_carrier: 'HPL',
    freight_forwarder: 'Constellation Logistics LLC',
    drayage_provider: '',
    hbl: 'HLCUSGN2603ARQS4',
    mbl: 'HLCUSGN2603ARQS1',
    port_of_loading: 'Cartagena, Colombia',
    port_of_discharge: 'Norfolk, VA',
    Lastcy: 'Norfolk, VA',
    route: 'Cartagena, Colombia - Norfolk, VA',
    actual_shipping: daysAgo(83), // the same sailing as 3904 / 3951 / 3952
    expected_portdate: daysAhead(40), // the SECOND call, 9 days after New York's daysAhead(31)
    actual_portdate: '',
    appointment_date: '',
    arrival_notice: 'no',
    last_freeday: '',
    items: [
      { po_number: 'PO155712', item: 'KRSP-NK161204', qty: 860, vendor: 'Junsun Packaging (Thailand) Co., Ltd.' },
    ],
  },
  // TEST: A SAILING THAT LOADS AT TWO PORTS. BUDAPEST works down the Indian coast — Pipavav first,
  // Nhava Sheva a week later — then crosses to Los Angeles. Two calls at the ORIGIN end, the mirror
  // of CAUTIN's two calls at the discharge end.
  //
  // The dates put it MID-LOAD on purpose, which is the only state where every part of the
  // behaviour is visible at once:
  //
  //   3972  Pipavav      ETD 3 days ago    -> enroute, aboard, badge 1
  //   3971  Nhava Sheva  ETD in 4 days     -> future, waiting on an ORIGIN card at Nhava Sheva
  //   ship                                 -> on leg 1, Pipavav -> Nhava Sheva (460.4 km)
  //
  // Once 3971's ETD passes the badge becomes 2 and the Nhava Sheva card empties, with no special
  // case anywhere: loading is just a container ceasing to be `future`.
  //
  // THE ORDER COMES FROM THE DATES, NOT FROM ROW ORDER — 3971 is written first and called second.
  // That is worth having in the fixture: a chain assembled in file order would look identical on
  // the old Nhava-Sheva-first data and wrong here.
  //
  // The two rows have a DIFFERENT port of loading AND a different ETD, so no key built from one
  // row could group them — this is the fixture that forced holders.js to cluster per vessel
  // (assignSailings). Their loads are 7 days apart, well inside LOAD_WINDOW_DAYS; WAN HAI 272's
  // two Bangkok sailings are 99 days apart and must stay separate.
  {
    shipment: 'INBSHIP3971',
    container: 'TGBU5540118',
    vessel: 'BUDAPEST',
    confirmed_carrier: '',
    freight_forwarder: 'Constellation Logistics LLC',
    drayage_provider: '',
    hbl: 'HLCUBOM2609ARTX4',
    mbl: 'HLCUBOM2609ARTX1',
    port_of_loading: 'Nhava Sheva, India',
    port_of_discharge: 'Los Angeles, CA',
    Lastcy: 'Los Angeles, CA',
    route: 'Nhava Sheva, India - Los Angeles, CA',
    actual_shipping: daysAhead(4), // NOT sailed: still waiting for the ship to reach Nhava Sheva
    expected_portdate: daysAhead(34),
    actual_portdate: '',
    appointment_date: '',
    arrival_notice: 'no',
    last_freeday: '',
    items: [
      { po_number: 'PO155884', item: 'KRSP-NK161390', qty: 1420, vendor: 'Shree Ganesh Polymers Pvt. Ltd.' },
    ],
  },
  {
    shipment: 'INBSHIP3972',
    container: 'TGBU5612044',
    vessel: 'BUDAPEST',
    confirmed_carrier: '',
    freight_forwarder: 'Constellation Logistics LLC',
    drayage_provider: '',
    hbl: 'HLCUBOM2609ARTX7',
    mbl: 'HLCUBOM2609ARTX1',
    port_of_loading: 'Pipavav, India',
    port_of_discharge: 'Los Angeles, CA',
    Lastcy: 'Los Angeles, CA',
    route: 'Pipavav, India - Los Angeles, CA',
    actual_shipping: daysAgo(3), // sailed: the ship has left Pipavav
    expected_portdate: daysAhead(34),
    actual_portdate: '',
    appointment_date: '',
    arrival_notice: 'no',
    last_freeday: '',
    items: [
      { po_number: 'PO155901', item: 'KRSP-NK161402', qty: 980, vendor: 'Shree Ganesh Polymers Pvt. Ltd.' },
    ],
  },
  // TEST: the LOS ANGELES / LONG BEACH complex. Two blue containers, one at each port, which
  // places.js folds into a single card named "Los Angeles, CA" (PORT_ALIASES). The two anchors are
  // only 4.6 km apart, so without the merge their cards sit on top of each other.
  //
  // Each container's own card in the tray still names the port it is actually at — the merge is
  // display only.
  {
    shipment: 'INBSHIP3961',
    container: 'MSCU7781203',
    vessel: 'MSC ANNA',
    confirmed_carrier: 'MSC',
    freight_forwarder: 'Topocean Consolidation Service (Los Angeles)',
    drayage_provider: 'Unis Transportation, LLC',
    hbl: 'MEDUL9920145',
    mbl: 'MEDUL9920145',
    port_of_loading: 'Bangkok, Thailand',
    port_of_discharge: 'Los Angeles, CA',
    Lastcy: 'Los Angeles, CA',
    route: 'Bangkok, Thailand - Los Angeles, CA',
    actual_shipping: daysAgo(34),
    expected_portdate: daysAgo(1),
    actual_portdate: daysAgo(1),
    appointment_date: '',
    arrival_notice: 'yes',
    last_freeday: daysAhead(4),
    items: [
      { po_number: 'PO155560', item: 'TCCF-NK10712', qty: 520, vendor: 'Junsun Packaging (Thailand) Co., Ltd.' },
    ],
  },
  {
    // NOTE: sea_routes has no lane into Long Beach — every US west-coast lane lands at
    // "Los Angeles, CA". Harmless here because an arrived container is anchored by its PORT, not by
    // the route's last vertex; it would matter if this one were still at sea.
    shipment: 'INBSHIP3962',
    container: 'MSCU8830471',
    vessel: 'MSC ANNA',
    confirmed_carrier: 'MSC',
    freight_forwarder: 'Topocean Consolidation Service (Los Angeles)',
    drayage_provider: 'Unis Transportation, LLC',
    hbl: 'MEDUL9920146',
    mbl: 'MEDUL9920145',
    port_of_loading: 'Bangkok, Thailand',
    port_of_discharge: 'Long Beach, CA',
    Lastcy: 'Long Beach, CA',
    route: 'Bangkok, Thailand - Long Beach, CA',
    actual_shipping: daysAgo(34),
    expected_portdate: daysAgo(1),
    actual_portdate: daysAgo(1),
    appointment_date: '',
    arrival_notice: 'yes',
    last_freeday: daysAhead(4),
    items: [
      { po_number: 'PO155561', item: 'PARE-WT10712', qty: 410, vendor: 'Junsun Packaging (Thailand) Co., Ltd.' },
    ],
  },
  // TEST: an INTRA-COMPLEX transfer. Discharged at Los Angeles, delivered to a Long Beach yard,
  // and it even carries an expected_lastcy_date — so the plain "POD != Lastcy" rule called this
  // rail and drew a railcar crawling across the harbour. isIntermodal now compares CANONICAL keys,
  // so this is an ordinary arrival: actual_portdate decides, and it joins the Los Angeles card.
  {
    shipment: 'INBSHIP3963',
    container: 'TCLU4419388',
    vessel: 'MSC ANNA',
    confirmed_carrier: 'MSC',
    freight_forwarder: 'Topocean Consolidation Service (Los Angeles)',
    drayage_provider: 'Unis Transportation, LLC',
    hbl: 'MEDUL9920147',
    mbl: 'MEDUL9920145',
    port_of_loading: 'Bangkok, Thailand',
    port_of_discharge: 'Los Angeles, CA',
    Lastcy: 'Long Beach, CA',
    route: 'Bangkok, Thailand - Los Angeles, CA',
    actual_shipping: daysAgo(34),
    expected_portdate: daysAgo(2),
    actual_portdate: daysAgo(2),
    expected_lastcy_date: daysAhead(5),
    appointment_date: '',
    arrival_notice: 'yes',
    last_freeday: daysAhead(3),
    items: [
      { po_number: 'PO155562', item: 'DFGR-WT10712', qty: 300, vendor: 'Junsun Packaging (Thailand) Co., Ltd.' },
    ],
  },
]

export default inboundShipments
