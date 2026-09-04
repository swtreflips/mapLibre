// Push a NetSuite inbound-shipment export to Supabase as the new latest snapshot.
//
//   npm run push:snapshot -- InboundShipments821.csv
//   npm run push:snapshot -- InboundShipments821.csv --dry-run
//
// A PUSH REPLACES, IT DOES NOT MERGE. The newest export is the current picture and the one before
// it is history — nobody reconciles yesterday's sheet against today's. So this inserts one row into
// `inbound_shipments` carrying the whole parsed file, and the app reads
// `order by uploaded_at desc limit 1`. Same shape, and the same reasoning, as RatesApp's
// booking_snapshots: a snapshot is a photograph of a file, and a correction is a new photograph.
//
// NODE RATHER THAN PYTHON, unlike the polylines scripts. This repo already carries
// @supabase/supabase-js and a tools/*.mjs convention, and .env already documents the non-VITE_
// SUPABASE_URL / SUPABASE_KEY as "server-side only, never sent to the browser" — which is exactly
// what a service-key push is. One toolchain, no venv.
//
// THE SERVICE KEY IS REQUIRED and must never be the anon one: `inbound_shipments` grants nothing to
// anon by design (it holds customer data, unlike sea_routes), so an anon key gets permission denied.

import { readFileSync } from 'fs'
import { basename } from 'path'
import { createClient } from '@supabase/supabase-js'

const TABLE = 'inbound_shipments'

// ── the file ─────────────────────────────────────────────────────────────────────────

/**
 * Read a CSV that may not be UTF-8.
 *
 * The 2026-09-03 export contained `Thal Limited <?> Pakistan Papersack Division` — a byte NetSuite
 * wrote in cp1252 that UTF-8 cannot decode. Node turns those into U+FFFD silently, so a vendor name
 * would ship into the search index as a broken glyph and never match what anyone types. Decoding
 * UTF-8 first and falling back on the replacement character keeps a genuinely UTF-8 file correct
 * while rescuing a cp1252 one.
 */
function readText(path) {
  const buf = readFileSync(path)
  const utf8 = buf.toString('utf8')
  if (!utf8.includes('�')) return { text: utf8.replace(/^﻿/, ''), encoding: 'utf-8' }
  return { text: buf.toString('latin1').replace(/^﻿/, ''), encoding: 'cp1252 (utf-8 failed)' }
}

/**
 * CSV -> array of row objects.
 *
 * Hand-rolled rather than a dependency because the whole grammar needed is quoted fields, doubled
 * quotes and CRLF — and this file's fields genuinely contain commas ("Los Angeles, CA" is a port
 * name, `"Junsun Packaging (Thailand) Co., Ltd."` a vendor), so splitting on commas is not an
 * option even for a throwaway.
 */
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1 } else quoted = false
      } else field += c
      continue
    }
    if (c === '"') { quoted = true; continue }
    if (c === ',') { row.push(field); field = ''; continue }
    if (c === '\r') continue
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    field += c
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }

  const header = rows.shift().map((h) => h.trim())
  return rows
    .filter((r) => r.some((v) => v.trim() !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])))
}

// ── values ───────────────────────────────────────────────────────────────────────────

const EXCEL_EPOCH = Date.UTC(1899, 11, 30)
const DAY_MS = 86_400_000

/**
 * NetSuite dates -> "YYYY-MM-DD", the only format parseYMD reads.
 *
 * `M/D/YYYY` is what the current export writes. The BARE NUMBER case is not defensive padding: the
 * previous export (InboundShipments.csv) wrote Excel serials — `46111.29832` for a date and `46178`
 * for another — so the same column has arrived both ways from the same system.
 *
 * Anything else returns '' rather than a guess. A wrong date moves a ship across an ocean; a blank
 * one is a state the app already handles (holders.js builds an undated first leg and parks the hull
 * at its load port).
 */
function toYMD(raw) {
  const v = (raw ?? '').trim()
  if (!v) return ''

  if (/^\d+(\.\d+)?$/.test(v)) {
    const d = new Date(EXCEL_EPOCH + Math.floor(Number(v)) * DAY_MS)
    return d.toISOString().slice(0, 10)
  }

  const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (!m) return ''
  const [, mo, da, yr] = m
  return `${yr}-${mo.padStart(2, '0')}-${da.padStart(2, '0')}`
}

const num = (raw) => {
  const n = Number(String(raw ?? '').replace(/,/g, '').trim())
  return Number.isFinite(n) ? n : 0
}

// ── vessel names ─────────────────────────────────────────────────────────────────────

/**
 * Strip the voyage, keep the ship.
 *
 * THIS IS NOT COSMETIC. holders.js groups a sailing on `normalizeKey(vessel)` + the load dates, so
 * a voyage number inside the name splits one hull into several markers — and the ETD clustering
 * cannot rescue it, because the name is the first half of the key. The 2026-09-03 export spelled
 * ONE SAILING three ways:
 *
 *   'ONE HANNOVER'  'ONE HANNOVER 102E'  'ONE HANNOVER  102E (PS3)'
 *
 * all loading Pipavav on 25 Aug. Left alone that is three ships on the map.
 *
 * THE VOYAGE PATTERN IS DELIBERATELY NARROW: digits with an E or W on one end (102E, E056, 6133W).
 * A looser "strip the last token" would also eat `WAN HAI A01` down to `WAN HAI`, and `A01` is not
 * distinguishable from a voyage by shape alone — so it is left exactly as exported. Ship numbers
 * survive too: `WAN HAI 523` and `WAN HAI 359` match nothing here.
 *
 * `VOY` is dropped only after a voyage code has already been taken off it, so `RUBY TOWER VOY 005E`
 * ends at `RUBY TOWER` and a hypothetical ship called VOY-something is untouched.
 *
 * Anything this cannot resolve belongs in tools/vessel-aliases.json.
 */
const VOYAGE = /^(?:[EW]\d{2,4}|\d{2,4}[EW])$/i

export function normalizeVessel(raw, aliases = {}) {
  let name = String(raw ?? '').replace(/\s+/g, ' ').trim()
  if (!name) return ''

  const alias = aliases[name.toLowerCase()]
  if (alias) return alias

  name = name.replace(/\s*\([^)]*\)\s*$/, '').trim()   // trailing (PS3), (INE)
  name = name.replace(/\s*\/\s*\S+\s*$/, '').trim()     // trailing / E244

  const parts = name.split(' ')
  if (parts.length > 1 && VOYAGE.test(parts[parts.length - 1])) parts.pop()
  if (parts.length > 1 && parts[parts.length - 1].toUpperCase() === 'VOY') parts.pop()

  return parts.join(' ') || name
}

// ── the transform ────────────────────────────────────────────────────────────────────

const C = {
  shipment: 'Shipment Number',
  container: 'Container Number',
  vessel: 'Vessel Number',
  carrier: 'Confirmed Carrier',
  forwarder: 'Freight Forwarder',
  drayage: 'Drayage Provider',
  hbl: 'House Bill of Lading',
  mbl: 'Master Bill of Lading',
  pol: 'Port of Loading',
  pod: 'Port of Discharge',
  lastcy: 'Last CY/CFS',
  etd: 'Actual Shipping Date',
  eta: 'Expected Port Date',
  ata: 'Actual Port Date',
  cyDate: 'Expected Last CY/CFS Date',
  appointment: 'Appointment Date',
  lastFree: 'Last Free Day',
  booking: 'Booking Number',
  item: 'Items - Item',
  qtyBilled: 'Items - Quantity Billed',
  qtyExpected: 'Items - Quantity Expected',
  vendor: 'Items - Vendor',
  location: 'Items - Receiving Location',
  brand: 'Brands',
  po: 'Items - PO',
}

/** The CSV is one row per LINE ITEM; a shipment is its rows folded together. */
export function toShipments(rows, aliases = {}) {
  const byId = new Map()
  const vesselSeen = new Map()

  for (const r of rows) {
    const id = r[C.shipment]
    if (!id) continue

    if (!byId.has(id)) {
      const pol = r[C.pol]
      const pod = r[C.pod]
      const lastcy = r[C.lastcy]
      const rawVessel = r[C.vessel]
      const vessel = normalizeVessel(rawVessel, aliases)
      if (rawVessel) vesselSeen.set(rawVessel.replace(/\s+/g, ' ').trim(), vessel)

      // Intermodal is POD != Last CY. The app decides that itself through facilityKey (so an
      // LA -> Long Beach transfer is not rail), but `rail_route` is the lane the track is looked up
      // by and only exists when the box genuinely moves inland.
      const intermodal = Boolean(lastcy) && lastcy !== pod

      byId.set(id, {
        shipment: id,
        container: r[C.container],
        vessel,
        // Kept so a merge can always be audited against what NetSuite actually wrote.
        vessel_raw: rawVessel,
        confirmed_carrier: r[C.carrier],
        freight_forwarder: r[C.forwarder],
        drayage_provider: r[C.drayage],
        hbl: r[C.hbl],
        mbl: r[C.mbl],
        booking_number: r[C.booking],
        receiving_location: r[C.location],
        port_of_loading: pol,
        port_of_discharge: pod,
        Lastcy: lastcy,
        // Derived, not exported. `route` is what a non-intermodal lane is looked up by; the sea/rail
        // pair is what an intermodal one uses (holders.js `seaLane`).
        route: `${pol} - ${pod}`,
        ...(intermodal
          ? { sea_route: `${pol} - ${pod}`, rail_route: `${pod} - ${lastcy}` }
          : {}),
        actual_shipping: toYMD(r[C.etd]),
        expected_portdate: toYMD(r[C.eta]),
        actual_portdate: toYMD(r[C.ata]),
        expected_lastcy_date: toYMD(r[C.cyDate]),
        appointment_date: toYMD(r[C.appointment]),
        last_freeday: toYMD(r[C.lastFree]),
        // Not in the export at all. The fixture has always defaulted it, and the map reads it only
        // to turn a hull green once something has landed at the far end.
        arrival_notice: 'no',
        items: [],
      })
    }

    byId.get(id).items.push({
      po_number: r[C.po],
      item: r[C.item],
      // Billed is what was invoiced; expected is what was ordered. Billed wins when present because
      // it is the later fact, and the map only ever displays this number.
      qty: num(r[C.qtyBilled]) || num(r[C.qtyExpected]),
      vendor: r[C.vendor],
      brand: r[C.brand],
    })
  }

  // Brands are per LINE ITEM — one container carries boxes for several of them — so the shipment
  // carries the distinct set rather than pretending to have one.
  for (const s of byId.values()) {
    s.brands = [...new Set(s.items.map((i) => i.brand).filter(Boolean))].sort()
  }

  return { shipments: [...byId.values()], vesselSeen }
}

// ── run ──────────────────────────────────────────────────────────────────────────────

function env() {
  const text = readFileSync('.env', 'utf8')
  const vars = Object.fromEntries(
    text.split(/\r?\n/)
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
  )
  return vars
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const file = args.find((a) => !a.startsWith('--'))
  if (!file) {
    console.error('usage: npm run push:snapshot -- <file.csv> [--dry-run]')
    return 1
  }

  const { text, encoding } = readText(file)
  const rows = parseCsv(text)
  const aliasFile = JSON.parse(readFileSync('tools/vessel-aliases.json', 'utf8'))
  const { shipments, vesselSeen } = toShipments(rows, aliasFile.aliases ?? {})
  const itemCount = shipments.reduce((n, s) => n + s.items.length, 0)

  console.log(`[snapshot] ${basename(file)} — read as ${encoding}`)
  console.log(`[snapshot] ${rows.length} line-item rows -> ${shipments.length} shipments, ${itemCount} items`)

  // EVERY DISTINCT NAME, AND WHAT IT BECAME. This is the only place a new voyage spelling is
  // visible before it becomes a duplicated ship on the map, so it prints on every run rather than
  // behind a flag.
  const merges = new Map()
  for (const [raw, clean] of vesselSeen) {
    if (!merges.has(clean)) merges.set(clean, [])
    merges.get(clean).push(raw)
  }
  console.log(`\n[snapshot] ${vesselSeen.size} raw vessel name(s) -> ${merges.size} vessel(s)`)
  for (const [clean, raws] of [...merges].sort()) {
    const changed = raws.some((r) => r !== clean)
    console.log(`   ${changed ? '*' : ' '} ${clean}`)
    for (const r of raws) if (r !== clean) console.log(`       from ${JSON.stringify(r)}`)
  }

  const intermodal = shipments.filter((s) => s.rail_route)
  if (intermodal.length) {
    console.log(`\n[snapshot] ${intermodal.length} intermodal shipment(s):`)
    for (const s of intermodal) {
      console.log(`   ${s.shipment}: ${s.port_of_loading} -> ${s.port_of_discharge} -> ${s.Lastcy}`)
    }
  }

  const noEtd = shipments.filter((s) => !s.actual_shipping)
  if (noEtd.length) {
    console.log(`\n[snapshot] ${noEtd.length} shipment(s) with no ETD (drawn at their load port):`)
    for (const s of noEtd) console.log(`   ${s.shipment} — ${s.vessel || '(no vessel)'}`)
  }

  if (dryRun) {
    console.log('\n[snapshot] --dry-run: nothing written')
    return 0
  }

  const vars = env()
  const url = vars.SUPABASE_URL
  const key = vars.SUPABASE_KEY
  if (!url || !key) {
    console.error('\n[snapshot] SUPABASE_URL / SUPABASE_KEY missing from .env (the SERVICE key, not VITE_)')
    return 1
  }

  // THE TWO HALVES OF .env CAN POINT AT DIFFERENT PROJECTS, and nothing else would notice. The
  // server-side pair here was left over from the standalone project that was deprovisioned when
  // `routes` came across as `sea_routes` (CLAUDE.md §4), while VITE_SUPABASE_URL had moved on to
  // the shared one. A push would have succeeded against a database the app never reads — customer
  // data written somewhere nobody is looking, and a map that stays empty with no error anywhere.
  const ref = (u) => (u || '').match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1] ?? ''
  if (ref(url) !== ref(vars.VITE_SUPABASE_URL)) {
    console.error('\n[snapshot] .env points at TWO DIFFERENT PROJECTS:')
    console.error(`             the app reads   ${ref(vars.VITE_SUPABASE_URL) || '(unset)'}`)
    console.error(`             this would write ${ref(url) || '(unset)'}`)
    console.error('           Refusing. Set SUPABASE_URL / SUPABASE_KEY to the service credentials')
    console.error('           of the project the app actually reads.')
    return 1
  }

  const sb = createClient(url, key)
  const { error } = await sb.from(TABLE).insert({
    file_name: basename(file),
    shipment_count: shipments.length,
    item_count: itemCount,
    payload: shipments,
  })

  if (error) {
    console.error(`\n[snapshot] insert failed: ${error.message}`)
    // The most likely cause by far, and the message alone does not say it.
    console.error('           If this is "permission denied", .env has the ANON key. This table')
    console.error('           grants nothing to anon by design — it needs the service key.')
    return 1
  }

  console.log(`\n[snapshot] pushed. It is now the latest; the previous one stays in history.`)
  return 0
}

// Importable for the tests without running the push.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('push-inbound-snapshot.mjs')) {
  process.exit(await main())
}
