// Construction details painted onto a garment's base colour: pockets, zips, drawcords, rib
// bands, stitching, belt loops, stripes, plus the fabric's weave. Everything is drawn in garment
// terms — metres across from the panel's centre line, and down from its top edge — and mapped
// into the kind's UV islands (uvLayout.ts), so the details land at real size on the 3D model.

import type { Product } from '../data/products'
import { layoutFor, type Island } from './uvLayout'

type Point = [number, number]

/** Maps garment metres (x from centre, d down from the top edge) into canvas pixels. */
function pen(g: CanvasRenderingContext2D, island: Island, size: number) {
  const left = island.u0 * size
  const top = (1 - island.v1) * size
  const scaleX = ((island.u1 - island.u0) * size) / island.width
  const scaleY = ((island.v1 - island.v0) * size) / island.height
  const at = ([x, d]: Point): Point => [left + (x + island.width / 2) * scaleX, top + d * scaleY]
  const m = (metres: number) => Math.max(1, metres * scaleX)
  const path = (points: Point[], close = false) => {
    g.beginPath()
    points.forEach((p, i) => (i ? g.lineTo(...at(p)) : g.moveTo(...at(p))))
    if (close) g.closePath()
  }
  const line = (points: Point[], color: string, width: number, dash?: number[]) => {
    path(points)
    g.setLineDash(dash ? dash.map(m) : [])
    g.strokeStyle = color
    g.lineWidth = m(width)
    g.lineCap = 'round'
    g.lineJoin = 'round'
    g.stroke()
    g.setLineDash([])
  }
  const shape = (points: Point[], fill: string, stroke?: string, width = 0.003) => {
    path(points, true)
    g.fillStyle = fill
    g.fill()
    if (stroke) {
      g.strokeStyle = stroke
      g.lineWidth = m(width)
      g.stroke()
    }
  }
  /** Horizontal band across the whole island, with vertical rib lines. */
  const rib = (from: number, to: number, base: string, groove: string) => {
    const w = island.width / 2
    shape([[-w, from], [w, from], [w, to], [-w, to]], base)
    for (let x = -w; x < w; x += 0.006) line([[x, from], [x, to]], groove, 0.0012)
  }
  const curve = (from: Point, via: Point, to: Point, color: string, width: number, dash?: number[]) => {
    g.beginPath()
    g.moveTo(...at(from))
    g.quadraticCurveTo(...at(via), ...at(to))
    g.setLineDash(dash ? dash.map(m) : [])
    g.strokeStyle = color
    g.lineWidth = m(width)
    g.stroke()
    g.setLineDash([])
  }
  return { at, m, line, shape, rib, curve, width: island.width, height: island.height }
}

function shade(hex: string, amount: number, alpha = 1) {
  const n = parseInt(hex.slice(1), 16)
  const channel = (c: number) => Math.round(amount < 0 ? c * (1 + amount) : c + (255 - c) * amount)
  const [r, gr, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(channel)
  return `rgba(${r},${gr},${b},${alpha})`
}

/** Fine weave over the whole canvas: denim twill, nylon ripstop. */
export function paintWeave(g: CanvasRenderingContext2D, product: Product, size: number) {
  if (product.weave === 'denim') {
    g.save()
    g.lineWidth = 1
    for (let k = -size; k < size * 2; k += 3) {
      g.strokeStyle = k % 6 ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,20,0.08)'
      g.beginPath()
      g.moveTo(k, 0)
      g.lineTo(k + size * 0.5, size)
      g.stroke()
    }
    g.restore()
  } else if (product.weave === 'nylon') {
    g.save()
    g.strokeStyle = 'rgba(0,0,0,0.05)'
    g.lineWidth = 1
    for (let k = 0; k < size; k += 6) {
      g.beginPath()
      g.moveTo(k, 0)
      g.lineTo(k, size)
      g.moveTo(0, k)
      g.lineTo(size, k)
      g.stroke()
    }
    g.restore()
  }
}

export function paintDetails(g: CanvasRenderingContext2D, product: Product, size: number) {
  if (!product.details) return
  const { islands } = layoutFor(product.kind)
  const fabric = product.fabric
  const seam = shade(fabric, -0.35)
  const stitch = shade(fabric, -0.45, 0.8)
  const front = pen(g, islands.front, size)
  const back = pen(g, islands.back, size)
  const sleeves = [islands.sleeve_left, islands.sleeve_right].filter(Boolean).map((i) => pen(g, i, size))
  const ribHems = (depth: number) => {
    for (const p of [front, back]) p.rib(p.height - depth, p.height, shade(fabric, -0.05), shade(fabric, -0.18, 0.6))
    for (const p of sleeves) p.rib(p.height - depth * 0.9, p.height, shade(fabric, -0.05), shade(fabric, -0.18, 0.6))
  }

  switch (product.details) {
    case 'hoodie': {
      // Kangaroo pocket, its slanted openings, drawcords from the hood, ribbed hem and cuffs.
      const pocket: Point[] = [[-0.15, 0.42], [0.15, 0.42], [0.19, 0.54], [0.18, 0.62], [-0.18, 0.62], [-0.19, 0.54]]
      front.shape(pocket, shade(fabric, -0.05), seam, 0.003)
      for (const s of [-1, 1]) {
        front.line([[s * 0.15, 0.42], [s * 0.19, 0.54]], shade(fabric, -0.4), 0.005)
        front.line([[s * 0.135, 0.435], [s * 0.172, 0.545]], stitch, 0.0015, [0.006, 0.004])
      }
      front.line([[-0.17, 0.605], [0.17, 0.605]], stitch, 0.0015, [0.006, 0.004])
      for (const s of [-1, 1]) {
        front.line([[s * 0.03, -0.01], [s * 0.045, 0.22]], shade(fabric, 0.18), 0.009)
        front.line([[s * 0.045, 0.2], [s * 0.046, 0.235]], '#8f8a80', 0.008)
      }
      ribHems(0.065)
      break
    }
    case 'longsleeve':
      ribHems(0.045)
      break
    case 'shell': {
      // Centre-front zip under a storm flap, flapped lower pockets, waist and hem drawcords.
      const dark = shade(fabric, -0.55)
      front.line([[0, 0], [0, front.height]], dark, 0.009)
      for (let d = 0.01; d < front.height; d += 0.006) front.line([[-0.004, d], [0.004, d]], shade(fabric, -0.3), 0.0012)
      front.line([[0.028, 0], [0.028, front.height]], stitch, 0.0015, [0.006, 0.004])
      for (const s of [-1, 1]) {
        const x = s * 0.17
        front.shape([[x - 0.085, 0.47], [x + 0.085, 0.47], [x + 0.085, 0.53], [x - 0.085, 0.53]], shade(fabric, -0.08), seam, 0.003)
        front.line([[x - 0.08, 0.66], [x + 0.08, 0.66]], seam, 0.002)
        front.line([[x - 0.08, 0.66], [x - 0.08, 0.53]], seam, 0.002)
        front.line([[x + 0.08, 0.66], [x + 0.08, 0.53]], seam, 0.002)
        front.shape([[s * 0.04 - 0.008, 0.415], [s * 0.04 + 0.008, 0.415], [s * 0.04 + 0.008, 0.44], [s * 0.04 - 0.008, 0.44]], '#2a2a26')
      }
      for (const p of [front, back]) {
        p.line([[-p.width / 2, 0.4], [p.width / 2, 0.4]], stitch, 0.0015, [0.006, 0.004])
        p.line([[-p.width / 2, 0.43], [p.width / 2, 0.43]], stitch, 0.0015, [0.006, 0.004])
        p.line([[-p.width / 2, p.height - 0.035], [p.width / 2, p.height - 0.035]], stitch, 0.0015, [0.006, 0.004])
      }
      back.line([[-back.width / 2, 0.17], [back.width / 2, 0.17]], seam, 0.002)
      for (const p of sleeves) p.line([[-p.width / 2, p.height - 0.06], [p.width / 2, p.height - 0.06]], stitch, 0.0015, [0.006, 0.004])
      break
    }
    case 'jeans': {
      // Waistband with loops, J-stitched fly, scooped pockets and a coin pocket, back yoke and
      // patch pockets, all in orange topstitch.
      const thread = 'rgba(201,139,58,0.95)'
      const copper = '#b07a3e'
      for (const p of [front, back]) {
        p.line([[-0.2, 0.045], [0.2, 0.045]], seam, 0.002)
        p.line([[-0.2, 0.04], [0.2, 0.04]], thread, 0.0015, [0.005, 0.003])
        for (const x of [-0.15, -0.06, 0.06, 0.15]) p.shape([[x - 0.006, 0], [x + 0.006, 0], [x + 0.006, 0.05], [x - 0.006, 0.05]], shade(fabric, 0.06), thread, 0.0012)
        for (const s of [-1, 1]) p.line([[s * 0.24, p.height - 0.02], [s * 0.05, p.height - 0.02]], thread, 0.0015, [0.005, 0.003])
      }
      g.beginPath()
      front.curve([0.035, 0.05], [0.04, 0.2], [0, 0.215], thread, 0.0015, [0.005, 0.003])
      front.line([[0.035, 0.05], [0.035, 0.18]], thread, 0.0015, [0.005, 0.003])
      for (const s of [-1, 1]) {
        front.curve([s * 0.075, 0.048], [s * 0.1, 0.12], [s * 0.19, 0.12], seam, 0.002)
        front.curve([s * 0.068, 0.052], [s * 0.093, 0.128], [s * 0.19, 0.128], thread, 0.0015, [0.005, 0.003])
        front.shape([[s * 0.075 - 0.004, 0.044], [s * 0.075 + 0.004, 0.044], [s * 0.075 + 0.004, 0.052], [s * 0.075 - 0.004, 0.052]], copper)
      }
      front.shape([[0.11, 0.055], [0.155, 0.055], [0.155, 0.1], [0.11, 0.1]], shade(fabric, 0.03), thread, 0.0015)
      back.line([[-0.2, 0.1], [0, 0.135], [0.2, 0.1]], thread, 0.0015, [0.005, 0.003])
      for (const s of [-1, 1]) {
        const x = s * 0.1
        back.shape([[x - 0.065, 0.15], [x + 0.065, 0.15], [x + 0.06, 0.29], [x, 0.31], [x - 0.06, 0.29]], shade(fabric, 0.03), thread, 0.0015)
      }
      break
    }
    case 'track': {
      // Gathered elastic waistband with a drawcord, one white stripe down each outer leg.
      for (const p of [front, back]) {
        p.rib(0, 0.05, shade(fabric, -0.06), shade(fabric, -0.25, 0.6))
        for (const s of [-1, 1]) {
          const stripe: Point[] = [[s * 0.18, 0.05], [s * 0.238, 0.25], [s * 0.214, 0.6], [s * 0.2, p.height]]
          p.line(stripe, 'rgba(245,242,236,0.95)', 0.012)
        }
      }
      for (const s of [-1, 1]) front.line([[s * 0.01, 0.03], [s * 0.03, 0.15]], '#f2efe8', 0.006)
      break
    }
    case 'denim-skirt': {
      // Wide belt with a square buckle and loops, scooped pockets, topstitched hem.
      const thread = 'rgba(201,139,58,0.9)'
      for (const p of [front, back]) {
        p.shape([[-0.2, 0.004], [0.2, 0.004], [0.2, 0.052], [-0.2, 0.052]], shade(fabric, -0.12), seam, 0.002)
        for (const x of [-0.14, 0.14]) p.shape([[x - 0.007, 0], [x + 0.007, 0], [x + 0.007, 0.058], [x - 0.007, 0.058]], shade(fabric, 0.05))
        p.line([[-0.26, p.height - 0.015], [0.26, p.height - 0.015]], thread, 0.0015, [0.005, 0.003])
      }
      front.shape([[-0.035, -0.002], [0.035, -0.002], [0.035, 0.058], [-0.035, 0.058]], 'rgba(0,0,0,0)', '#c8c6c0', 0.006)
      for (const s of [-1, 1]) front.curve([s * 0.07, 0.06], [s * 0.1, 0.12], [s * 0.2, 0.12], seam, 0.002)
      break
    }
  }
}
