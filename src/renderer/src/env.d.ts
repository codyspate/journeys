/// <reference types="vite/client" />
import type { JourneysApi } from '../../shared/types'

declare global {
  interface Window {
    journeys: JourneysApi
  }
}
