# Journeys

A free-form companion app for Microsoft Flight Simulator 2024 on Windows. Journeys gives you a reason to keep flying,
without putting barriers in your way: no economy, no career ladder, nothing you have to do.

- **Pick up where you left off.** Each aircraft's parked position, fuel and switches are saved, and restored when you load
  it again.
- **Journeys.** Plan a multi-leg trip, like San Diego to Boston in a Comanche over several evenings. The plan adapts as you
  fly: stop early, go further, change your mind. Terrain, water crossings and runway limits are optional.
- **A detailed logbook.** Every flight is recorded with its full path, landings and events, and drawn on a map coloured by
  altitude, height above ground or speed. Add notes and screenshots.
- **An atlas** of everywhere you've flown, and a live map of the flight you're on.
- **Your places.** Pin your home field and the places you want to go.
- **Ask an AI about your flight.** An optional, read-only MCP server lets AI apps such as Claude Desktop see where you're
  flying ("what am I flying over?").

Everything stays on your computer. Backups are one click away.

## Install

Download the latest `Journeys-Setup-x.y.z.exe` from [Releases](https://github.com/codyspate/journeys/releases) and run
it. Journeys installs for your user only, and updates itself when new versions are released. Your data lives in
`%APPDATA%\journeys` and is never removed by updating or uninstalling.

Journeys connects to the sim automatically through SimConnect while it's running.

## Develop

Requires Node.js 24 and Windows.

```bash
npm install
npm run dev        # run the app with hot reload
npm test           # unit tests
npm run typecheck
npm run dist       # build the installer into release/, without publishing
```

Releases are built by GitHub Actions. Set `version` in `package.json`, commit, then push a matching tag such as `v0.2.0`.

## Data and credits

- Airports: [OurAirports](https://ourairports.com/data/) (public domain). Rebuild with `scripts/build-airports.mjs`.
- Terrain: [GMTED2010](https://www.usgs.gov/coastal-changes-and-impacts/gmted2010) maximum elevation, USGS (public
  domain). Coastlines and lakes: [Natural Earth](https://www.naturalearthdata.com/) (public domain). Rebuild with
  `scripts/build-terrain.py`.
- Maps: [OpenFreeMap](https://openfreemap.org/), with data © [OpenStreetMap](https://www.openstreetmap.org/copyright)
  contributors via [OpenMapTiles](https://openmaptiles.org/).
- Sim connection: [node-simconnect](https://github.com/EvenAR/node-simconnect) (LGPL-3.0), used unmodified as a separate
  library.

Microsoft Flight Simulator is a trademark of Microsoft. Journeys isn't affiliated with or endorsed by Microsoft.

## Code signing policy

Releases are currently unsigned, so Windows SmartScreen may warn when you run the installer. Signing will be added before
the first public release; this section will then name the signing provider and who builds and approves releases.

## License

[MIT](LICENSE)
