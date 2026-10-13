// Demo catalogue. Photos are third-party brand product shots used for a private demo only
// (see docs/asset-spec.md §5) — replace before any public launch.

export type Silhouette = 'tee'

export interface PrintPlacement {
  /** Offset of the print centre from the body centre, in body widths. */
  centerX: number
  /** Distance from the collar top to the print top, in garment lengths. */
  top: number
  /** Print width, in body widths. */
  width: number
  /** Height / width. */
  aspect: number
}

export interface Product {
  id: string
  name: string
  category: string
  description: string
  price: number
  silhouette: Silhouette
  fabric: string
  /** Strength of the melange knit grain on the fabric (0 = solid dye). */
  heather: number
  /** Finished base color texture from the Blender pipeline (tools/blender/make_product_texture.py). */
  basecolor?: string
  prints: { front?: PrintPlacement & { url: string }; back?: PrintPlacement & { url: string } }
  /** The original studio photos (tools/web/export_photos.py), shown in the close-up's "proof". */
  photos: { side: 'front' | 'back'; url: string }[]
}

interface PlaceholderMeta {
  slug: string
  fabric: string
  print_front?: PrintPlacement
  print_back?: PrintPlacement
}

const placeholders = import.meta.glob<PlaceholderMeta>('../../public/products/*/placeholder.json', {
  eager: true,
  import: 'default',
})

// Products the Blender pipeline has processed carry a product.json next to basecolor.png.
const pipeline = import.meta.glob<{ basecolor: string; baseColorHex: string }>('../../public/products/*/product.json', {
  eager: true,
  import: 'default',
})

type Copy = Pick<Product, 'id' | 'name' | 'category' | 'description' | 'price'> & { sides?: Array<'front' | 'back'> }

const copy: Copy[] = [
  { id: 'shirt2', name: 'Oat Label Tee', category: 'HEATHER OAT', description: 'Heavyweight heather jersey with a tonal rubber label at the chest.', price: 55 },
  { id: 'shirt3', name: 'Wood Label Tee', category: 'WOOD BROWN', description: 'Boxy and dropped at the shoulder, finished with a rubber label.', price: 55, sides: ['front', 'back'] },
  { id: 'shirt4', name: 'Script Tee', category: 'OFF BLACK', description: 'Washed jersey with an oversized script across the chest.', price: 65, sides: ['front', 'back'] },
  { id: 'shirt5', name: 'Arch Logo Tee', category: 'LIGHT HEATHER', description: 'Flocked arch lettering on soft heather grey.', price: 60 },
  { id: 'shirt6', name: 'Chicago Tee', category: 'HEATHER GREY', description: 'Two-colour varsity type for game nights.', price: 70 },
  { id: 'shirt7', name: 'LA Tee', category: 'HEATHER GREY', description: 'Royal-blue arch type with the LA monogram.', price: 70 },
]

const asset = (path: string) => `${import.meta.env.BASE_URL}${path}`

export const products: Product[] = copy.map(({ sides = ['front'], ...item }) => {
  const meta = placeholders[`../../public/products/${item.id}/placeholder.json`]
  const prints: Product['prints'] = {}
  if (meta?.print_front) prints.front = { ...meta.print_front, url: asset(`products/${item.id}/placeholder-print-front.png`) }
  if (meta?.print_back) prints.back = { ...meta.print_back, url: asset(`products/${item.id}/placeholder-print-back.png`) }
  const finished = pipeline[`../../public/products/${item.id}/product.json`]
  return {
    ...item,
    silhouette: 'tee',
    fabric: finished?.baseColorHex ?? meta?.fabric ?? '#cfcac0',
    heather: /HEATHER|WOOD/.test(item.category) ? 0.45 : 0.15,
    basecolor: finished ? asset(`products/${item.id}/${finished.basecolor}`) : undefined,
    prints,
    photos: sides.map((side) => ({ side, url: asset(`products/${item.id}/photo-${side}.webp`) })),
  }
})

export const productById = new Map(products.map((p) => [p.id, p]))

export const SIZES = ['S', 'M', 'L', 'XL'] as const
export type Size = (typeof SIZES)[number]

/**
 * Flat measurements (cm) shown in the size picker. M is the 3D pattern itself
 * (tools/blender/build_tee.py DEFAULTS); the other sizes are a plain demo grading.
 */
export const MEASUREMENTS: Record<Size, { chest: number; length: number; sleeve: number }> = {
  S: { chest: 56, length: 73, sleeve: 25 },
  M: { chest: 60, length: 76, sleeve: 26 },
  L: { chest: 64, length: 79, sleeve: 27 },
  XL: { chest: 68, length: 82, sleeve: 28 },
}
