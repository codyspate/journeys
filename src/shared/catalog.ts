import type { Category, StateVar } from './types'

export const PHASE = { fuel: 10, controls: 20, power: 30, powered: 40, lights: 50 } as const

const number = (
  id: string,
  label: string,
  simvar: string,
  unit: string,
  category: Category,
  phase: number,
  tolerance: number,
  engine?: number
): StateVar => ({ id, label, simvar, unit, category, phase, restore: { kind: 'set' }, tolerance, engine })

const toggle = (
  id: string,
  label: string,
  simvar: string,
  event: string,
  category: Category,
  phase: number,
  engine?: number,
  eventValue?: number
): StateVar => ({
  id,
  label,
  simvar,
  unit: 'Bool',
  category,
  phase,
  restore: { kind: 'toggle', event, value: eventValue },
  tolerance: 0,
  engine
})

const position = (id: string, label: string, simvar: string, unit: string, tolerance: number, angular = false): StateVar => ({
  id,
  label,
  simvar,
  unit,
  category: 'position',
  phase: 0,
  restore: { kind: 'position' },
  tolerance,
  angular
})

const fuelTank = (id: string, label: string, name: string): StateVar =>
  number(`fuel.${id}`, `${label} tank`, `FUEL TANK ${name} QUANTITY`, 'Gallons', 'fuel', PHASE.fuel, 0.2)

const ENGINES = [1, 2, 3, 4]
const BATTERIES = [1, 2, 3]

export const BASE_CATALOG: StateVar[] = [
  position('position.latitude', 'Latitude', 'PLANE LATITUDE', 'Degrees', 0.0005),
  position('position.longitude', 'Longitude', 'PLANE LONGITUDE', 'Degrees', 0.0005),
  position('position.altitude', 'Altitude', 'PLANE ALTITUDE', 'Feet', 50),
  position('position.heading', 'Heading', 'PLANE HEADING DEGREES TRUE', 'Degrees', 2, true),

  fuelTank('center', 'Center', 'CENTER'),
  fuelTank('center2', 'Center 2', 'CENTER2'),
  fuelTank('center3', 'Center 3', 'CENTER3'),
  fuelTank('leftMain', 'Left main', 'LEFT MAIN'),
  fuelTank('leftAux', 'Left aux', 'LEFT AUX'),
  fuelTank('leftTip', 'Left tip', 'LEFT TIP'),
  fuelTank('rightMain', 'Right main', 'RIGHT MAIN'),
  fuelTank('rightAux', 'Right aux', 'RIGHT AUX'),
  fuelTank('rightTip', 'Right tip', 'RIGHT TIP'),
  fuelTank('external1', 'External 1', 'EXTERNAL1'),
  fuelTank('external2', 'External 2', 'EXTERNAL2'),
  {
    id: 'fuel.selector1',
    label: 'Fuel selector',
    simvar: 'FUEL TANK SELECTOR:1',
    unit: 'Enum',
    category: 'fuel',
    phase: PHASE.fuel,
    restore: { kind: 'value-event', event: 'FUEL_SELECTOR_SET' },
    tolerance: 0
  },

  number('controls.flaps', 'Flaps handle', 'FLAPS HANDLE INDEX', 'Number', 'controls', PHASE.controls, 0),
  number('controls.elevatorTrim', 'Elevator trim', 'ELEVATOR TRIM POSITION', 'Radians', 'controls', PHASE.controls, 0.005),
  number('controls.rudderTrim', 'Rudder trim', 'RUDDER TRIM', 'Radians', 'controls', PHASE.controls, 0.005),
  number('controls.aileronTrim', 'Aileron trim', 'AILERON TRIM', 'Radians', 'controls', PHASE.controls, 0.005),
  toggle('controls.parkingBrake', 'Parking brake', 'BRAKE PARKING POSITION', 'PARKING_BRAKES', 'controls', PHASE.controls),
  ...ENGINES.flatMap((n) => [
    number(`controls.throttle${n}`, `Throttle ${n}`, `GENERAL ENG THROTTLE LEVER POSITION:${n}`, 'Percent', 'controls', PHASE.controls, 2, n),
    number(`controls.mixture${n}`, `Mixture ${n}`, `GENERAL ENG MIXTURE LEVER POSITION:${n}`, 'Percent', 'controls', PHASE.controls, 2, n),
    number(`controls.prop${n}`, `Prop ${n}`, `GENERAL ENG PROPELLER LEVER POSITION:${n}`, 'Percent', 'controls', PHASE.controls, 2, n)
  ]),

  ...BATTERIES.map((n) =>
    toggle(`electrical.battery${n}`, `Battery ${n}`, `ELECTRICAL MASTER BATTERY:${n}`, 'TOGGLE_MASTER_BATTERY', 'electrical', PHASE.power, undefined, n)
  ),
  ...ENGINES.map((n) =>
    toggle(`electrical.alternator${n}`, `Alternator ${n}`, `GENERAL ENG MASTER ALTERNATOR:${n}`, `TOGGLE_ALTERNATOR${n}`, 'electrical', PHASE.power, n)
  ),
  toggle('electrical.avionics', 'Avionics master', 'AVIONICS MASTER SWITCH', 'TOGGLE_AVIONICS_MASTER', 'electrical', PHASE.powered),
  toggle('electrical.pitotHeat', 'Pitot heat', 'PITOT HEAT', 'PITOT_HEAT_TOGGLE', 'electrical', PHASE.powered),
  ...ENGINES.map((n) =>
    toggle(`electrical.fuelPump${n}`, `Fuel pump ${n}`, `GENERAL ENG FUEL PUMP SWITCH:${n}`, `TOGGLE_ELECT_FUEL_PUMP${n}`, 'electrical', PHASE.powered, n)
  ),

  toggle('lights.beacon', 'Beacon', 'LIGHT BEACON', 'TOGGLE_BEACON_LIGHTS', 'lights', PHASE.lights),
  toggle('lights.landing', 'Landing light', 'LIGHT LANDING', 'LANDING_LIGHTS_TOGGLE', 'lights', PHASE.lights),
  toggle('lights.taxi', 'Taxi light', 'LIGHT TAXI', 'TOGGLE_TAXI_LIGHTS', 'lights', PHASE.lights),
  toggle('lights.nav', 'Nav lights', 'LIGHT NAV', 'TOGGLE_NAV_LIGHTS', 'lights', PHASE.lights),
  toggle('lights.strobe', 'Strobes', 'LIGHT STROBE', 'STROBES_TOGGLE', 'lights', PHASE.lights),
  toggle('lights.panel', 'Panel lights', 'LIGHT PANEL', 'PANEL_LIGHTS_TOGGLE', 'lights', PHASE.lights),
  toggle('lights.recognition', 'Recognition', 'LIGHT RECOGNITION', 'TOGGLE_RECOGNITION_LIGHTS', 'lights', PHASE.lights),
  toggle('lights.wing', 'Wing lights', 'LIGHT WING', 'TOGGLE_WING_LIGHTS', 'lights', PHASE.lights),
  toggle('lights.logo', 'Logo lights', 'LIGHT LOGO', 'TOGGLE_LOGO_LIGHTS', 'lights', PHASE.lights),
  toggle('lights.cabin', 'Cabin lights', 'LIGHT CABIN', 'TOGGLE_CABIN_LIGHTS', 'lights', PHASE.lights)
]

export interface AircraftProfile {
  id: string
  name: string
  /** Case-insensitive text found in the aircraft title. Empty matches anything. */
  match: string
  restore: Category[]
  /** Aircraft-specific L:vars, read and restored as the "custom" category. */
  lvars: { name: string; label: string; tolerance?: number }[]
}

export const DEFAULT_PROFILE: AircraftProfile = {
  id: 'default',
  name: 'Standard aircraft',
  match: '',
  restore: ['position', 'fuel', 'controls', 'electrical', 'lights', 'custom'],
  lvars: []
}

/** Confirmed in the sim: standard position, fuel, control, switch and light restores all work. */
const A2A_COMANCHE: AircraftProfile = {
  id: 'a2a-comanche',
  name: 'A2A Comanche 250',
  match: 'comanche',
  restore: [...DEFAULT_PROFILE.restore],
  lvars: []
}

export const PROFILES: AircraftProfile[] = [A2A_COMANCHE, DEFAULT_PROFILE]

export function profileForTitle(title: string): AircraftProfile {
  const lower = title.toLowerCase()
  return PROFILES.find((p) => p.match !== '' && lower.includes(p.match)) ?? DEFAULT_PROFILE
}

export function profileById(id: string): AircraftProfile {
  return PROFILES.find((p) => p.id === id) ?? DEFAULT_PROFILE
}

export function catalogFor(profile: AircraftProfile): StateVar[] {
  const custom = profile.lvars.map(
    (v): StateVar => ({
      id: `custom.${v.name}`,
      label: v.label,
      simvar: `L:${v.name}`,
      unit: 'Number',
      category: 'custom',
      phase: PHASE.powered,
      restore: { kind: 'set' },
      tolerance: v.tolerance ?? 0.01
    })
  )
  return [...BASE_CATALOG, ...custom]
}
