// UV islands of the Blender garments (public/models/<kind>_uv_layout.json, Blender UVs with the
// origin bottom-left). Prints and construction details are placed into the islands at
// physical scale.
import type { Kind } from '../data/products'

type Rect = { u0: number; v0: number; u1: number; v1: number }
interface LayoutFile {
  dimensions: Record<string, unknown>
  islands: Array<{ name: string; rect: number[]; physical_size_m: number[] }>
}

const files = import.meta.glob<LayoutFile>('../../public/models/*_uv_layout.json', { eager: true, import: 'default' })

export interface Island extends Rect {
  /** Physical width and height (m) the rect covers: across the panel, and down from its top. */
  width: number
  height: number
}

export interface UvLayout {
  islands: Record<string, Island>
}

function load(kind: Kind): UvLayout {
  const file = files[`../../public/models/${kind}_uv_layout.json`]
  if (!file) throw new Error(`UV layout for ${kind} missing`)
  const islands: Record<string, Island> = {}
  for (const i of file.islands) {
    const [u0, v0, u1, v1] = i.rect
    islands[i.name] = { u0, v0, u1, v1, width: i.physical_size_m[0], height: i.physical_size_m[1] }
  }
  return { islands }
}

const cache = new Map<Kind, UvLayout>()
export function layoutFor(kind: Kind) {
  if (!cache.has(kind)) cache.set(kind, load(kind))
  return cache.get(kind)!
}

const tee = layoutFor('tee')
/** The tee's body panels, where the photo-cropped prints go. */
export const UV_LAYOUT = {
  front: tee.islands.front,
  back: tee.islands.back,
  bodyWidth: tee.islands.front.width,
  bodyLength: tee.islands.front.height,
}
