// Trims GeoNames' cities5000 list to the towns used as visual checkpoints on a leg's nav log.
// Source: https://download.geonames.org/export/dump/cities5000.zip (CC BY 4.0, GeoNames, geonames.org).
// Usage: node scripts/build-places.mjs <cities5000.txt> <output.json>
//
// Each row is [name, lat, lon, population, country]: towns of about 5,000 people or more, plus seats of government.
import { readFileSync, writeFileSync } from 'node:fs'

const [input, output] = process.argv.slice(2)
if (!input || !output) throw new Error('Usage: node scripts/build-places.mjs <cities5000.txt> <output.json>')

const rows = readFileSync(input, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => line.split('\t'))
  .map((f) => [f[2] || f[1], Number(Number(f[4]).toFixed(3)), Number(Number(f[5]).toFixed(3)), Number(f[14]) || 0, f[8]])
  .filter(([name, lat, lon]) => name && Number.isFinite(lat) && Number.isFinite(lon))

writeFileSync(output, JSON.stringify(rows))
console.log(`${rows.length} places written to ${output}`)
