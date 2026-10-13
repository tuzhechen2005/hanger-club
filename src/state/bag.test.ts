import { describe, expect, it } from 'vitest'
import { addLine, BAG_KEY, loadBag, sanitize, saveBag, setQty } from './bag'

const known = new Set(['shirt2', 'shirt3'])

describe('bag', () => {
  it('merges the same product and size into one line', () => {
    let lines = addLine([], 'shirt2', 'M')
    lines = addLine(lines, 'shirt2', 'M')
    lines = addLine(lines, 'shirt2', 'L')
    expect(lines).toEqual([
      { productId: 'shirt2', size: 'M', qty: 2 },
      { productId: 'shirt2', size: 'L', qty: 1 },
    ])
  })

  it('removes a line when quantity drops below one', () => {
    const lines = setQty(addLine([], 'shirt3', 'S'), 'shirt3', 'S', 0)
    expect(lines).toEqual([])
  })

  it('drops unknown products, bad sizes and bad quantities', () => {
    const raw = {
      version: 2,
      items: [
        { productId: 'shirt2', size: 'M', qty: 1 },
        { productId: 'gone', size: 'M', qty: 1 },
        { productId: 'shirt3', size: 'XXL', qty: 1 },
        { productId: 'shirt3', size: 'S', qty: -2 },
        { productId: 'shirt3', size: 'S', qty: 1.5 },
        null,
        'junk',
        { productId: 'shirt2', size: 'M', qty: 2 },
      ],
    }
    expect(sanitize(raw, known)).toEqual([{ productId: 'shirt2', size: 'M', qty: 3 }])
  })

  it('survives corrupt or missing storage', () => {
    expect(loadBag({ getItem: () => '{not json', setItem() {} }, known)).toEqual([])
    expect(loadBag({ getItem: () => '[{"index":0,"size":"M"}]', setItem() {} }, known)).toEqual([])
    expect(loadBag(undefined, known)).toEqual([])
    const throwing = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
    expect(loadBag(throwing, known)).toEqual([])
    expect(saveBag(throwing, [])).toBe(false)
  })

  it('round-trips through storage', () => {
    const store = new Map<string, string>()
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    const lines = addLine([], 'shirt3', 'XL', 2)
    expect(saveBag(storage, lines)).toBe(true)
    expect(store.has(BAG_KEY)).toBe(true)
    expect(loadBag(storage, known)).toEqual(lines)
  })
})
