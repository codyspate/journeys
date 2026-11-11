// The Journeys MCP server. AI apps such as Claude Desktop or Claude Code start this over stdio; it asks the
// running Journeys app for each answer through a local, token-guarded endpoint. Everything is read-only.
//
// Journeys must be running with "Let AI assistants read your flights" turned on (Settings, AI assistants).
// The app's data folder is found at %APPDATA%\journeys, or set JOURNEYS_USER_DATA to point elsewhere.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const here = dirname(fileURLToPath(import.meta.url))
const userData = process.env.JOURNEYS_USER_DATA || join(process.env.APPDATA || join(process.env.HOME || '', '.config'), 'journeys')
const endpointFile = join(userData, 'mcp-endpoint.json')
// The same tool list the app serves, so clients see every tool even before Journeys is opened.
const fallbackTools = JSON.parse(readFileSync(join(here, 'tools.json'), 'utf8'))

const NOT_SHARING =
  "Journeys isn't sharing right now. Ask the player to open Journeys and turn on “Let AI assistants read your flights” in Settings, under AI assistants."

function endpoint() {
  if (!existsSync(endpointFile)) return null
  try {
    return JSON.parse(readFileSync(endpointFile, 'utf8'))
  } catch {
    return null
  }
}

const server = new Server(
  { name: 'journeys', version: '0.1.0' },
  {
    capabilities: { tools: {} },
    instructions:
      'Journeys is a companion app for Microsoft Flight Simulator. These read-only tools show what the player is flying right now, ' +
      'their multi-leg Journeys, logbook, aircraft and pinned places. Positions come from the sim. When describing places, say which ' +
      'parts come from your own general knowledge rather than from Journeys, since local facts can be wrong. Never give routing, ' +
      'frequencies or procedures as if they were authoritative; the player sets up each flight themselves.'
  }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: endpoint()?.tools ?? fallbackTools }))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const target = endpoint()
  if (!target) return { content: [{ type: 'text', text: NOT_SHARING }], isError: true }
  try {
    const response = await fetch(target.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${target.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: request.params.name, args: request.params.arguments ?? {} }),
      signal: AbortSignal.timeout(10_000)
    })
    const body = await response.json()
    if (body.error) return { content: [{ type: 'text', text: body.error }], isError: true }
    return { content: [{ type: 'text', text: JSON.stringify(body.result, null, 2) }] }
  } catch {
    return { content: [{ type: 'text', text: `Journeys didn't answer. ${NOT_SHARING}` }], isError: true }
  }
})

await server.connect(new StdioServerTransport())
