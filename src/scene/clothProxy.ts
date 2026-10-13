// Real-time secondary cloth motion: each garment is driven by a coarse particle proxy
// (~300–400 particles) simulated with position-based dynamics. The proxy hangs from the
// hanger (cloth resting on it is pinned), keeps the authored drape through soft goal springs
// that weaken toward the free end, keeps itself together with distance and bending
// constraints, and collides with itself and the other garments. The full-resolution mesh
// follows the proxy on the GPU through per-vertex bindings (up to 4 particles each); its
// normals turn with each particle's local deformation gradient.
//
// The authored drape (Blender) is the rest shape; the proxy only adds inertia, sway and
// contact on top of it. It is not a full cloth simulation of the render mesh.
// Method and tuning: docs/cloth-motion.md.

import * as THREE from 'three'

export interface ProxyPart {
  geometry: THREE.BufferGeometry
  /** Mesh-local → hanger (pivot) space; quantised GLB meshes are not in metres. */
  toPivot: THREE.Matrix4
}

/** How one kind of garment moves. Values are per 1/60 s step where noted. */
export interface ClothProfile {
  /** Particle spacing (m). Smaller = finer motion; cost grows with the particle count. */
  cell: number
  /** Cloth this close to the hanger rides on it rigidly (m). */
  pinDistance: number
  /** Pull back to the authored drape just below the hanger and at the free end (0–1). */
  goalTop: number
  goalHem: number
  /**
   * Velocity kept per step, relative to the hanger: lower = the sway dies sooner. Relative,
   * so a garment carried at constant speed moves as one piece and only acceleration and
   * turning make it lag and swing.
   */
  damping: number
  /** Share of the absolute velocity lost per step to air: a hem trailing at speed. */
  airDrag: number
  /**
   * Share of the hanger's motion the cloth feels as inertia (0–1); the rest carries the cloth
   * along rigidly. Lower = the garment reacts less to being dragged, flicked or spun. The scene
   * scales it further per garment for choreographed motion (see ClothSim.step).
   */
  inertia: number
  /** Most inertial motion per frame (m): a frame-time spike must not fling the cloth. */
  maxInertialStep: number
  /** Stiffness of the two-ring bending pairs (0–1): higher keeps panels from creasing. */
  bend: number
  /**
   * Shape keeping per horizontal band (0–1): each band of cloth tries to stay a rotated copy of
   * its drape. Bands can tilt against each other (sway), but a band cannot twist or crumple, so
   * the garment moves like a sewn tube instead of jelly.
   */
  shape: number
  /** Largest offset the render mesh may take from the authored drape (m). */
  maxOffset: number
  /** Particle collision radius (m): about half the cell, more than the fabric thickness. */
  radius: number
}

/** Mid-weight cotton jersey tee on a wooden hanger (the demo's boxy tee). */
export const JERSEY_TEE: ClothProfile = {
  cell: 0.055,
  pinDistance: 0.04,
  goalTop: 0.3,
  goalHem: 0.04,
  damping: 0.95,
  airDrag: 0.004,
  inertia: 1,
  maxInertialStep: 0.04,
  bend: 0.6,
  shape: 0.25,
  maxOffset: 0.08,
  radius: 0.024,
}

export interface ProxyTopology {
  count: number
  /** Rest positions in pivot space (metres), xyz per particle. */
  rest: Float32Array
  /** Particle index pairs. */
  edges: Uint32Array
  restLength: Float32Array
  /** Two-ring pairs that resist folding the proxy sharply. */
  bendEdges: Uint32Array
  bendLength: Float32Array
  /** CSR adjacency (neighbours of particle i: adjacency[adjStart[i]..adjStart[i+1]]). */
  adjStart: Uint32Array
  adjacency: Uint32Array
  /** Goal stiffness per 1/60 s step: 1 = pinned to the hanger. */
  goal: Float32Array
  /** Inverse mass: 0 for pinned particles. */
  invMass: Float32Array
  /**
   * Per particle, the inverse of its neighbourhood's rest covariance (3×3, column-major,
   * regularised): turns neighbour offsets into a least-squares deformation gradient.
   */
  covInverse: Float32Array
  /** Overlapping horizontal bands for shape keeping (CSR: members of band b). */
  bandStart: Uint32Array
  bands: Uint32Array
  textureWidth: number
  profile: ClothProfile
}

/**
 * Cluster the garment's vertices into a voxel grid; one particle per occupied cell, and bind
 * the render mesh to it (attributes `aProxyIdx`, `aProxyW` on every part's geometry, shared
 * by all garments).
 *
 * `parts[0]` is the visible outer surface. Any further part (the inner shell of a closed
 * fabric) copies the binding of the nearest outer vertex, so both shells always move together.
 * `support` is the hanger the garment rests on: cloth near it is pinned.
 */
export function buildProxy(parts: ProxyPart[], support: ProxyPart, profile: ClothProfile = JERSEY_TEE): ProxyTopology {
  const CELL = profile.cell
  const keyOf = (x: number, y: number, z: number) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)},${Math.floor(z / CELL)}`
  const clusterOf = new Map<string, number>()
  const sums: number[] = []
  const counts: number[] = []
  const v = new THREE.Vector3()
  const pivotPositions: Float32Array[] = []
  const vertexCluster: Int32Array[] = []

  for (const part of parts) {
    const pos = part.geometry.getAttribute('position')
    const out = new Float32Array(pos.count * 3)
    const ids = new Int32Array(pos.count)
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(part.toPivot)
      out[i * 3] = v.x
      out[i * 3 + 1] = v.y
      out[i * 3 + 2] = v.z
      const key = keyOf(v.x, v.y, v.z)
      let id = clusterOf.get(key)
      if (id === undefined) {
        id = counts.length
        clusterOf.set(key, id)
        counts.push(0)
        sums.push(0, 0, 0)
      }
      ids[i] = id
      counts[id]++
      sums[id * 3] += v.x
      sums[id * 3 + 1] += v.y
      sums[id * 3 + 2] += v.z
    }
    pivotPositions.push(out)
    vertexCluster.push(ids)
  }

  const count = counts.length
  const rest = new Float32Array(count * 3)
  for (let c = 0; c < count; c++) for (let k = 0; k < 3; k++) rest[c * 3 + k] = sums[c * 3 + k] / counts[c]

  // Edges wherever a mesh triangle spans two clusters.
  const edgeSet = new Set<number>()
  const neighbors: Set<number>[] = Array.from({ length: count }, () => new Set())
  parts.forEach((part, p) => {
    const index = part.geometry.getIndex()
    const ids = vertexCluster[p]
    const tri = (n: number) => (index ? index.getX(n) : n)
    const total = index ? index.count : ids.length
    for (let t = 0; t < total; t += 3) {
      const a = ids[tri(t)]
      const b = ids[tri(t + 1)]
      const c = ids[tri(t + 2)]
      for (const [i, j] of [
        [a, b],
        [b, c],
        [c, a],
      ]) {
        if (i === j) continue
        const lo = Math.min(i, j)
        const hi = Math.max(i, j)
        edgeSet.add(lo * count + hi)
        neighbors[i].add(j)
        neighbors[j].add(i)
      }
    }
  })
  const edges = new Uint32Array(edgeSet.size * 2)
  const restLength = new Float32Array(edgeSet.size)
  let e = 0
  for (const key of edgeSet) {
    const i = Math.floor(key / count)
    const j = key % count
    edges[e * 2] = i
    edges[e * 2 + 1] = j
    restLength[e] = Math.hypot(rest[i * 3] - rest[j * 3], rest[i * 3 + 1] - rest[j * 3 + 1], rest[i * 3 + 2] - rest[j * 3 + 2])
    e++
  }

  // Two-ring "bending" pairs keep panels from creasing between particles.
  const dist = (i: number, j: number) => Math.hypot(rest[i * 3] - rest[j * 3], rest[i * 3 + 1] - rest[j * 3 + 1], rest[i * 3 + 2] - rest[j * 3 + 2])
  const bendSet = new Set<number>()
  for (let i = 0; i < count; i++) {
    for (const j of neighbors[i]) {
      for (const k of neighbors[j]) {
        if (k === i || neighbors[i].has(k)) continue
        bendSet.add(Math.min(i, k) * count + Math.max(i, k))
      }
    }
  }
  const bendEdges = new Uint32Array(bendSet.size * 2)
  const bendLength = new Float32Array(bendSet.size)
  let b = 0
  for (const key of bendSet) {
    const i = Math.floor(key / count)
    const k = key % count
    bendEdges[b * 2] = i
    bendEdges[b * 2 + 1] = k
    bendLength[b] = dist(i, k)
    b++
  }
  const adjStart = new Uint32Array(count + 1)
  for (let i = 0; i < count; i++) adjStart[i + 1] = adjStart[i] + neighbors[i].size
  const adjacency = new Uint32Array(adjStart[count])
  for (let i = 0; i < count; i++) adjacency.set([...neighbors[i]], adjStart[i])

  // Cloth lying on the hanger rides on it; below that the drape loosens toward the free end.
  const supportPoints = pivotPoints(support)
  const near = new Float32Array(count).fill(Infinity)
  let supportBottom = Infinity
  for (let k = 0; k < supportPoints.length; k += 3) supportBottom = Math.min(supportBottom, supportPoints[k + 1])
  for (let c = 0; c < count; c++) {
    for (let k = 0; k < supportPoints.length; k += 3) {
      const d = (rest[c * 3] - supportPoints[k]) ** 2 + (rest[c * 3 + 1] - supportPoints[k + 1]) ** 2 + (rest[c * 3 + 2] - supportPoints[k + 2]) ** 2
      if (d < near[c]) near[c] = d
    }
  }
  let bottom = Infinity
  for (let c = 0; c < count; c++) bottom = Math.min(bottom, rest[c * 3 + 1])
  const hang = Math.max(0.1, supportBottom - bottom)
  const goal = new Float32Array(count)
  const invMass = new Float32Array(count)
  for (let c = 0; c < count; c++) {
    if (Math.sqrt(near[c]) < profile.pinDistance) {
      goal[c] = 1
      invMass[c] = 0
    } else {
      const f = Math.min(1, Math.max(0, (supportBottom - rest[c * 3 + 1]) / hang))
      const s = f * f * (3 - 2 * f)
      goal[c] = profile.goalTop + (profile.goalHem - profile.goalTop) * s
      invMass[c] = 1
    }
  }

  // Bands two cells tall, one cell apart, so every particle sits in two of them.
  const top = Math.max(...Array.from({ length: count }, (_, c) => rest[c * 3 + 1]))
  const bandLists: number[][] = []
  for (let b = 0; top - b * CELL > bottom; b++) {
    const hi = top - b * CELL + 1e-6
    const lo = hi - 2 * CELL
    const members: number[] = []
    for (let c = 0; c < count; c++) if (rest[c * 3 + 1] <= hi && rest[c * 3 + 1] > lo) members.push(c)
    if (members.length >= 4 && members.some((c) => invMass[c] > 0)) bandLists.push(members)
  }
  const bandStart = new Uint32Array(bandLists.length + 1)
  bandLists.forEach((m, b) => (bandStart[b + 1] = bandStart[b] + m.length))
  const bands = Uint32Array.from(bandLists.flat())

  // Cloth is a surface, so the neighbourhood is flat; the regulariser keeps the normal
  // direction well-posed (gradient ≈ 0 along it).
  const covInverse = new Float32Array(count * 9)
  const cov = new THREE.Matrix3()
  const reg = (0.3 * CELL) ** 2
  for (let i = 0; i < count; i++) {
    const m = [reg, 0, 0, 0, reg, 0, 0, 0, reg]
    for (let q = adjStart[i]; q < adjStart[i + 1]; q++) {
      const j = adjacency[q]
      const d = [rest[j * 3] - rest[i * 3], rest[j * 3 + 1] - rest[i * 3 + 1], rest[j * 3 + 2] - rest[i * 3 + 2]]
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m[c * 3 + r] += d[r] * d[c]
    }
    cov.fromArray(m).invert()
    covInverse.set(cov.elements, i * 9)
  }

  bindSurface(parts, pivotPositions, rest, count, CELL * 1.55)

  return { count, rest, edges, restLength, bendEdges, bendLength, adjStart, adjacency, goal, invMass, covInverse, bandStart, bands, textureWidth: 32, profile }
}

function pivotPoints(part: ProxyPart) {
  const pos = part.geometry.getAttribute('position')
  const out = new Float32Array(pos.count * 3)
  const v = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(part.toPivot)
    out[i * 3] = v.x
    out[i * 3 + 1] = v.y
    out[i * 3 + 2] = v.z
  }
  return out
}

/** Uniform grid over points, for nearest-neighbour lookups at load time. */
function pointGrid(points: Float32Array, size: number) {
  const key = (x: number, y: number, z: number) => `${Math.floor(x / size)},${Math.floor(y / size)},${Math.floor(z / size)}`
  const cells = new Map<string, number[]>()
  for (let i = 0; i < points.length / 3; i++) {
    const k = key(points[i * 3], points[i * 3 + 1], points[i * 3 + 2])
    const list = cells.get(k)
    if (list) list.push(i)
    else cells.set(k, [i])
  }
  return {
    /** Indices in the 27 cells around (x, y, z). */
    around(x: number, y: number, z: number, visit: (i: number) => void) {
      const bx = Math.floor(x / size)
      const by = Math.floor(y / size)
      const bz = Math.floor(z / size)
      for (let ox = -1; ox <= 1; ox++)
        for (let oy = -1; oy <= 1; oy++)
          for (let oz = -1; oz <= 1; oz++) for (const i of cells.get(`${bx + ox},${by + oy},${bz + oz}`) ?? []) visit(i)
    },
  }
}

/**
 * Bind vertices to nearby particles with a smooth distance kernel K = (1 - d/R)³ (top 4,
 * normalised). Binding by cluster membership would jump at voxel borders.
 */
function bindSurface(parts: ProxyPart[], positions: Float32Array[], rest: Float32Array, count: number, reach: number) {
  const particles = pointGrid(rest, reach)
  const outer = positions[0]
  const outerCount = outer.length / 3
  const idx = new Float32Array(outerCount * 4)
  const wts = new Float32Array(outerCount * 4)
  const best = Array.from({ length: 4 }, () => ({ c: 0, k: 0 }))
  for (let i = 0; i < outerCount; i++) {
    const x = outer[i * 3]
    const y = outer[i * 3 + 1]
    const z = outer[i * 3 + 2]
    for (const b of best) b.k = 0
    particles.around(x, y, z, (c) => {
      const d = Math.sqrt((x - rest[c * 3]) ** 2 + (y - rest[c * 3 + 1]) ** 2 + (z - rest[c * 3 + 2]) ** 2)
      if (d >= reach) return
      const k = (1 - d / reach) ** 3
      let slot = -1
      for (let s = 0; s < 4; s++) if (k > best[s].k && (slot < 0 || best[s].k < best[slot].k)) slot = s
      if (slot >= 0) Object.assign(best[slot], { c, k })
    })
    const total = best.reduce((sum, b) => sum + b.k, 0)
    if (total === 0) {
      // Nothing within reach (should not happen): follow the nearest particle rigidly.
      let nearest = 0
      let nd = Infinity
      for (let c = 0; c < count; c++) {
        const d = (x - rest[c * 3]) ** 2 + (y - rest[c * 3 + 1]) ** 2 + (z - rest[c * 3 + 2]) ** 2
        if (d < nd) [nearest, nd] = [c, d]
      }
      idx[i * 4] = nearest
      wts[i * 4] = 1
      continue
    }
    for (let s = 0; s < 4; s++) {
      idx[i * 4 + s] = best[s].c
      wts[i * 4 + s] = best[s].k / total
    }
  }

  const write = (geometry: THREE.BufferGeometry, from: (attribute: Float32Array) => Float32Array) => {
    geometry.setAttribute('aProxyIdx', new THREE.BufferAttribute(from(idx), 4))
    geometry.setAttribute('aProxyW', new THREE.BufferAttribute(from(wts), 4))
  }
  write(parts[0].geometry, (a) => a)

  // Further shells copy the nearest outer vertex's binding: two shells 2 mm apart with
  // slightly different weights would cross wherever the offset field changes quickly.
  const shell = pointGrid(outer, 0.01)
  for (let p = 1; p < parts.length; p++) {
    const positions_ = positions[p]
    const n = positions_.length / 3
    const source = new Int32Array(n)
    for (let i = 0; i < n; i++) {
      const x = positions_[i * 3]
      const y = positions_[i * 3 + 1]
      const z = positions_[i * 3 + 2]
      let nearest = -1
      let nd = Infinity
      shell.around(x, y, z, (o) => {
        const d = (x - outer[o * 3]) ** 2 + (y - outer[o * 3 + 1]) ** 2 + (z - outer[o * 3 + 2]) ** 2
        if (d < nd) [nearest, nd] = [o, d]
      })
      if (nearest < 0) {
        for (let o = 0; o < outerCount; o++) {
          const d = (x - outer[o * 3]) ** 2 + (y - outer[o * 3 + 1]) ** 2 + (z - outer[o * 3 + 2]) ** 2
          if (d < nd) [nearest, nd] = [o, d]
        }
      }
      source[i] = nearest
    }
    write(parts[p].geometry, (a) => {
      const out = new Float32Array(n * 4)
      for (let i = 0; i < n; i++) out.set(a.subarray(source[i] * 4, source[i] * 4 + 4), i * 4)
      return out
    })
  }
}

const STEP = 1 / 60
const ITERATIONS = 3
/** Below this speed (m per step) cloth also loses velocity to friction. */
const SLOW = 0.0015
const SLOW_KEEP = 0.85
/**
 * Share of a contact's overlap resolved per step. Resolving all of it overshoots against the
 * shape and bending pull and leaves resting contact flickering between two states.
 */
const CONTACT_RELAX = 0.6
/** Fraction of velocity kept by a particle in contact with another garment, per step. */
const CONTACT_KEEP = 0.2
const TABLE = 8192
const HALF_STENCIL = (() => {
  const offsets = [0, 0, 0]
  for (let x = -1; x <= 1; x++)
    for (let y = -1; y <= 1; y++)
      for (let z = -1; z <= 1; z++) if (x > 0 || (x === 0 && (y > 0 || (y === 0 && z > 0)))) offsets.push(x, y, z)
  return Int32Array.from(offsets)
})()

/** Particle state for every garment, stepped together so they can collide. */
export class ClothSim {
  /** Per garment: particle offsets (body space, RGBA32F, one texel per particle). */
  readonly textures: THREE.DataTexture[]
  /** Per garment: each particle's deformation gradient, three texels (columns) per particle. */
  readonly gradients: THREE.DataTexture[]
  private x: Float32Array[]
  private prev: Float32Array[]
  private target: Float32Array[]
  /** Goals at the previous frame: substeps interpolate between the two. */
  private lastTarget: Float32Array[]
  private lastBody: THREE.Matrix4[]
  /** Each band's rotation (xyzw per band), warm start for the next polar decomposition. */
  private bandRotation: Float32Array[]
  private anchor: Float32Array
  private sleep = 0
  /** Last step's activity, for debugging. */
  stats = { moving: false, speed: 0, offsetChange: 0 }
  // Spatial hash (counting sort) over all particles.
  private cellStart = new Int32Array(TABLE + 1)
  private cellEntries: Int32Array
  private garmentOf: Int32Array
  private particleOf: Int32Array
  /** Particles that touched another garment this step (flat index g * n + i). */
  private touched: Uint8Array
  private offsets: Float32Array
  private smoothed: Float32Array

  constructor(
    readonly topology: ProxyTopology,
    readonly garments: number,
  ) {
    const n = topology.count
    const rows = Math.ceil(n / topology.textureWidth)
    this.textures = Array.from({ length: garments }, () => {
      const t = new THREE.DataTexture(new Float32Array(topology.textureWidth * rows * 4), topology.textureWidth, rows, THREE.RGBAFormat, THREE.FloatType)
      t.needsUpdate = true
      return t
    })
    this.gradients = Array.from({ length: garments }, () => {
      const t = new THREE.DataTexture(new Float32Array(topology.textureWidth * 3 * rows * 4), topology.textureWidth * 3, rows, THREE.RGBAFormat, THREE.FloatType)
      t.needsUpdate = true
      return t
    })
    this.x = Array.from({ length: garments }, () => new Float32Array(n * 3))
    this.prev = Array.from({ length: garments }, () => new Float32Array(n * 3))
    this.target = Array.from({ length: garments }, () => new Float32Array(n * 3))
    this.lastTarget = Array.from({ length: garments }, () => new Float32Array(n * 3))
    this.lastBody = Array.from({ length: garments }, () => new THREE.Matrix4())
    const bandCount = topology.bandStart.length - 1
    this.bandRotation = Array.from({ length: garments }, () => {
      const q = new Float32Array(bandCount * 4)
      for (let b = 0; b < bandCount; b++) q[b * 4 + 3] = 1
      return q
    })
    this.anchor = new Float32Array(garments * 3).fill(NaN)
    this.cellEntries = new Int32Array(n * garments)
    this.garmentOf = new Int32Array(n * garments)
    this.particleOf = new Int32Array(n * garments)
    this.touched = new Uint8Array(n * garments)
    this.offsets = new Float32Array(n * 3)
    this.smoothed = new Float32Array(n * 3)
    for (let g = 0; g < garments; g++) {
      for (let i = 0; i < n; i++) {
        this.garmentOf[g * n + i] = g
        this.particleOf[g * n + i] = i
      }
    }
  }

  /** Wake the simulation (e.g. after something moved the garments). */
  wake() {
    this.sleep = 0
  }

  /**
   * Advance by dt. `bodies[g]` is each garment's hanger-body world matrix; garments marked
   * `follow` track their rest shape exactly. `inertia[g]` scales the profile's inertia: 1 for
   * physical motion (lifting, spinning by hand), lower for choreography such as the rail
   * layout turning garments side-on. Returns true while moving.
   */
  step(dt: number, bodies: THREE.Matrix4[], follow: boolean[], inertia?: number[]) {
    const { count: n, rest, profile } = this.topology
    const frame = Math.min(dt, 1 / 20)
    const substeps = Math.max(1, Math.round(frame / STEP))
    const v = new THREE.Vector3()
    let moving = false

    // Goals in world space; a hanger that jumps (switch teleport) resets its cloth.
    for (let g = 0; g < this.garments; g++) {
      const t = this.target[g]
      const m = bodies[g]
      for (let i = 0; i < n; i++) {
        v.set(rest[i * 3], rest[i * 3 + 1], rest[i * 3 + 2]).applyMatrix4(m)
        t[i * 3] = v.x
        t[i * 3 + 1] = v.y
        t[i * 3 + 2] = v.z
      }
      const a = this.anchor
      const jump = Number.isNaN(a[g * 3]) || Math.hypot(t[0] - a[g * 3], t[1] - a[g * 3 + 1], t[2] - a[g * 3 + 2]) > 0.3
      if (jump || follow[g]) {
        this.x[g].set(t)
        this.prev[g].set(t)
        this.lastTarget[g].set(t)
      } else {
        this.carry(g, m, inertia?.[g] ?? 1)
      }
      this.lastBody[g].copy(m)
      if (Math.hypot(t[0] - a[g * 3], t[1] - a[g * 3 + 1], t[2] - a[g * 3 + 2]) > 2e-5) moving = true
      a[g * 3] = t[0]
      a[g * 3 + 1] = t[1]
      a[g * 3 + 2] = t[2]
    }
    if (!moving && this.sleep > 30) return false

    let speed = 0
    for (let s = 0; s < substeps; s++) {
      const along = (s + 1) / substeps
      for (let g = 0; g < this.garments; g++) {
        if (follow[g]) continue
        const x = this.x[g]
        const p = this.prev[g]
        const t = this.target[g]
        const last = this.lastTarget[g]
        for (let i = 0; i < n; i++) {
          const k = this.topology.goal[i]
          const j = i * 3
          // Velocity relative to the hanger (goal velocity) is what damps.
          const gx = (t[j] - last[j]) / substeps
          const gy = (t[j + 1] - last[j + 1]) / substeps
          const gz = (t[j + 2] - last[j + 2]) / substeps
          const rx = x[j] - p[j] - gx
          const ry = x[j + 1] - p[j + 1] - gy
          const rz = x[j + 2] - p[j + 2] - gz
          // Slow cloth stops quickly (fabric friction); fast swings keep their momentum.
          const damping = rx * rx + ry * ry + rz * rz < SLOW * SLOW ? profile.damping * SLOW_KEEP : profile.damping
          const air = 1 - profile.airDrag
          p[j] = x[j]
          p[j + 1] = x[j + 1]
          p[j + 2] = x[j + 2]
          x[j] += (gx + rx * damping) * air
          x[j + 1] += (gy + ry * damping) * air
          x[j + 2] += (gz + rz * damping) * air
          x[j] += (last[j] + (t[j] - last[j]) * along - x[j]) * k
          x[j + 1] += (last[j + 1] + (t[j + 1] - last[j + 1]) * along - x[j + 1]) * k
          x[j + 2] += (last[j + 2] + (t[j + 2] - last[j + 2]) * along - x[j + 2]) * k
        }
      }
      this.touched.fill(0)
      for (let it = 0; it < ITERATIONS; it++) {
        for (let g = 0; g < this.garments; g++) {
          if (follow[g]) continue
          if (it === 0) this.solveShape(g, along)
          this.solveEdges(g, this.topology.edges, this.topology.restLength, 1)
          if (it === 0) this.solveEdges(g, this.topology.bendEdges, this.topology.bendLength, profile.bend)
        }
        // Contacts once per step, last, so the drawn cloth is free of contact at these speeds.
        if (it === ITERATIONS - 1) this.solveCollisions(follow)
      }
      for (let g = 0; g < this.garments; g++) {
        const x = this.x[g]
        const p = this.prev[g]
        for (let i = 0; i < n; i++) {
          // Cloth pressed against cloth: friction eats the velocity that the edge
          // constraints would otherwise keep re-injecting against the contact.
          if (this.touched[g * n + i]) {
            for (let c = 0; c < 3; c++) p[i * 3 + c] = x[i * 3 + c] - (x[i * 3 + c] - p[i * 3 + c]) * CONTACT_KEEP
          }
          for (let c = 0; c < 3; c++) speed = Math.max(speed, Math.abs(x[i * 3 + c] - p[i * 3 + c]))
        }
      }
    }

    for (let g = 0; g < this.garments; g++) this.lastTarget[g].set(this.target[g])

    // Offsets back into each garment's body space, smoothed over the proxy so neighbouring
    // particles never tear the render mesh, then uploaded for the vertex shader.
    const inverse = new THREE.Matrix4()
    const { adjStart, adjacency, invMass } = this.topology
    const raw = this.offsets
    const smooth = this.smoothed
    let offsetChange = 0
    for (let g = 0; g < this.garments; g++) {
      inverse.copy(bodies[g]).invert()
      const x = this.x[g]
      const t = this.target[g]
      for (let j = 0; j < n * 3; j++) raw[j] = x[j] - t[j]
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < n; i++) {
          const a = adjStart[i]
          const z = adjStart[i + 1]
          // Pinned cloth stays on the hanger; smoothing must not lift it off.
          if (invMass[i] === 0) {
            smooth[i * 3] = smooth[i * 3 + 1] = smooth[i * 3 + 2] = 0
            continue
          }
          for (let c = 0; c < 3; c++) {
            let sum = 0
            for (let q = a; q < z; q++) sum += raw[adjacency[q] * 3 + c]
            smooth[i * 3 + c] = z > a ? 0.5 * raw[i * 3 + c] + (0.5 * sum) / (z - a) : raw[i * 3 + c]
          }
        }
        raw.set(smooth)
      }
      const data = this.textures[g].image.data as Float32Array
      for (let i = 0; i < n; i++) {
        const len = Math.sqrt(raw[i * 3] ** 2 + raw[i * 3 + 1] ** 2 + raw[i * 3 + 2] ** 2)
        v.set(raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2]).transformDirection(inverse)
        v.multiplyScalar(Math.min(len, profile.maxOffset))
        offsetChange = Math.max(offsetChange, Math.abs(data[i * 4] - v.x), Math.abs(data[i * 4 + 1] - v.y), Math.abs(data[i * 4 + 2] - v.z))
        data[i * 4] = v.x
        data[i * 4 + 1] = v.y
        data[i * 4 + 2] = v.z
      }
      this.textures[g].needsUpdate = true
      this.writeGradients(g, data)
    }

    // Judge rest by how much the rendered offsets still change: resting contact keeps a small
    // stored velocity that the constraints cancel every step, so `speed` never reaches zero.
    const active = moving || offsetChange > 3e-5
    this.stats = { moving, speed, offsetChange }
    this.sleep = active ? 0 : this.sleep + 1
    return active || this.sleep <= 30
  }

  private solveEdges(g: number, edges: Uint32Array, restLength: Float32Array, stiffness: number) {
    const { invMass } = this.topology
    const x = this.x[g]
    for (let e = 0; e < restLength.length; e++) {
      const i = edges[e * 2]
      const j = edges[e * 2 + 1]
      const wi = invMass[i]
      const wj = invMass[j]
      const w = wi + wj
      if (w === 0) continue
      const dx = x[j * 3] - x[i * 3]
      const dy = x[j * 3 + 1] - x[i * 3 + 1]
      const dz = x[j * 3 + 2] - x[i * 3 + 2]
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9
      const c = ((d - restLength[e]) / d / w) * stiffness
      x[i * 3] += dx * c * wi
      x[i * 3 + 1] += dy * c * wi
      x[i * 3 + 2] += dz * c * wi
      x[j * 3] -= dx * c * wj
      x[j * 3 + 1] -= dy * c * wj
      x[j * 3 + 2] -= dz * c * wj
    }
  }

  /**
   * Least-squares deformation gradient of the offset field at each particle, from its
   * neighbours: J = Σ (o_j - o_i)(r_j - r_i)ᵀ · C⁻¹. Interpolating J (rather than
   * differentiating the interpolated offsets) keeps shading smooth between particles.
   */
  private writeGradients(g: number, offsets: Float32Array) {
    const { count: n, rest, adjStart, adjacency, covInverse } = this.topology
    const out = this.gradients[g].image.data as Float32Array
    for (let i = 0; i < n; i++) {
      // B = Σ (o_j - o_i)(r_j - r_i)ᵀ, row-major b[r][c].
      let b00 = 0, b01 = 0, b02 = 0, b10 = 0, b11 = 0, b12 = 0, b20 = 0, b21 = 0, b22 = 0
      for (let q = adjStart[i]; q < adjStart[i + 1]; q++) {
        const j = adjacency[q]
        const ox = offsets[j * 4] - offsets[i * 4]
        const oy = offsets[j * 4 + 1] - offsets[i * 4 + 1]
        const oz = offsets[j * 4 + 2] - offsets[i * 4 + 2]
        const rx = rest[j * 3] - rest[i * 3]
        const ry = rest[j * 3 + 1] - rest[i * 3 + 1]
        const rz = rest[j * 3 + 2] - rest[i * 3 + 2]
        b00 += ox * rx; b01 += ox * ry; b02 += ox * rz
        b10 += oy * rx; b11 += oy * ry; b12 += oy * rz
        b20 += oz * rx; b21 += oz * ry; b22 += oz * rz
      }
      const c = covInverse.subarray(i * 9, i * 9 + 9) // column-major
      // Column k of J = B · (column k of C⁻¹).
      for (let k = 0; k < 3; k++) {
        const c0 = c[k * 3]
        const c1 = c[k * 3 + 1]
        const c2 = c[k * 3 + 2]
        const t = (i * 3 + k) * 4
        out[t] = b00 * c0 + b01 * c1 + b02 * c2
        out[t + 1] = b10 * c0 + b11 * c1 + b12 * c2
        out[t + 2] = b20 * c0 + b21 * c1 + b22 * c2
      }
    }
    this.gradients[g].needsUpdate = true
  }

  /**
   * Move part of the hanger's motion since last frame straight onto the cloth (positions,
   * previous positions and last goals alike), so only the rest acts as inertia.
   */
  private carry(g: number, body: THREE.Matrix4, scale: number) {
    const n = this.topology.count
    const { maxInertialStep } = this.topology.profile
    const inertia = this.topology.profile.inertia * scale
    const t = this.target[g]
    const last = this.lastTarget[g]
    let move = 0
    for (let j = 0; j < n * 3; j += 3) move = Math.max(move, (t[j] - last[j]) ** 2 + (t[j + 1] - last[j + 1]) ** 2 + (t[j + 2] - last[j + 2]) ** 2)
    move = Math.sqrt(move)
    if (move < 1e-7) return
    const felt = Math.min(inertia, maxInertialStep / move)
    const keep = 1 - felt
    const delta = this.delta.copy(body).multiply(this.inverse.copy(this.lastBody[g]).invert())
    const e = delta.elements
    for (const a of [this.x[g], this.prev[g]]) {
      for (let j = 0; j < n * 3; j += 3) {
        const x = a[j]
        const y = a[j + 1]
        const z = a[j + 2]
        a[j] += (e[0] * x + e[4] * y + e[8] * z + e[12] - x) * keep
        a[j + 1] += (e[1] * x + e[5] * y + e[9] * z + e[13] - y) * keep
        a[j + 2] += (e[2] * x + e[6] * y + e[10] * z + e[14] - z) * keep
      }
    }
    for (let j = 0; j < n * 3; j++) last[j] += (t[j] - last[j]) * keep
  }
  private delta = new THREE.Matrix4()
  private inverse = new THREE.Matrix4()

  /**
   * Shape matching per band (Müller et al. 2005): find the rotation that best maps the band's
   * drape onto where its particles are now, and pull them toward that rotated drape. The
   * rotation comes from a few warm-started iterations of Müller et al. 2016.
   */
  private solveShape(g: number, along: number) {
    const { bandStart, bands, invMass, profile } = this.topology
    const x = this.x[g]
    const t = this.target[g]
    const last = this.lastTarget[g]
    const rot = this.bandRotation[g]
    const q = this.q
    const qa = this.qa
    const r0 = this.r0
    const r1 = this.r1
    const r2 = this.r2
    const omega = this.omega
    const e = this.m3.elements
    for (let b = 0; b < bandStart.length - 1; b++) {
      const from = bandStart[b]
      const to = bandStart[b + 1]
      // Centroids of the drape (goal, interpolated like the integration) and of the cloth.
      let gx = 0, gy = 0, gz = 0, cx = 0, cy = 0, cz = 0
      for (let m = from; m < to; m++) {
        const j = bands[m] * 3
        gx += last[j] + (t[j] - last[j]) * along
        gy += last[j + 1] + (t[j + 1] - last[j + 1]) * along
        gz += last[j + 2] + (t[j + 2] - last[j + 2]) * along
        cx += x[j]
        cy += x[j + 1]
        cz += x[j + 2]
      }
      const size = to - from
      gx /= size; gy /= size; gz /= size; cx /= size; cy /= size; cz /= size
      // A = Σ (x - c)(goal - g)ᵀ, columns a0..a2.
      let a00 = 0, a01 = 0, a02 = 0, a10 = 0, a11 = 0, a12 = 0, a20 = 0, a21 = 0, a22 = 0
      for (let m = from; m < to; m++) {
        const j = bands[m] * 3
        const px = x[j] - cx
        const py = x[j + 1] - cy
        const pz = x[j + 2] - cz
        const ux = last[j] + (t[j] - last[j]) * along - gx
        const uy = last[j + 1] + (t[j + 1] - last[j + 1]) * along - gy
        const uz = last[j + 2] + (t[j + 2] - last[j + 2]) * along - gz
        a00 += px * ux; a01 += px * uy; a02 += px * uz
        a10 += py * ux; a11 += py * uy; a12 += py * uz
        a20 += pz * ux; a21 += pz * uy; a22 += pz * uz
      }
      q.set(rot[b * 4], rot[b * 4 + 1], rot[b * 4 + 2], rot[b * 4 + 3])
      for (let k = 0; k < 6; k++) {
        this.m4.makeRotationFromQuaternion(q)
        const me = this.m4.elements
        r0.set(me[0], me[1], me[2])
        r1.set(me[4], me[5], me[6])
        r2.set(me[8], me[9], me[10])
        const dot = r0.x * a00 + r0.y * a10 + r0.z * a20 + r1.x * a01 + r1.y * a11 + r1.z * a21 + r2.x * a02 + r2.y * a12 + r2.z * a22
        omega.set(r0.y * a20 - r0.z * a10, r0.z * a00 - r0.x * a20, r0.x * a10 - r0.y * a00)
        omega.x += r1.y * a21 - r1.z * a11
        omega.y += r1.z * a01 - r1.x * a21
        omega.z += r1.x * a11 - r1.y * a01
        omega.x += r2.y * a22 - r2.z * a12
        omega.y += r2.z * a02 - r2.x * a22
        omega.z += r2.x * a12 - r2.y * a02
        omega.multiplyScalar(1 / (Math.abs(dot) + 1e-9))
        const w = omega.length()
        if (w < 1e-7) break
        qa.setFromAxisAngle(omega.divideScalar(w), w)
        q.premultiply(qa).normalize()
      }
      rot[b * 4] = q.x
      rot[b * 4 + 1] = q.y
      rot[b * 4 + 2] = q.z
      rot[b * 4 + 3] = q.w
      this.m3.setFromMatrix4(this.m4.makeRotationFromQuaternion(q))
      for (let m = from; m < to; m++) {
        const i = bands[m]
        if (invMass[i] === 0) continue
        const j = i * 3
        const ux = last[j] + (t[j] - last[j]) * along - gx
        const uy = last[j + 1] + (t[j + 1] - last[j + 1]) * along - gy
        const uz = last[j + 2] + (t[j + 2] - last[j + 2]) * along - gz
        x[j] += (cx + e[0] * ux + e[3] * uy + e[6] * uz - x[j]) * profile.shape
        x[j + 1] += (cy + e[1] * ux + e[4] * uy + e[7] * uz - x[j + 1]) * profile.shape
        x[j + 2] += (cz + e[2] * ux + e[5] * uy + e[8] * uz - x[j + 2]) * profile.shape
      }
    }
  }
  private q = new THREE.Quaternion()
  private qa = new THREE.Quaternion()
  private r0 = new THREE.Vector3()
  private r1 = new THREE.Vector3()
  private r2 = new THREE.Vector3()
  private omega = new THREE.Vector3()
  private m3 = new THREE.Matrix3()
  private m4 = new THREE.Matrix4()

  private cellHash(ix: number, iy: number, iz: number) {
    return Math.abs((ix * 92837111) ^ (iy * 689287499) ^ (iz * 283923481)) % TABLE
  }

  private hash(x: number, y: number, z: number) {
    const size = 2 * this.topology.profile.radius
    return this.cellHash(Math.floor(x / size), Math.floor(y / size), Math.floor(z / size))
  }

  /**
   * Push apart particles closer than two radii: from different garments always, from the same
   * garment when they started further apart (front panel meeting the back panel).
   */
  private solveCollisions(follow: boolean[]) {
    const n = this.topology.count
    const total = n * this.garments
    const start = this.cellStart
    start.fill(0)
    for (let k = 0; k < total; k++) {
      const x = this.x[this.garmentOf[k]]
      const i = this.particleOf[k]
      start[this.hash(x[i * 3], x[i * 3 + 1], x[i * 3 + 2])]++
    }
    for (let c = 1; c <= TABLE; c++) start[c] += start[c - 1]
    for (let k = 0; k < total; k++) {
      const x = this.x[this.garmentOf[k]]
      const i = this.particleOf[k]
      this.cellEntries[--start[this.hash(x[i * 3], x[i * 3 + 1], x[i * 3 + 2])]] = k
    }
    const { invMass, rest } = this.topology
    const reach = 2 * this.topology.profile.radius
    for (let k = 0; k < total; k++) {
      const ga = this.garmentOf[k]
      const ia = this.particleOf[k]
      const xa = this.x[ga]
      const wa = follow[ga] ? 0 : invMass[ia]
      const cx = Math.floor(xa[ia * 3] / reach)
      const cy = Math.floor(xa[ia * 3 + 1] / reach)
      const cz = Math.floor(xa[ia * 3 + 2] / reach)
      // Half stencil: the own cell (pairs with kb > k) plus the 13 neighbours "ahead" of it,
      // so each pair of cells is visited from one side only.
      for (let h = 0; h < HALF_STENCIL.length; h += 3) {
        const own = h === 0
        const cell = this.cellHash(cx + HALF_STENCIL[h], cy + HALF_STENCIL[h + 1], cz + HALF_STENCIL[h + 2])
        for (let s = start[cell]; s < start[cell + 1]; s++) {
          const kb = this.cellEntries[s]
          const gb = this.garmentOf[kb]
          if (own && kb <= k) continue
          const ib = this.particleOf[kb]
          if (gb === ga) {
            if (ib === ia) continue
            const rx = rest[ib * 3] - rest[ia * 3]
            const ry = rest[ib * 3 + 1] - rest[ia * 3 + 1]
            const rz = rest[ib * 3 + 2] - rest[ia * 3 + 2]
            if (rx * rx + ry * ry + rz * rz <= reach * reach) continue
          }
          const xb = this.x[gb]
          const wb = follow[gb] ? 0 : invMass[ib]
          const w = wa + wb
          if (w === 0) continue
          const dx = xb[ib * 3] - xa[ia * 3]
          const dy = xb[ib * 3 + 1] - xa[ia * 3 + 1]
          const dz = xb[ib * 3 + 2] - xa[ia * 3 + 2]
          const d2 = dx * dx + dy * dy + dz * dz
          if (d2 >= reach * reach) continue
          const d = Math.sqrt(d2) || 1e-9
          const c = ((reach - d) / d / w) * CONTACT_RELAX
          // Inelastic contact: move positions and previous positions together, so a
          // push separates the cloth without turning into bounce (packed garments sit
          // in permanent contact and would otherwise jitter forever).
          const pa = this.prev[ga]
          const pb = this.prev[gb]
          this.touched[k] = 1
          this.touched[kb] = 1
          for (let q = 0; q < 3; q++) {
            const delta = q === 0 ? dx : q === 1 ? dy : dz
            xa[ia * 3 + q] -= delta * c * wa
            pa[ia * 3 + q] -= delta * c * wa
            xb[ib * 3 + q] += delta * c * wb
            pb[ib * 3 + q] += delta * c * wb
          }
        }
      }
    }
  }
}
