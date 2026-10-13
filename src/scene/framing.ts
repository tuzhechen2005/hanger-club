// Camera framing for the rail (browse) and close-up (inspect) views, per viewport aspect.
// Everything is in metres; the rail top is at y = 0 and the inspect pose sits at z = 0.6.

export const FOV = 30
const TAN = Math.tan(((FOV / 2) * Math.PI) / 180)

/** Lowest point of a hanging garment below the hook, used to place the DOM info under it. */
export const GARMENT_BOTTOM = -0.82
export const INSPECT_Z = 0.6
const INSPECT_Y = 0.05

export interface View {
  /** Visible height (m) at the plane being framed. */
  height: number
  cameraY: number
  cameraZ: number
}

export interface Framing {
  browse: View
  inspect: View
  /** Fractions of viewport height (from the top) where the info blocks should start. */
  browseInfo: number
  inspectInfo: number
  /** Visible width at z = 0 in browse view. */
  browseWidth: number
}

export function computeFraming(aspect: number): Framing {
  const portrait = aspect < 0.8
  const browseHeight = Math.max(2.35 / aspect, 2.5)
  const railFrac = portrait ? 0.38 : 0.27
  const browseY = (railFrac - 0.5) * browseHeight

  const inspectHeight = Math.max(1.3 / aspect, 1.8)
  const centre = INSPECT_Y + (GARMENT_BOTTOM - 0.08) / 2
  const centreFrac = portrait ? 0.33 : 0.36
  const inspectY = centre + (centreFrac - 0.5) * inspectHeight

  const frac = (y: number, view: View) => 0.5 - (y - view.cameraY) / view.height
  const browse = { height: browseHeight, cameraY: browseY, cameraZ: browseHeight / 2 / TAN }
  const inspect = { height: inspectHeight, cameraY: inspectY, cameraZ: INSPECT_Z + inspectHeight / 2 / TAN }
  return {
    browse,
    inspect,
    browseInfo: frac(GARMENT_BOTTOM - 0.06, browse),
    inspectInfo: frac(INSPECT_Y + GARMENT_BOTTOM - 0.06, inspect),
    browseWidth: browseHeight * aspect,
  }
}
