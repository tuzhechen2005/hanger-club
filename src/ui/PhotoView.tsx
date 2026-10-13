import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { products } from '../data/products'
import { useUI } from '../state/store'

// The original studio photo. It grows out of where it was asked for: from the lifted garment
// itself (the 3D tee "develops" into the photo as it turns back to face front) or from the
// proof print clipped behind the spec ticket. Closing plays the same move backwards.

type Phase = 'closed' | 'develop' | 'open' | 'closing'

interface Rect {
  x: number
  y: number
  s: number
}

/** Develop time (ms): photo fading in over the garment before the polaroid frame grows. */
const DEVELOP = 750
const MOVE = 650

/** Where the garment sits on screen in the close-up (set by the scene, see RackScene Driver). */
function garmentRect(): Rect {
  const style = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: number) => parseFloat(style.getPropertyValue(name)) || fallback
  return { x: read('--g-x', innerWidth / 2), y: read('--g-y', innerHeight * 0.3), s: read('--g-s', Math.min(innerWidth, innerHeight) * 0.5) }
}

function clipRect(): Rect {
  const proof = document.querySelector('.proof img')?.getBoundingClientRect()
  if (!proof) return garmentRect()
  return { x: proof.left + proof.width / 2, y: proof.top + proof.height / 2, s: proof.width }
}

function openRect(): Rect {
  const s = Math.min(420, innerWidth * 0.84, innerHeight * 0.58)
  return { x: innerWidth / 2, y: innerHeight * 0.44, s }
}

export function PhotoView() {
  const origin = useUI((s) => s.photo)
  const index = useUI((s) => s.index)
  const closePhoto = useUI((s) => s.closePhoto)
  const product = products[index]
  const dialog = useRef<HTMLDialogElement>(null)
  const [phase, setPhase] = useState<Phase>('closed')
  const [side, setSide] = useState(0)
  const [from, setFrom] = useState<Rect>({ x: 0, y: 0, s: 0 })
  const [to, setTo] = useState<Rect>({ x: 0, y: 0, s: 0 })
  const timers = useRef<number[]>([])

  const later = (ms: number, run: () => void) => timers.current.push(window.setTimeout(run, ms))
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  useEffect(() => {
    if (!origin || phase !== 'closed') return
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    setSide(0)
    setFrom(origin === 'garment' ? garmentRect() : clipRect())
    setTo(openRect())
    dialog.current?.showModal()
    if (origin === 'garment' && !reduced) {
      setPhase('develop')
      later(DEVELOP, () => setPhase('open'))
    } else {
      // From the clip the print simply lifts out: start at the clip, then move.
      setPhase('develop')
      requestAnimationFrame(() => requestAnimationFrame(() => setPhase('open')))
    }
  }, [origin, phase])

  const close = () => {
    if (phase === 'closing' || phase === 'closed') return
    // Back to where it came from; the garment may have moved on (switching), so re-measure.
    setFrom(origin === 'clip' ? clipRect() : garmentRect())
    setPhase('closing')
    later(MOVE + 150, () => {
      dialog.current?.close()
      setPhase('closed')
      closePhoto()
    })
  }

  const photo = product.photos[Math.min(side, product.photos.length - 1)]
  const vars = {
    '--from-x': `${from.x}px`,
    '--from-y': `${from.y}px`,
    '--from-s': `${from.s}px`,
    '--to-x': `${to.x}px`,
    '--to-y': `${to.y}px`,
    '--to-s': `${to.s}px`,
  } as CSSProperties

  return (
    <dialog
      ref={dialog}
      className="photo-view"
      data-phase={phase}
      data-origin={origin ?? undefined}
      style={vars}
      aria-label={`${product.name}, original photo`}
      onCancel={(e) => {
        e.preventDefault()
        close()
      }}
    >
      <div className="photo-shade" onClick={close} />
      <figure className="polaroid">
        <img src={photo.url} alt={`${product.name}, studio photo, ${photo.side}`} />
        <figcaption>
          <span>
            Nº {String(index + 1).padStart(2, '0')} · {product.name}
          </span>
          <span>As photographed · {photo.side}</span>
        </figcaption>
      </figure>
      <div className="photo-controls">
        {product.photos.length > 1 && (
          <div className="photo-sides" role="radiogroup" aria-label="Side">
            {product.photos.map((p, i) => (
              <button key={p.side} role="radio" aria-checked={i === side} className={i === side ? 'selected' : ''} onClick={() => setSide(i)}>
                {p.side}
              </button>
            ))}
          </div>
        )}
        <button className="photo-back" onClick={close} autoFocus>
          Turn it in 3D
        </button>
        <p className="note">
          {product.credit
            ? `Photo: ${product.credit}, via Wikimedia Commons.`
            : 'Brand product photo, used for this private demo only.'}
        </p>
      </div>
    </dialog>
  )
}
