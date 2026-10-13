import { create } from 'zustand'
import { productById, type Size } from '../data/products'
import { addLine, loadBag, saveBag, setQty, type BagLine } from './bag'

export type Mode = 'browse' | 'lifting' | 'inspect' | 'switching' | 'returning'
export type Sheet = 'bag' | 'index' | null

const storage = (() => {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
})()
const knownIds = new Set(productById.keys())

interface UIState {
  index: number
  mode: Mode
  size: Size
  bag: BagLine[]
  sheet: Sheet
  toast: { id: number; text: string } | null
  setSize: (size: Size) => void
  addToBag: (productId: string, size: Size) => void
  setQty: (productId: string, size: Size, qty: number) => void
  openSheet: (sheet: Sheet) => void
  showToast: (text: string) => void
}

const persist = (bag: BagLine[]) => {
  saveBag(storage, bag)
  return bag
}

export const useUI = create<UIState>((set) => ({
  index: 0,
  mode: 'browse',
  size: 'M',
  bag: loadBag(storage, knownIds),
  sheet: null,
  toast: null,
  setSize: (size) => set({ size }),
  addToBag: (productId, size) => set((s) => ({ bag: persist(addLine(s.bag, productId, size)) })),
  setQty: (productId, size, qty) => set((s) => ({ bag: persist(setQty(s.bag, productId, size, qty)) })),
  openSheet: (sheet) => set({ sheet }),
  showToast: (text) => set({ toast: { id: Date.now(), text } }),
}))
