import { Component, lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { MEASUREMENTS, products, SIZES } from './data/products'
import { rig } from './motion/rig'
import { useUI } from './state/store'
import { BagSheet, IndexSheet } from './ui/Sheets'
import { PhotoView } from './ui/PhotoView'
import { TeeThumb } from './ui/TeeThumb'

const RackScene = lazy(() => import('./scene/RackScene'))

function hasWebGL() {
  try {
    const canvas = document.createElement('canvas')
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'))
  } catch {
    return false
  }
}

interface Controls {
  go: (delta: number) => void
  select: (index: number) => void
  lift: () => void
  close: () => void
}

const rigControls: Controls = {
  go: (d) => rig.go(d),
  select: (i) => rig.select(i),
  lift: () => rig.lift(),
  close: () => rig.close(),
}

// Without WebGL the rail becomes a flat, single-piece view driven straight from the store.
const flatControls: Controls = {
  go: (d) => useUI.setState((s) => ({ index: Math.max(0, Math.min(products.length - 1, s.index + d)), size: s.mode === 'inspect' ? 'M' : s.size })),
  select: (i) => useUI.setState({ index: i }),
  lift: () => useUI.setState({ mode: 'inspect', size: 'M' }),
  close: () => useUI.setState({ mode: 'browse' }),
}

/** If the 3D scene throws, fall back to the flat view instead of blanking the page. */
class SceneBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: unknown) {
    console.error('[HangerClub] 3D scene failed, showing flat view', error)
    this.props.onError()
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

function Stage() {
  useEffect(() => {
    const cancel = () => rig.pointerCancel()
    window.addEventListener('blur', cancel)
    return () => window.removeEventListener('blur', cancel)
  }, [])

  return (
    <div
      className="stage"
      onPointerDown={(e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return
        rig.pointerDown(e.pointerId, e.clientX, e.clientY)
      }}
      onPointerMove={(e) => {
        if (rig.pointerMove(e.pointerId, e.clientX, e.clientY, e.timeStamp) && !e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.setPointerCapture(e.pointerId)
        }
      }}
      onPointerUp={(e) => rig.pointerUp(e.pointerId, e.clientX, e.clientY, e.timeStamp)}
      onPointerCancel={() => rig.pointerCancel()}
      onLostPointerCapture={(e) => {
        // Touch pointers start implicitly captured by the canvas; moving capture to the stage
        // makes the canvas fire (and bubble) lostpointercapture. Only the stage losing it counts.
        if (e.target === e.currentTarget) rig.pointerCancel()
      }}
    >
      <Suspense fallback={null}>
        <RackScene />
      </Suspense>
    </div>
  )
}

function FlatStage() {
  const index = useUI((s) => s.index)
  return (
    <div className="stage flat">
      <div className="flat-rail" />
      <TeeThumb product={products[index]} className="flat-tee" />
    </div>
  )
}

export default function App() {
  const [sceneFailed, setSceneFailed] = useState(false)
  const webgl = useMemo(hasWebGL, []) && !sceneFailed
  const controls = webgl ? rigControls : flatControls
  const index = useUI((s) => s.index)
  const mode = useUI((s) => s.mode)
  const size = useUI((s) => s.size)
  const bagCount = useUI((s) => s.bag.reduce((n, l) => n + l.qty, 0))
  const sheet = useUI((s) => s.sheet)
  const toast = useUI((s) => s.toast)
  const { setSize, addToBag, openSheet, showToast, openPhoto } = useUI.getState()
  const photoOpen = useUI((s) => s.photo !== null)
  const product = products[index]
  const seeButton = useRef<HTMLButtonElement>(null)
  const detailTitle = useRef<HTMLHeadingElement>(null)
  const previousMode = useRef(mode)
  const [toastVisible, setToastVisible] = useState(false)

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const apply = () => rig.setReducedMotion(query.matches)
    apply()
    query.addEventListener('change', apply)
    return () => query.removeEventListener('change', apply)
  }, [])

  // Move focus with the garment: into the close-up when it arrives, back to the rail on return.
  useEffect(() => {
    if (mode === 'inspect' && previousMode.current !== 'switching') detailTitle.current?.focus({ preventScroll: true })
    if (mode === 'browse' && previousMode.current !== 'browse') seeButton.current?.focus({ preventScroll: true })
    previousMode.current = mode
  }, [mode])

  // Coming back from the original photo, continue on the spec ticket.
  const wasPhotoOpen = useRef(false)
  useEffect(() => {
    if (wasPhotoOpen.current && !photoOpen && mode === 'inspect') detailTitle.current?.focus({ preventScroll: true })
    wasPhotoOpen.current = photoOpen
  }, [photoOpen, mode])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (sheet || photoOpen) return
      const target = e.target as HTMLElement
      if (target.closest('input, textarea, select')) return
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault()
        controls.go(e.key === 'ArrowRight' ? 1 : -1)
      } else if (e.key === 'Escape' && mode === 'inspect') {
        e.preventDefault()
        controls.close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [controls, mode, sheet, photoOpen])

  useEffect(() => {
    if (!toast) return
    setToastVisible(true)
    const timer = setTimeout(() => setToastVisible(false), 2200)
    return () => clearTimeout(timer)
  }, [toast])

  const browsing = mode === 'browse'
  const inspecting = mode === 'inspect' || mode === 'switching'
  const number = (i: number) => String(i + 1).padStart(2, '0')
  const fit = MEASUREMENTS[size]

  return (
    <div className="app" data-mode={mode} style={{ '--tint': product.fabric } as CSSProperties}>
      <div className="backdrop" aria-hidden="true">
        <div className="spot" />
        <div className="numerals">
          {products.map((p, i) => (
            <span key={p.id} style={{ '--i': i } as CSSProperties}>
              {number(i)}
            </span>
          ))}
        </div>
      </div>

      {webgl ? (
        <SceneBoundary onError={() => setSceneFailed(true)}>
          <Stage />
        </SceneBoundary>
      ) : (
        <FlatStage />
      )}

      <header className="topbar">
        <span className="wordmark">
          Hanger<b>Club</b>
          <small>Cloakroom Nº 1</small>
        </span>
        <div className="top-right">
          <button className="top-left" onClick={() => openSheet('index')} inert={!browsing} aria-hidden={!browsing}>
            The rail
          </button>
          <button className="bag-button" onClick={() => openSheet('bag')} inert={!browsing} aria-hidden={!browsing} aria-label={`Your claim, ${bagCount} pieces`}>
            <span className="claim-chip">Claim</span>
            <span className="claim-count">{bagCount}</span>
          </button>
          <button className="close-button" onClick={() => controls.close()} inert={!inspecting} aria-hidden={!inspecting}>
            Hang it back
          </button>
        </div>
      </header>

      <section className="rack-info" aria-live="polite" inert={!browsing}>
        <h1 className="sr-only">Hanger Club — an interactive clothing rail</h1>
        <article className="ticket" key={index}>
          <div className="ticket-stub">
            <span>Nº</span>
            <strong>{number(index)}</strong>
          </div>
          <div className="ticket-body">
            <p className="rack-colour">{product.category}</p>
            <p className="rack-name">{product.name}</p>
            <p className="rack-price">${product.price}</p>
          </div>
          <button ref={seeButton} className="see" onClick={() => controls.lift()}>
            Take it down
          </button>
        </article>
        <p className="rail-hint">Drag the rail · tap a piece to take it down</p>
      </section>

      <nav className="rail-keys" aria-label="Pieces on the rail" inert={!browsing}>
        <button className="step" aria-label="Previous piece" onClick={() => controls.go(-1)} disabled={index === 0}>
          ←
        </button>
        <ol>
          {products.map((p, i) => (
            <li key={p.id}>
              <button className={i === index ? 'tick current' : 'tick'} aria-label={p.name} aria-current={i === index} onClick={() => controls.select(i)}>
                <span style={{ background: p.fabric }} />
              </button>
            </li>
          ))}
        </ol>
        <button className="step" aria-label="Next piece" onClick={() => controls.go(1)} disabled={index === products.length - 1}>
          →
        </button>
      </nav>

      <section className="detail" inert={!inspecting} aria-label={`${product.name} details`}>
        <button className="arrow prev" aria-label="Previous piece" onClick={() => controls.go(-1)} disabled={index === 0}>
          ←
        </button>
        <button className="arrow next" aria-label="Next piece" onClick={() => controls.go(1)} disabled={index === products.length - 1}>
          →
        </button>
        <div className="detail-card">
          {/* The original studio photo, clipped behind the ticket like a proof print. */}
          <button className="proof" key={`proof-${index}`} onClick={() => openPhoto('clip')} aria-label={`See the original photo of ${product.name}`}>
            <img src={product.photos[0].url} alt="" />
            <span className="clip" aria-hidden="true" />
          </button>
          <div className="detail-text">
          <div className="detail-head">
            <span className="detail-index">
              Nº {number(index)} <i>of</i> {number(products.length - 1)}
            </span>
            <span className="detail-colour">
              <span className="swatch" style={{ background: product.fabric }} />
              {product.category}
            </span>
          </div>
          <h2 ref={detailTitle} tabIndex={-1}>
            {product.name}
          </h2>
          <p className="detail-desc">{product.description}</p>
          <div className="size-row">
            <div className="sizes" role="radiogroup" aria-label="Size">
              {SIZES.map((s) => (
                <button key={s} role="radio" aria-checked={s === size} className={s === size ? 'selected' : ''} onClick={() => setSize(s)}>
                  {s}
                </button>
              ))}
            </div>
            <p className="fit" aria-live="polite">
              <span>
                Chest <b>{fit.chest}</b>
              </span>
              <span>
                Length <b>{fit.length}</b>
              </span>
              <span>
                Sleeve <b>{fit.sleeve}</b>
              </span>
              <small>cm, laid flat</small>
            </p>
          </div>
          <button
            className="primary"
            onClick={() => {
              addToBag(product.id, size)
              showToast(`${product.name} · ${size} added to your claim`)
            }}
          >
            <span>Claim it</span>
            <span>${product.price}</span>
          </button>
          {toast && toastVisible && (
            <span className="stamp" key={toast.id} aria-hidden="true">
              Claimed
            </span>
          )}
          <p className="hint">Drag to turn · pull down to hang it back · demo, no payment taken</p>
          </div>
        </div>
      </section>

      <BagSheet />
      <IndexSheet onPick={(i) => controls.select(i)} />
      <PhotoView />
      <div className={`toast ${toastVisible ? 'show' : ''}`} role="status">
        {toast?.text}
      </div>
    </div>
  )
}
