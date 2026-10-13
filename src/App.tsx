import { Component, lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { products, SIZES } from './data/products'
import { rig } from './motion/rig'
import { useUI } from './state/store'
import { BagSheet, IndexSheet } from './ui/Sheets'
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
  const { setSize, addToBag, openSheet, showToast } = useUI.getState()
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (sheet) return
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
  }, [controls, mode, sheet])

  useEffect(() => {
    if (!toast) return
    setToastVisible(true)
    const timer = setTimeout(() => setToastVisible(false), 2200)
    return () => clearTimeout(timer)
  }, [toast])

  const browsing = mode === 'browse'
  const inspecting = mode === 'inspect' || mode === 'switching'
  const number = (i: number) => String(i + 1).padStart(2, '0')

  return (
    <div className="app" data-mode={mode}>
      {webgl ? (
        <SceneBoundary onError={() => setSceneFailed(true)}>
          <Stage />
        </SceneBoundary>
      ) : (
        <FlatStage />
      )}

      <header className="topbar">
        <button className="top-left" onClick={() => openSheet('index')} inert={!browsing} aria-hidden={!browsing}>
          INDEX
        </button>
        <span className="wordmark">Hanger Club</span>
        <div className="top-right">
          <button className="bag-button" onClick={() => openSheet('bag')} inert={!browsing} aria-hidden={!browsing}>
            BAG · {bagCount}
          </button>
          <button className="close-button" onClick={() => controls.close()} inert={!inspecting} aria-hidden={!inspecting}>
            CLOSE
          </button>
        </div>
      </header>

      <section className="rack-info" aria-live="polite" inert={!browsing}>
        <h1 className="sr-only">Hanger Club — an interactive clothing rail</h1>
        <p className="rack-name">{product.name}</p>
        <p className="rack-price">${product.price}</p>
        <button ref={seeButton} className="see" onClick={() => controls.lift()}>
          SEE THE PIECE
        </button>
        <div className="rail-keys">
          <button aria-label="Previous piece" onClick={() => controls.go(-1)} disabled={index === 0}>
            ←
          </button>
          <span>
            {number(index)} / {number(products.length - 1)}
          </span>
          <button aria-label="Next piece" onClick={() => controls.go(1)} disabled={index === products.length - 1}>
            →
          </button>
        </div>
      </section>

      <section className="detail" inert={!inspecting} aria-label={`${product.name} details`}>
        <button className="arrow prev" aria-label="Previous piece" onClick={() => controls.go(-1)} disabled={index === 0}>
          ←
        </button>
        <button className="arrow next" aria-label="Next piece" onClick={() => controls.go(1)} disabled={index === products.length - 1}>
          →
        </button>
        <div className="detail-text">
          <span className="detail-index">
            {number(index)} / {number(products.length - 1)}
          </span>
          <h2 ref={detailTitle} tabIndex={-1}>
            {product.name}
          </h2>
          <p className="detail-desc">
            ${product.price} · {product.description}
          </p>
          <div className="sizes" role="radiogroup" aria-label="Size">
            {SIZES.map((s) => (
              <button key={s} role="radio" aria-checked={s === size} className={s === size ? 'selected' : ''} onClick={() => setSize(s)}>
                {s}
              </button>
            ))}
          </div>
          <button
            className="primary"
            onClick={() => {
              addToBag(product.id, size)
              showToast(`${product.name} · ${size} added to your bag`)
            }}
          >
            ADD TO BAG — ${product.price}
          </button>
          <p className="hint">Drag to turn · pull down to put it back</p>
        </div>
      </section>

      <div className="marquee" aria-hidden="true">
        <div className="marquee-track">
          {Array.from({ length: 2 }, (_, k) => (
            <span key={k}>
              SAMPLE COLLECTION · INTERACTION DEMO · NO PAYMENT COLLECTED · DRAG TO BROWSE · TAP TO LIFT · SAMPLE COLLECTION · INTERACTION DEMO ·
              NO PAYMENT COLLECTED · DRAG TO BROWSE · TAP TO LIFT ·&nbsp;
            </span>
          ))}
        </div>
      </div>

      <BagSheet />
      <IndexSheet onPick={(i) => controls.select(i)} />
      <div className={`toast ${toastVisible ? 'show' : ''}`} role="status">
        {toast?.text}
      </div>
    </div>
  )
}
