import { useEffect, useRef, useState, type ReactNode } from 'react'
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
                <TeeThumb product={product} className="bag-thumb" />
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
      <h2>Six pieces, hung by hand.</h2>
      <ol className="index-list">
        {products.map((p, i) => (
          <li key={p.id}>
            <button
              onClick={() => {
                openSheet(null)
                onPick(i)
              }}
            >
              <TeeThumb product={p} className="index-thumb" />
              <span className="index-no">Nº {String(i + 1).padStart(2, '0')}</span>
              <strong>{p.name}</strong>
              <em>${p.price}</em>
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

/** The studio photo clipped behind the spec ticket, opened full size. */
export function PhotoSheet() {
  const index = useUI((s) => s.index)
  const open = useUI((s) => s.sheet === 'photo')
  const product = products[index]
  const [side, setSide] = useState(0)
  useEffect(() => {
    if (open) setSide(0)
  }, [open, index])
  const photo = product.photos[Math.min(side, product.photos.length - 1)]
  return (
    <Sheet name="photo" label={`${product.name}, original photo`}>
      <figure className="polaroid">
        <img src={photo.url} alt={`${product.name}, studio photo, ${photo.side}`} />
        <figcaption>
          <span>
            Nº {String(index + 1).padStart(2, '0')} · {product.name}
          </span>
          <span>As photographed · {photo.side}</span>
        </figcaption>
      </figure>
      {product.photos.length > 1 && (
        <div className="photo-sides" role="radiogroup" aria-label="Side">
          {product.photos.map((p, i) => (
            <button key={p.side} role="radio" aria-checked={i === side} className={i === side ? 'selected' : ''} onClick={() => setSide(i)}>
              {p.side}
            </button>
          ))}
        </div>
      )}
      <p className="note">Brand product photo, used for this private demo only.</p>
    </Sheet>
  )
}
