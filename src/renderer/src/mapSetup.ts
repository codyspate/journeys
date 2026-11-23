import 'maplibre-gl/dist/maplibre-gl.css'
import { setWorkerUrl } from 'maplibre-gl'
import workerSource from 'maplibre-gl/dist/maplibre-gl-worker.mjs?raw'

// The packaged app loads from file://, where a worker can only start from a blob.
setWorkerUrl(URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' })))

export const LABEL_FONT = ['Noto Sans Regular']
export const OUTLINE = '#0e1420'
