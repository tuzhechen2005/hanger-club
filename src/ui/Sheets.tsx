import { useEffect, useRef, type ReactNode } from 'react'
import { productById, products } from '../data/products'
import { useUI, type Sheet as SheetName } from '../state/store'

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
        <button className="sheet-close" onClick={() => openSheet(null)} aria-label="Close">
          ×
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
  const pieces = lines.reduce((sum, { line }) => sum + line.qty, 0)

  return (
    <Sheet name="bag" label="Your claim">
      <div className="receipt">
        <header>
          <span className="eyebrow">Hanger Club · Cloakroom Nº 1</span>
          <h2>Your claim</h2>
          <p className="receipt-meta">
            {pieces} {pieces === 1 ? 'piece' : 'pieces'} · held at the desk
          </p>
        </header>
        {lines.length === 0 ? (
          <p className="empty">Nothing claimed yet. Take a piece down from the rail.</p>
        ) : (
          <ul className="bag-lines">
            {lines.map(({ line, product }) => (
              <li key={`${line.productId}-${line.size}`}>
                <img className="bag-thumb" src={product.photos[0].url} alt="" />
                <div className="bag-text">
                  <strong>{product.name}</strong>
                  <small>
                    {product.category} · {line.size}
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
                <span className="line-total">${line.qty * product.price}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="subtotal">
          <span>Total</span>
          <span>${subtotal}</span>
        </div>
        <div className="barcode" aria-hidden="true" />
        <p className="note">Demo store. Checkout is not enabled and no payment is collected.</p>
      </div>
      <button className="primary" onClick={() => openSheet(null)}>
        <span>Back to the rail</span>
        <span>→</span>
      </button>
    </Sheet>
  )
}

export function IndexSheet({ onPick }: { onPick: (index: number) => void }) {
  const openSheet = useUI((s) => s.openSheet)
  return (
    <Sheet name="index" label="The rail">
      <span className="eyebrow">Tonight on the rail</span>
      <h2>
        Six pieces, <i>hung by hand.</i>
      </h2>
      <ol className="index-list">
        {products.map((p, i) => (
          <li key={p.id}>
            <button
              onClick={() => {
                openSheet(null)
                onPick(i)
              }}
            >
              <span className="index-photo">
                <img src={p.photos[0].url} alt="" loading="lazy" />
              </span>
              <span className="index-tear" aria-hidden="true" />
              <span className="index-meta">
                <span>Nº {String(i + 1).padStart(2, '0')}</span>
                <em>${p.price}</em>
              </span>
              <strong>{p.name}</strong>
              <small>{p.category}</small>
            </button>
          </li>
        ))}
      </ol>
      <div className="philosophy">
        <span className="eyebrow">House rule</span>
        <p className="manifesto">
          Hang fewer things. <i>Wear them more.</i>
        </p>
        <p>
          Every piece here is cut loose through the body and dropped at the shoulder — easy to throw on, hard to take off. Lift
          one off the rail, turn it in the light, and keep only what you would reach for first.
        </p>
      </div>
      <p className="note">
        Interaction demo. One shared 3D tee drapes every piece; only the Wood Label Tee has a finished texture, the others use rough
        print crops. Product photos belong to their respective brands and are used for a private prototype only.
      </p>
    </Sheet>
  )
}

