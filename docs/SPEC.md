# Journeys: Product Spec

A free-form companion app for Microsoft Flight Simulator 2024. It remembers your world between sessions, plans and adapts multi-leg trips, logs everything you fly, and gives you a reason to come back.

Platform: Windows PC. Storage: local to each install. No account, no server.

## 1. First principle: no barriers, only reasons

Journeys never imposes a "no" on the player. You don't have to fly there, you don't need money for fuel, and you can switch planes whenever you like. The app's job is to make continuing the most attractive and easiest thing to do.

Feature test: **does the app impose a "no" the player did not choose?** If yes, the feature is out or becomes informational.

Rules that follow from this:

- Restrictions exist only as settings a player turns on.
- Anything outside the plan is recorded, never punished.
- Copy is neutral. Nothing reads as a penalty, a failure or a guilt trip.
- Continuing is always one click away. Going somewhere else stays available but isn't promoted.
- No economy, XP, ranks, licenses, streaks or daily quests.

## 2. Concepts

| Concept | Meaning |
|---|---|
| **Pilot** | You. Has a current location and a logbook. The data model allows several pilots; v1 shows one. |
| **Airframe** | One persistent aircraft instance: location, fuel, switch state, hours, history. Stays where you leave it. |
| **Journey** | A trip with a goal: an ordered chain of legs, belonging to the pilot. Each leg records its aircraft. |
| **Leg** | One stage of a Journey. Flown legs are permanent history. Planned legs are editable. |
| **Flight** | One logbook record, whether or not it belongs to a Journey. |
| **Passenger hop** | The in-world name for a teleport. Moves only the pilot. |
| **Goal** | An optional thing to track on a Journey, such as "VOR only" or "stay within 100 NM of the coast". Never enforced. |
| **Where to next?** | Suggestions for what to fly, from pluggable sources. |

A Journey follows the pilot, not one airframe. Several Journeys can be open at once.

## 3. Settings

| Setting | Default | Off | On |
|---|---|---|---|
| **Save aircraft location** | On | Aircraft load wherever you start them. Flights are still logged. | Each airframe resumes where and how you left it. |
| **No teleport** | On | Every flight is logged wherever it starts. | A flight is only logged if the aircraft takes off from where it last landed. |

Details of **No teleport** (as built):

- Nothing is blocked. A flight that starts somewhere else is simply left out of the logbook, its Journey and its aircraft's flight map, and a banner says so and why.
- "Where it last landed" is the newer of the aircraft's parked save and the landing of its last logged flight. Within 3 nm counts as the same place. An aircraft with no history is tracked anywhere.
- While the aircraft is elsewhere, neither the automatic parked save nor Save now can move its recorded location. Restore moves it back, after which flights are logged again.
- Turning the setting off shows a note that an aircraft's flight map may then jump between places instead of being one continuous path.
- Turning it off is always possible and carries no penalty.

With No teleport off, a hop is created either by choosing a destination in the app or by loading in somewhere else. On a surprise load the app asks: "You're in Tokyo now. Continue your Journey from here?"

## 4. Aircraft persistence

Scope: **parked aircraft only**. Mid-air resume is out of scope.

Restore is offered on load and can always be declined. Sequence:

1. Identify the airframe by aircraft model and livery. Ask when two look identical. Tail numbers are not reliable in MSFS 2024.
2. Position the aircraft.
3. Restore state in order: fuel and payload, flight controls, electrical power, then everything that depends on power.
4. Read every value back and show what did and did not restore.

| Tier | Coverage | Approach |
|---|---|---|
| 1 | Position, heading, fuel per tank, trim, flaps | Standard simulation variables, any aircraft |
| 2 | Switches on standard-systems aircraft | Simulation variables and key events |
| 3 | Study-level aircraft (A2A, PMDG, Fenix) | A per-aircraft profile |

**Aircraft profiles** declare what the app restores and what it only reads, so it never fights an aircraft's own persistence. The A2A Comanche restores position, fuel, controls, switches and lights through standard variables. Profiles are plain files that users can share.

Parked state is checkpointed continuously, so a crash cannot lose it.

**Resuming:** the sim clock defaults to the next morning local at your stop.

## 5. Journeys and the planner

A Journey has a goal, a chain of legs, optional Goals and an optional premise. Example: San Diego to Boston in the Comanche, over several days.

**Core rule: flown legs are permanent, and only the future is a plan.**

The planner proposes stops from these inputs:

- Aircraft range with reserve
- Preferred time per session
- Daylight
- Terrain and runway length
- Fuel availability, as a hint only

It plans stops, not routes. Setting up each flight is the pilot's job and part of the fun, using the GPS, SimBrief, Navigraph or whatever they like.

Replanning happens as you go:

- **Stopping early or diverting:** the app detects where you parked, records it, and re-flows the remaining legs.
- **Going further:** in flight, it compares actual fuel and groundspeed to the plan and offers reachable alternatives. Example: "This tailwind puts Amarillo in reach instead of Tucumcari, with an hour's reserve."
- **Confidence fades with distance:** the next leg or two use forecast winds. Later legs are estimates and display as tentative.
- **Session-aware:** "I have 90 minutes tonight" picks a realistic next stop.

The app opens to where you are and your active Journey, with the next leg front and center. Parked airframes appear as places you could go.

## 6. Logbook

Record raw telemetry at about 1 Hz for every flight, and derive stats afterward, so new metrics apply to old flights. Write continuously so a crash can't lose a flight.

- **Times:** block out, takeoff, landing, block in
- **Route:** full track and altitude profile, shown as a map replay
- **Fuel:** burn, per tank
- **Airports:** runway and weather at each end
- **Landing:** touchdown rate, G-force, bounces, crosswind
- **Events:** overspeeds, stalls, flap and gear changes, engine limits
- **Personal:** notes, screenshots, written journal entry
- **Biographies:** rollups by airframe, pilot and Journey

Atlas: a map of airports visited, routes flown and regions uncovered. Hops draw as dashed lines and don't count toward flight hours or the atlas.

## 7. Where to next?

Each source is a separate plug-in. Priority order:

1. **Your places:** pin hometowns, past trips and bucket-list spots.
2. **Shaped journeys:** rivers, coastlines, historic routes, real timetables, shared as files.
3. **Challenges and constraints:** applied to any Journey.
4. **Dispatcher and tour guide:** a brief before each leg and local history at each stop. AI-written with the user's own API key, with templates as the fallback.
5. **Today's weather:** interesting real conditions near you.

## 8. Technical approach

- Electron, React and TypeScript
- `node-simconnect` for sim access, in the main process
- Pure domain logic with no sim dependency, unit tested against a fake sim
- SQLite for the logbook, starting in M1
- MapLibre for maps, starting in M1
- Journeys, profiles and exports are plain shareable files

## 9. Milestones

| | Goal | Done when |
|---|---|---|
| **M0** | Restore lab | Capture and restore verified in the sim on a default aircraft, the Comanche and one airliner. Repositioning method chosen. |
| **M1** | Persistence and logbook | Airframes and pilot location persist automatically. Every flight is logged. Map and replay work. |
| **M2** | Journeys | Plan, fly, and automatically re-flow multi-leg trips. In-flight reach suggestions. |
| **M3** | Reasons to return | Where to next?, atlas, journal entries, Goals. |
| **M4** | Community | Shareable journey and profile packs. Public release. |
| **Later** | Infrastructure | Suggestions from real-world events, and other server-backed features. |

## 10. Open questions and risks

| Item | Status |
|---|---|
| Repositioning reported to freeze MSFS 2024 | No freeze on the C172 with Initial Position, now the default method. Seeing settings change one at a time during a restore is accepted. Confirmed on the Comanche too, where moving left its switches as set. Still to confirm on an airliner. |
| Scoped L:vars reported failing over SimConnect | Test in M0 |
| A2A Comanche restore | Full standard restore works: 41 of 41 values, in one test. Still to check whether it interacts with A2A's own wear and engine state over time. |
| Source for airport fuel availability | Open, hint only, not a blocker |
| Winds source | Open-Meteo's free tier is non-commercial. A paid release needs a license. |
| Fighter profiles | Vary by developer. Address after M0. |

## 11. Out of scope

Economy of any kind, career progression, mid-air resume, Xbox and PlayStation, servers and accounts. Single-flight tooling that Navigraph and SimBrief already cover: routing, charts, and sending legs to the sim.
