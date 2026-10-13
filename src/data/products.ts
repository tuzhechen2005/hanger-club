// Demo catalogue. Photos are third-party brand product shots used for a private demo only
// (see docs/asset-spec.md §5) — replace before any public launch.

/** Garment kind: which 3D model and fabric profile a product uses (public/models/web/<kind>.glb). */
export type Kind = 'tee' | 'longsleeve' | 'hoodie' | 'shell' | 'skirt' | 'pants'
export const KINDS: Kind[] = ['tee', 'longsleeve', 'hoodie', 'shell', 'skirt', 'pants']

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
  kind: Kind
  fabric: string
  /** Strength of the melange knit grain on the fabric (0 = solid dye). */
  heather: number
  /** Surface: knit jersey, brushed fleece, twill denim or coated nylon (drives grain and sheen). */
  weave: 'knit' | 'fleece' | 'denim' | 'nylon'
  /** Construction details painted onto the base colour (pockets, zip, stitching ...). */
  details?: 'hoodie' | 'shell' | 'longsleeve' | 'jeans' | 'track' | 'denim-skirt'
  /** Finished base color texture from the Blender pipeline (tools/blender/make_product_texture.py). */
  basecolor?: string
  prints: { front?: PrintPlacement & { url: string }; back?: PrintPlacement & { url: string } }
  /** Photo attribution for freely licensed photos (assets-src/photos/credits.json). */
  credit?: string
  /** The original studio photos (tools/web/export_photos.py), shown in the close-up's "proof". */
  photos: { side: 'front' | 'back'; url: string; /** Garment box in the square photo: [l, t, r, b] fractions. */ bbox: number[] }[]
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

type Copy = Pick<Product, 'id' | 'name' | 'category' | 'description' | 'price'> &
  Partial<Pick<Product, 'kind' | 'weave' | 'details' | 'credit'>> & { sides?: Array<'front' | 'back'> }

const photoMeta = import.meta.glob<{ bbox: Record<string, number[]> }>('../../public/products/*/photos.json', {
  eager: true,
  import: 'default',
})

const copy: Copy[] = [
  { id: 'shirt2', name: 'Oat Label Tee', category: 'HEATHER OAT', description: 'Heavyweight heather jersey with a tonal rubber label at the chest.', price: 55 },
  { id: 'hoodie1', kind: 'hoodie', weave: 'fleece', details: 'hoodie', name: 'Sand Fleece Hoodie', category: 'SAND FLEECE', description: 'Brushed-back fleece with a roomy hood and ribbed cuffs.', price: 85, credit: '킥스타일 · CC BY 3.0' },
  { id: 'shirt3', name: 'Wood Label Tee', category: 'WOOD BROWN', description: 'Boxy and dropped at the shoulder, finished with a rubber label.', price: 55, sides: ['front', 'back'] },
  { id: 'shirt4', name: 'Script Tee', category: 'OFF BLACK', description: 'Washed jersey with an oversized script across the chest.', price: 65, sides: ['front', 'back'] },
  { id: 'pants1', kind: 'pants', weave: 'denim', details: 'jeans', name: 'Straight Raw Jean', category: 'RAW INDIGO', description: 'Rigid raw denim, high rise and a long straight leg.', price: 95, credit: 'Eriksson Elisabeth · CC BY-SA 4.0' },
  { id: 'longsleeve1', kind: 'longsleeve', details: 'longsleeve', name: 'Night Long Sleeve', category: 'FOREST BLACK', description: 'Soft knit long sleeve with a small emblem at the chest.', price: 60, credit: 'Dan-yell · public domain' },
  { id: 'shirt5', name: 'Arch Logo Tee', category: 'LIGHT HEATHER', description: 'Flocked arch lettering on soft heather grey.', price: 60 },
  { id: 'skirt1', kind: 'skirt', weave: 'denim', details: 'denim-skirt', name: 'Belted Denim Mini', category: 'MID WASH', description: 'A-line mini in mid-wash denim, worn with its own belt.', price: 70, credit: 'Safedom · CC BY-SA 3.0' },
  { id: 'parka1', kind: 'shell', weave: 'nylon', details: 'shell', name: 'Field Shell', category: 'OLIVE', description: 'A long hooded shell with a drawcord waist, for wet days.', price: 160, credit: 'Dusty Roy · public domain' },
  { id: 'shirt6', name: 'Chicago Tee', category: 'HEATHER GREY', description: 'Two-colour varsity type for game nights.', price: 70 },
  { id: 'shirt7', name: 'LA Tee', category: 'HEATHER GREY', description: 'Royal-blue arch type with the LA monogram.', price: 70 },
  { id: 'pants2', kind: 'pants', weave: 'fleece', details: 'track', name: 'Stripe Track Pant', category: 'CARDINAL', description: 'Soft track pants with a white stripe down each leg.', price: 75, credit: 'Kuha455405 · CC BY-SA 3.0' },
]

const asset = (path: string) => `${import.meta.env.BASE_URL}${path}`

export const products: Product[] = copy.map(({ sides = ['front'], kind = 'tee', weave = 'knit', ...item }) => {
  const meta = placeholders[`../../public/products/${item.id}/placeholder.json`]
  const prints: Product['prints'] = {}
  if (meta?.print_front) prints.front = { ...meta.print_front, url: asset(`products/${item.id}/placeholder-print-front.png`) }
  if (meta?.print_back) prints.back = { ...meta.print_back, url: asset(`products/${item.id}/placeholder-print-back.png`) }
  const finished = pipeline[`../../public/products/${item.id}/product.json`]
  return {
    ...item,
    kind,
    weave,
    fabric: finished?.baseColorHex ?? meta?.fabric ?? '#cfcac0',
    heather: weave === 'denim' ? 0.3 : /HEATHER|WOOD/.test(item.category) ? 0.45 : 0.15,
    basecolor: finished ? asset(`products/${item.id}/${finished.basecolor}`) : undefined,
    prints,
    photos: sides.map((side) => ({
      side,
      url: asset(`products/${item.id}/photo-${side}.webp`),
      bbox: photoMeta[`../../public/products/${item.id}/photos.json`]?.bbox[side] ?? [0.07, 0.07, 0.93, 0.93],
    })),
  }
})

export const productById = new Map(products.map((p) => [p.id, p]))

export const SIZES = ['S', 'M', 'L', 'XL'] as const
export type Size = (typeof SIZES)[number]

/**
 * Flat measurements (cm) shown in the size picker, per kind. M is the 3D pattern itself
 * (tools/blender/build_tee.py DEFAULTS, build_garment.py KINDS); the other sizes are a plain
 * demo grading of each measure by its step.
 */
const SIZE_M: Record<Kind, Array<{ label: string; m: number; step: number }>> = {
  tee: [{ label: 'Chest', m: 60, step: 4 }, { label: 'Length', m: 76, step: 3 }, { label: 'Sleeve', m: 26, step: 1 }],
  longsleeve: [{ label: 'Chest', m: 56, step: 4 }, { label: 'Length', m: 72, step: 3 }, { label: 'Sleeve', m: 62, step: 2 }],
  hoodie: [{ label: 'Chest', m: 60, step: 4 }, { label: 'Length', m: 72, step: 3 }, { label: 'Sleeve', m: 62, step: 2 }],
  shell: [{ label: 'Chest', m: 64, step: 4 }, { label: 'Length', m: 80, step: 3 }, { label: 'Sleeve', m: 66, step: 2 }],
  skirt: [{ label: 'Waist', m: 37, step: 3 }, { label: 'Length', m: 46, step: 1 }, { label: 'Hem', m: 52, step: 3 }],
  pants: [{ label: 'Waist', m: 39, step: 3 }, { label: 'Inseam', m: 73, step: 2 }, { label: 'Leg', m: 20, step: 1 }],
}

export function measurements(kind: Kind, size: Size) {
  const k = SIZES.indexOf(size) - 1
  return SIZE_M[kind].map(({ label, m, step }) => ({ label, value: m + k * step }))
}
