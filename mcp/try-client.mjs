// Connects to the Journeys MCP server like an AI app would, lists its tools and calls a few.
// Usage: node mcp/try-client.mjs [userDataFolder]   (defaults to %APPDATA%\journeys)
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = join(import.meta.dirname, '..')
const electron = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
if (process.argv[2]) env.JOURNEYS_USER_DATA = process.argv[2]

const client = new Client({ name: 'journeys-try', version: '0.0.1' })
await client.connect(new StdioClientTransport({ command: electron, args: [join(root, 'mcp', 'journeys-mcp.mjs')], env }))

const { tools } = await client.listTools()
console.log('tools:', tools.map((t) => t.name).join(', '))
console.log('instructions:', (client.getInstructions() ?? '').slice(0, 90) + '…')
for (const [name, args] of [
  ['get_current_flight', {}],
  ['find_airports_nearby', { lat: 37.9143, lon: -120.4761, radius_nm: 15, limit: 3 }],
  ['get_journeys', {}],
  ['get_logbook', { limit: 3 }],
  ['get_hangar', {}],
  ['get_places', {}]
]) {
  const result = await client.callTool({ name, arguments: args })
  const text = result.content[0].text
  console.log(`\n${name}${result.isError ? ' (error)' : ''}:\n${text.length > 700 ? text.slice(0, 700) + '…' : text}`)
}
await client.close()
