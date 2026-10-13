import { useEffect, useRef, type ReactNode } from 'react'
import { productById, products } from '../data/products'
import { useUI, type Sheet as SheetName } from '../state/store'
import { TeeThumb } from './TeeThumb'

function Sheet({ name, label, children }: { name: Exclude<SheetName, null>; label: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  const open = useUI((s) => s.sheet === name)
  const openSheet = useUI((s) => s.openSheet)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className={`sheet sheet-${name}`}
      aria-label={label}
      onClose={() => openSheet(null)}
      onClick={(e) => {
        if (e.target === e.currentTarget) openSheet(null)
      }}
    >
      <div className="sheet-inner">
        <button className="sheet-close" onClick={() => openSheet(null)}>
          CLOSE
        </button>
        {children}
      </div>
    </dialog>
  )
}

export function BagSheet() {
  const bag = useUI((s) => s.bag)
  const setQty = useUI((s) => s.setQty)
  const openSheet = useUI((s) => s.openSheet)
  const lines = bag.flatMap((line) => {
    const product = productById.get(line.productId)
    return product ? [{ line, product }] : []
  })
  const subtotal = lines.reduce((sum, { line, product }) => sum + line.qty * product.price, 0)

  return (
    <Sheet name="bag" label="Shopping bag">
      <span className="eyebrow">YOUR PICKS</span>
      <h2>Your bag</h2>
      {lines.length === 0 ? (
        <p className="empty">Nothing here yet. Lift something off the rail.</p>
      ) : (
        <ul className="bag-lines">
          {lines.map(({ line, product }) => (
            <li key={`${line.productId}-${line.size}`}>
              <TeeThumb product={product} className="bag-thumb" />
              <div className="bag-text">
                <strong>{product.name}</strong>
                <small>
                  Size {line.size} · ${product.price}
                </small>
              </div>
              <div className="qty" role="group" aria-label={`Quantity of ${product.name}, size ${line.size}`}>
                <button aria-label="Decrease quantity" onClick={() => setQty(line.productId, line.size, line.qty - 1)}>
                  −
                </button>
                <span aria-live="polite">{line.qty}</span>
                <button aria-label="Increase quantity" onClick={() => setQty(line.productId, line.size, line.qty + 1)} disabled={line.qty >= 9}>
                  +
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="subtotal">
        <span>Subtotal</span>
        <span>${subtotal}</span>
      </div>
      <p className="note">Demo store. Checkout is not enabled and no payment is collected.</p>
      <button className="primary" onClick={() => openSheet(null)}>
        Keep browsing
      </button>
    </Sheet>
  )
}

export function IndexSheet({ onPick }: { onPick: (index: number) => void }) {
  const openSheet = useUI((s) => s.openSheet)
  return (
    <Sheet name="index" label="Index">
      <span className="eyebrow">THE RAIL</span>
      <ol className="index-list">
        {products.map((p, i) => (
          <li key={p.id}>
            <button
              onClick={() => {
                openSheet(null)
                onPick(i)
              }}
            >
              <span>{String(i + 1).padStart(2, '0')}</span>
              {p.name}
              <em>${p.price}</em>
            </button>
          </li>
        ))}
      </ol>
      <div className="philosophy">
        <span className="eyebrow">LESS, BUT LOVELIER</span>
        <h2>
          Make room for <i>your favourites.</i>
        </h2>
        <p>A good wardrobe starts with a few pieces you love wearing. Easy shapes, considered details, a little personality.</p>
      </div>
      <p className="note">
        Interaction demo. One shared 3D tee drapes every piece; only the Wood Label Tee has a finished texture, the others use rough
        print crops. Product photos belong to their respective brands and are used for a private prototype only.
      </p>
    </Sheet>
  )
}
