import type { Product } from '../data/products'

// Flat tee silhouette from the original SVG prototype, used for bag thumbnails and as
// the no-WebGL fallback.
const SHAPE =
  'M109 69 Q96 74 84 81 L50 103 L28 161 L68 178 L90 145 L91 307 Q150 319 210 307 L213 145 L234 178 L274 159 L249 103 L215 82 Q202 75 190 69 Q173 91 150 92 Q127 90 109 69Z'
const BODY = { x: 90, y: 69, width: 120, length: 238 }

export function TeeThumb({ product, className }: { product: Product; className?: string }) {
  const print = product.prints.front
  let image = null
  if (print) {
    const w = print.width * BODY.width
    const h = (w * print.aspect * 0.61 * BODY.length) / (0.7 * BODY.width)
    const x = BODY.x + BODY.width / 2 + print.centerX * BODY.width - w / 2
    const y = BODY.y + print.top * BODY.length
    image = <image href={print.url} x={x} y={y} width={w} height={h} preserveAspectRatio="none" />
  }
  return (
    <svg className={className} viewBox="20 40 262 290" aria-hidden="true">
      <path d={SHAPE} fill={product.fabric} stroke="#00000018" />
      <path d="M109 69 Q124 107 150 106 Q178 105 190 69 L181 75 Q172 92 150 92 Q128 92 118 75Z" fill="#00000022" />
      {image}
    </svg>
  )
}
