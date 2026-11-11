import type { Leg, RouteLimits } from '../../shared/journey'

/** Water crossings shorter than this aren't worth mentioning on a leg. */
export const MENTION_WATER_NM = 5
export const feet = (value: number) => `${Math.round(value).toLocaleString()} ft`

/** Plain notes about anything on a planned leg that goes past the player's settings. Informational only. */
export function legNotes(leg: Leg, limits: RouteLimits): string[] {
  const notes: string[] = []
  if (leg.beyondRange) notes.push('Longer than this aircraft’s range with reserve.')
  else if (leg.beyondSession) notes.push('Longer than your preferred leg.')
  if (leg.belowMinimum) notes.push('Shorter than your shortest leg.')
  if (leg.aboveCeiling && leg.highestTerrainFt != null && limits.maxAltitudeFt !== null) {
    notes.push(
      `Ground reaches ${feet(leg.highestTerrainFt)}, closer than ${feet(limits.terrainClearanceFt)} to the ${feet(limits.maxAltitudeFt)} you'll fly.`
    )
  }
  if (leg.overWater && leg.longestWaterNm != null && limits.maxWaterNm !== null) {
    notes.push(`Crosses ${Math.round(leg.longestWaterNm)} nm of water, more than your ${limits.maxWaterNm} nm.`)
  }
  return notes
}
