// Trims the OurAirports CSVs (public domain) to the fields the planner needs.
// Source: https://davidmegginson.github.io/ourairports-data/ (airports.csv and runways.csv)
// Usage: node scripts/build-airports.mjs <folder with airports.csv and runways.csv> <output.json>
//
// Every land airport and seaplane base is kept, even with no runway on record, so it can be found, shown
// and flown to. Runway length 0 means unknown; the planner only picks airports with a known, long enough
// land runway. Heliports, balloon ports and closed airports are left out.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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

const HARD = /asp|con|bit|pem|tar|paved/i
const WATER = /water|wtr/i
// Seaplane bases are listed with small airports; their water runways never count as land runways below.
const SIZE = { small_airport: 0, seaplane_base: 0, medium_airport: 1, large_airport: 2 }

const [inputDir, output] = process.argv.slice(2)
const airports = parseCsv(readFileSync(join(inputDir, 'airports.csv'), 'utf8'))
const runways = parseCsv(readFileSync(join(inputDir, 'runways.csv'), 'utf8'))

const longest = new Map()
for (const runway of runways) {
  const length = Number(runway.length_ft)
  if (runway.closed === '1' || !length || WATER.test(runway.surface)) continue
  const best = longest.get(runway.airport_ident)
  if (!best || length > best.length) longest.set(runway.airport_ident, { length, hard: HARD.test(runway.surface) })
}

const rows = []
let unknownRunway = 0
for (const airport of airports) {
  if (!(airport.type in SIZE)) continue
  const runway = longest.get(airport.ident)
  if (!runway) unknownRunway++
  // Other codes the same airport goes by, such as the GPS code the sim often uses, for search and lookups.
  const codes = [...new Set([airport.icao_code, airport.gps_code, airport.local_code, airport.iata_code].map((c) => c.trim().toUpperCase()))].filter(
    (code) => code && code !== airport.ident
  )
  rows.push([
    airport.ident,
    airport.name,
    Number(Number(airport.latitude_deg).toFixed(4)),
    Number(Number(airport.longitude_deg).toFixed(4)),
    Number(airport.elevation_ft) || 0,
    SIZE[airport.type],
    airport.municipality,
    airport.iso_country,
    runway?.length ?? 0,
    runway?.hard ? 1 : 0,
    airport.scheduled_service === 'yes' ? 1 : 0,
    codes
  ])
}

writeFileSync(output, JSON.stringify(rows))
console.log(`${rows.length} airports written to ${output} (${unknownRunway} with no land runway on record)`)
