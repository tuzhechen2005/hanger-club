import { SIZES, type Size } from '../data/products'

export interface BagLine {
  productId: string
  size: Size
  qty: number
}

export const BAG_KEY = 'hanger-bag-v2'
const MAX_QTY = 9

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Keep only well-formed lines for known products; merge duplicates. Never throws. */
export function sanitize(raw: unknown, knownIds: Set<string>): BagLine[] {
  const items = (raw as { version?: unknown; items?: unknown } | null)?.items
  if (!Array.isArray(items)) return []
  let lines: BagLine[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const { productId, size, qty } = item as Record<string, unknown>
    if (typeof productId !== 'string' || !knownIds.has(productId)) continue
    if (typeof size !== 'string' || !(SIZES as readonly string[]).includes(size)) continue
    if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1) continue
    lines = addLine(lines, productId, size as Size, qty)
  }
  return lines
}

export function addLine(lines: BagLine[], productId: string, size: Size, qty = 1): BagLine[] {
  const existing = lines.find((l) => l.productId === productId && l.size === size)
  if (existing) {
    return lines.map((l) => (l === existing ? { ...l, qty: Math.min(MAX_QTY, l.qty + qty) } : l))
  }
  return [...lines, { productId, size, qty: Math.min(MAX_QTY, qty) }]
}

export function setQty(lines: BagLine[], productId: string, size: Size, qty: number): BagLine[] {
  if (qty < 1) return lines.filter((l) => !(l.productId === productId && l.size === size))
  return lines.map((l) => (l.productId === productId && l.size === size ? { ...l, qty: Math.min(MAX_QTY, qty) } : l))
}

export function loadBag(storage: StorageLike | undefined, knownIds: Set<string>): BagLine[] {
  try {
    const text = storage?.getItem(BAG_KEY)
    return text ? sanitize(JSON.parse(text), knownIds) : []
  } catch {
    return []
  }
}

/** Returns false when storage is unavailable (private mode, quota); the bag keeps working in memory. */
export function saveBag(storage: StorageLike | undefined, lines: BagLine[]): boolean {
  try {
    storage?.setItem(BAG_KEY, JSON.stringify({ version: 2, items: lines }))
    return !!storage
  } catch {
    return false
  }
}
