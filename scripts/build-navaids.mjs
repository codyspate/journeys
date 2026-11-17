// Trims the OurAirports navaids CSV (public domain) to the VORs the radio-navigation planner uses.
// Source: https://davidmegginson.github.io/ourairports-data/navaids.csv
// Usage: node scripts/build-navaids.mjs <navaids.csv> <output.json>
//
// Only VOR, VOR-DME and VORTAC stations are kept. Each gets a service class, which sets how far away
// it can be received: T (terminal), L (low) or H (high), and the magnetic variation its radials are
// measured from (east positive): the station's own slaved variation where known, otherwise the local one.
import { readFileSync, writeFileSync } from 'node:fs'

function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field.replace(/\r$/, ''))
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if (field || row.length) rows.push([...row, field])
  const [header, ...body] = rows
  return body.map((values) => Object.fromEntries(header.map((key, index) => [key, values[index] ?? ''])))
}

const TYPES = new Set(['VOR', 'VOR-DME', 'VORTAC'])

/** Usage type first, then transmitter power, as the FAA classes them. */
function serviceClass(usage, power) {
  if (usage === 'TERMINAL') return 'T'
  if (usage === 'LO') return power === 'LOW' ? 'T' : 'L'
  if (power === 'HIGH') return 'H'
  if (power === 'LOW') return 'T'
  return 'L'
}

const [input, output] = process.argv.slice(2)
if (!input || !output) throw new Error('Usage: node scripts/build-navaids.mjs <navaids.csv> <output.json>')

const rows = parseCsv(readFileSync(input, 'utf8'))
  // RNAV-only entries aren't stations you can tune, and a VOR is always between 108 and 118 MHz.
  .filter((n) => TYPES.has(n.type) && n.usageType !== 'RNAV' && n.ident && Number(n.frequency_khz) >= 108000 && Number(n.frequency_khz) <= 118000)
  .map((n) => [
    n.ident,
    n.name,
    n.type,
    Number(n.frequency_khz),
    Number(Number(n.latitude_deg).toFixed(4)),
    Number(Number(n.longitude_deg).toFixed(4)),
    Math.round(Number(n.elevation_ft) || 0),
    serviceClass(n.usageType, n.power),
    n.iso_country,
    Number(Number(n.slaved_variation_deg || n.magnetic_variation_deg || 0).toFixed(1))
  ])
  .filter((row) => Number.isFinite(row[4]) && Number.isFinite(row[5]))
  .sort((a, b) => a[0].localeCompare(b[0]))

writeFileSync(output, JSON.stringify(rows))
console.log(`${rows.length} VORs written to ${output}`)
