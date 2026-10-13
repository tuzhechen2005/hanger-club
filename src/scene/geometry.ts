// Procedural PLACEHOLDER garment and hanger. Same origin, units and UV layout as
// docs/asset-spec.md so the Blender GLB can replace them without touching the rig.
// The garment is a closed "pillow" (front + back layers meeting at the side seams)
// with simple folds — not a cloth simulation.

import * as THREE from 'three'

// Boxy M (spec §3.1).
const LENGTH = 0.7
const BODY_HALF = 0.305
const SHOULDER_HALF = 0.3
const NECK_HALF = 0.1
const NECK_DROP_FRONT = 0.075
const NECK_DROP_BACK = 0.022
const HANGER_TIP = 0.22

/** Top edge of the garment where it rests on the hanger (y at |x|). */
function shoulderY(ax: number) {
  const onHanger = -0.09 - 0.22 * Math.min(ax, HANGER_TIP)
  return ax <= HANGER_TIP ? onHanger : onHanger - (ax - HANGER_TIP) * 1.15
}

const HPS_Y = shoulderY(NECK_HALF)
export const HEM_Y = HPS_Y - LENGTH

function topY(x: number, front: boolean) {
  const ax = Math.abs(x)
  if (ax >= NECK_HALF) return shoulderY(ax)
  const drop = front ? NECK_DROP_FRONT : NECK_DROP_BACK
  return shoulderY(NECK_HALF) - drop * Math.sqrt(1 - (ax / NECK_HALF) ** 2)
}

const hemY = (x: number) => HEM_Y + 0.012 * (x / BODY_HALF) ** 2

function bodyHalf(t: number) {
  return SHOULDER_HALF + (BODY_HALF - SHOULDER_HALF) * Math.min(1, t / 0.25)
}

/** Fold displacement out of the surface (front positive). */
function folds(x: number, t: number, front: boolean) {
  const phase = front ? 0 : 1.7
  return (
    0.011 * t ** 1.3 * Math.sin(x * 21 + 1.1 + phase) +
    0.005 * t * Math.sin(x * 43 + 0.3 + phase) +
    0.004 * Math.exp(-(((x - 0.2) / 0.05) ** 2)) * Math.sin(t * 9)
  )
}

function depth(s: number, t: number, x: number) {
  const across = Math.sin(Math.PI * s) ** 0.5
  const overHanger = Math.abs(x) < HANGER_TIP ? 0.017 : 0.008
  return across * (overHanger + 0.026 * t ** 0.7)
}

class Builder {
  positions: number[] = []
  uvs: number[] = []
  indices: number[] = []

  grid(cols: number, rows: number, at: (s: number, t: number) => [number, number, number], uv: (s: number, t: number) => [number, number], flip: boolean) {
    const base = this.positions.length / 3
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= cols; i++) {
        const s = i / cols
        const t = j / rows
        this.positions.push(...at(s, t))
        this.uvs.push(...uv(s, t))
      }
    }
    const w = cols + 1
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const a = base + j * w + i
        const b = a + 1
        const c = a + w
        const d = c + 1
        if (flip) this.indices.push(a, b, c, b, d, c)
        else this.indices.push(a, c, b, b, c, d)
      }
    }
    return base
  }

  build() {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2))
    g.setIndex(this.indices)
    g.computeVertexNormals()
    return g
  }
}

export function createTeeGeometry() {
  const b = new Builder()
  const COLS = 44
  const ROWS = 54

  const bodyPoint = (front: boolean) => (s: number, t: number): [number, number, number] => {
    const x = (s - 0.5) * 2 * bodyHalf(t)
    const y = topY(x, front) + t * (hemY(x) - topY(x, front))
    const z = depth(s, t, x) + folds(x, t, front)
    return [x, y, front ? z : -z]
  }
  // Front: u 0–0.48, v 1–0.4. Back: u reversed so prints read correctly from behind.
  const front = b.grid(COLS, ROWS, bodyPoint(true), (s, t) => [0.48 * s, 1 - 0.6 * t], false)
  const back = b.grid(COLS, ROWS, bodyPoint(false), (s, t) => [0.52 + 0.48 * (1 - s), 1 - 0.6 * t], true)

  // Close the shoulders between front and back, leaving the neck open.
  for (let i = 0; i < COLS; i++) {
    const x0 = (i / COLS - 0.5) * 2 * bodyHalf(0)
    const x1 = ((i + 1) / COLS - 0.5) * 2 * bodyHalf(0)
    if (Math.abs(x0) < NECK_HALF || Math.abs(x1) < NECK_HALF) continue
    b.indices.push(front + i, front + i + 1, back + i, front + i + 1, back + i + 1, back + i)
  }

  // Sleeves: bilinear pillows hanging out and down from the dropped shoulder.
  for (const side of [1, -1]) {
    const alpha = 40 * (Math.PI / 180)
    const dir: [number, number] = [side * Math.cos(alpha), -Math.sin(alpha)]
    const inward: [number, number] = [-side * Math.sin(alpha), -Math.cos(alpha)]
    const A: [number, number] = [side * (SHOULDER_HALF - 0.005), shoulderY(SHOULDER_HALF) + 0.004]
    const B: [number, number] = [A[0] + dir[0] * 0.25, A[1] + dir[1] * 0.25]
    const C: [number, number] = [B[0] + inward[0] * 0.225, B[1] + inward[1] * 0.225]
    const D: [number, number] = [side * (BODY_HALF + 0.004), A[1] - 0.27]
    const sleeve = (sign: number) => (s: number, t: number): [number, number, number] => {
      const top: [number, number] = [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t]
      const bottom: [number, number] = [D[0] + (C[0] - D[0]) * t, D[1] + (C[1] - D[1]) * t]
      const x = top[0] + (bottom[0] - top[0]) * s
      const y = top[1] + (bottom[1] - top[1]) * s
      const puff = Math.sin(Math.PI * s) ** 0.6 * (0.03 + 0.008 * t) + 0.004 * Math.sin(s * 9 + t * 4)
      return [x, y, sign * puff]
    }
    const u0 = side > 0 ? 0 : 0.5
    // Mirror winding for the left sleeve so normals still face outward.
    const outward = side > 0
    b.grid(12, 10, sleeve(1), (s, t) => [u0 + 0.24 * t, 0.04 + 0.3 * s], outward)
    b.grid(12, 10, sleeve(-1), (s, t) => [u0 + 0.25 + 0.24 * t, 0.04 + 0.3 * s], !outward)
  }

  const g = b.build()
  g.computeBoundingSphere()
  return g
}

export function createHangerGeometry() {
  const woodCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-HANGER_TIP, -0.128, 0),
    new THREE.Vector3(-0.15, -0.105, 0),
    new THREE.Vector3(-0.06, -0.083, 0),
    new THREE.Vector3(0, -0.079, 0),
    new THREE.Vector3(0.06, -0.083, 0),
    new THREE.Vector3(0.15, -0.105, 0),
    new THREE.Vector3(HANGER_TIP, -0.128, 0),
  ])
  const wood = new THREE.TubeGeometry(woodCurve, 64, 0.0072, 12, false)
  wood.scale(1, 1, 1.5)
  const tipL = new THREE.SphereGeometry(0.0072, 12, 8).scale(1, 1, 1.5).translate(-HANGER_TIP, -0.128, 0)
  const tipR = tipL.clone().translate(2 * HANGER_TIP, 0, 0)

  // Hook in the YZ plane: rises from the hanger, steps forward, wraps over the rail.
  // Its inner apex is the origin (spec §1); wire radius 0.002, rail radius 0.011.
  const r = 0.013
  const points = [new THREE.Vector3(0, -0.079, 0), new THREE.Vector3(0, -0.055, 0), new THREE.Vector3(0, -0.036, 0.006)]
  // θ from +Z toward +Y around the rail axis; θ = π/2 is the apex.
  for (let theta = -0.25; theta <= Math.PI + 0.7; theta += Math.PI / 14) {
    points.push(new THREE.Vector3(0, -0.011 + r * Math.sin(theta), r * Math.cos(theta)))
  }
  const hook = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 64, 0.002, 6, false)
  return { wood: mergeGeometries([wood, tipL, tipR]), hook }
}

function mergeGeometries(parts: THREE.BufferGeometry[]) {
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  let offset = 0
  for (const part of parts) {
    const g = part.index ? part : part.toNonIndexed()
    const pos = g.getAttribute('position')
    const nor = g.getAttribute('normal')
    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i))
      normals.push(nor.getX(i), nor.getY(i), nor.getZ(i))
    }
    const index = g.index!
    for (let i = 0; i < index.count; i++) indices.push(index.getX(i) + offset)
    offset += pos.count
  }
  const merged = new THREE.BufferGeometry()
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  merged.setIndex(indices)
  return merged
}

/** Front-body rectangle in texture space and the garment dimensions it maps to. */
export const UV_LAYOUT = {
  front: { u0: 0, u1: 0.48, v0: 0.4, v1: 1 },
  back: { u0: 0.52, u1: 1, v0: 0.4, v1: 1 },
  /** Front neckline drop relative to the collar top, as a fraction of length. */
  neckDrop: NECK_DROP_FRONT / LENGTH,
}
