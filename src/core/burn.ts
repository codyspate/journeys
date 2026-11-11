import { simSecondsBetween, type TelemetrySample } from '../shared/logbook'

/** How far back the live burn rate looks, in sim time. */
const WINDOW_SIM_S = 120
/** Less sim time than this is too little to trust. */
const MIN_SPAN_SIM_S = 60

/**
 * The aircraft's real fuel burn, in gallons per sim hour, measured over the last couple of sim minutes.
 * Measured against sim time, so changing the sim rate, even part-way through, doesn't distort it.
 */
export class BurnMeter {
  private history: { simAt: number; fuelGal: number }[] = []
  private last: TelemetrySample | null = null
  private simClock = 0

  add(sample: TelemetrySample): void {
    if (this.last) this.simClock += simSecondsBetween(this.last, sample)
    this.last = sample
    const previous = this.history.at(-1)
    // Refuelling or a reload breaks the measurement; start again from here.
    if (previous && sample.fuelGal > previous.fuelGal + 0.05) this.history = []
    if (!previous || this.simClock > previous.simAt || sample.fuelGal !== previous.fuelGal) {
      this.history.push({ simAt: this.simClock, fuelGal: sample.fuelGal })
    }
    while (this.history.length > 1 && this.history[0].simAt < this.simClock - WINDOW_SIM_S) this.history.shift()
  }

  /** Gallons per sim hour, or null until there's enough to go on. */
  gallonsPerHour(): number | null {
    const oldest = this.history[0]
    const newest = this.history.at(-1)
    if (!oldest || !newest) return null
    const span = newest.simAt - oldest.simAt
    const used = oldest.fuelGal - newest.fuelGal
    if (span < MIN_SPAN_SIM_S || used <= 0) return null
    return used / (span / 3600)
  }

  reset(): void {
    this.history = []
    this.last = null
    this.simClock = 0
  }
}
