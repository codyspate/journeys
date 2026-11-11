// Bundles the MCP server and its SDK into one file, so the installed app can run it without node_modules.
// Output: out/mcp/journeys-mcp.mjs and out/mcp/tools.json, shipped beside the app as resources/mcp.
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'

const root = join(import.meta.dirname, '..')
const outDir = join(root, 'out', 'mcp')
mkdirSync(outDir, { recursive: true })

await build({
  entryPoints: [join(root, 'mcp', 'journeys-mcp.mjs')],
  outfile: join(outDir, 'journeys-mcp.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Some of the SDK's dependencies are CommonJS and call require(); give the ES module one.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'warning'
})
copyFileSync(join(root, 'mcp', 'tools.json'), join(outDir, 'tools.json'))
console.log('MCP server bundled to out/mcp')
