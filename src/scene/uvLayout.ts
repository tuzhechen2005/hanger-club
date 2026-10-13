// UV islands of the Blender garment (public/models/tee_uv_layout.json, Blender UVs with the
// origin bottom-left). Prints are placed into the front/back rects at physical scale.
import layout from '../../public/models/tee_uv_layout.json'

type Rect = { u0: number; v0: number; u1: number; v1: number }
const island = (name: string): Rect => {
  const found = layout.islands.find((i) => i.name === name)
  if (!found) throw new Error(`UV island ${name} missing`)
  const [u0, v0, u1, v1] = found.rect
  return { u0, v0, u1, v1 }
}

export const UV_LAYOUT = {
  front: island('front'),
  back: island('back'),
  /** Physical size covered by the front/back rects (chest width, length from HPS). */
  bodyWidth: layout.dimensions.chest_flat_m,
  bodyLength: layout.dimensions.length_m,
}
