// Camera framing for the rail (browse) and close-up (inspect) views, per viewport aspect.
// Everything is in metres; the rail top is at y = 0 and the inspect pose sits at z = 0.6.

export const FOV = 30
const TAN = Math.tan(((FOV / 2) * Math.PI) / 180)

/** Lowest point of a hanging garment below the hook, used to place the DOM info under it. */
export const GARMENT_BOTTOM = -0.88
export const INSPECT_Z = 0.6
export const INSPECT_Y = 0.05

export interface View {
  /** Visible height (m) at the plane being framed. */
  height: number
  cameraX: number
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

/**
 * `browseBottom`: the lowest hem on the rail (the longest garment must fit above the ticket).
 * `inspectBottom`: the hem of the piece in the close-up, so trousers and tees both fill it.
 */
export function computeFraming(aspect: number, browseBottom = GARMENT_BOTTOM, inspectBottom = GARMENT_BOTTOM): Framing {
  const portrait = aspect < 0.8
  const railFrac = portrait ? 0.38 : 0.25
  // Landscape frames the rail closer: the garments are the point, not the empty wall. The
  // view still has to hold the longest hem with room for the ticket under it.
  const fitBrowse = (-browseBottom + 0.12) / (portrait ? 0.42 : 0.5)
  const browseHeight = portrait ? Math.max(2.35 / aspect, 2.5, fitBrowse) : Math.max(2.35 / aspect, 2.05, fitBrowse)
  const browseY = (railFrac - 0.5) * browseHeight

  const span = -inspectBottom + 0.1
  const inspectHeight = portrait ? Math.max(1.3 / aspect, 1.8, span / 0.46) : Math.max(1.8, span / 0.72)
  const centre = INSPECT_Y + (inspectBottom - 0.08) / 2
  const centreFrac = portrait ? 0.33 : 0.36
  const inspectY = centre + (centreFrac - 0.5) * inspectHeight

  const frac = (y: number, view: View) => 0.5 - (y - view.cameraY) / view.height
  // On wide screens the close-up sits left of centre, leaving the right for the spec ticket.
  const inspectX = aspect > 1.1 ? 0.17 * inspectHeight * aspect : 0
  const browse = { height: browseHeight, cameraX: 0, cameraY: browseY, cameraZ: browseHeight / 2 / TAN }
  const inspect = { height: inspectHeight, cameraX: inspectX, cameraY: inspectY, cameraZ: INSPECT_Z + inspectHeight / 2 / TAN }
  return {
    browse,
    inspect,
    browseInfo: frac(browseBottom - 0.06, browse),
    inspectInfo: frac(INSPECT_Y + inspectBottom - 0.06, inspect),
    browseWidth: browseHeight * aspect,
  }
}
