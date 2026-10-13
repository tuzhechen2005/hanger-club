// Real-time secondary cloth motion: each garment is driven by a coarse particle proxy
// (~300–400 particles) simulated with position-based dynamics. The proxy hangs from the
// hanger (yoke pinned), keeps the authored drape through soft goal springs that weaken toward
// the hem, keeps itself together with distance constraints, and collides with the other
// garments. The full-resolution mesh follows the proxy on the GPU through per-vertex
// bindings (up to 4 particles each).
//
// The authored drape (Blender) is the rest shape; the proxy only adds inertia, sway and
// contact on top of it. It is not a full cloth simulation of the render mesh.

import * as THREE from 'three'

export interface ProxyPart {
  geometry: THREE.BufferGeometry
  /** Mesh-local → hanger (pivot) space; quantised GLB meshes are not in metres. */
  toPivot: THREE.Matrix4
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
  textureWidth: number
}

const CELL = 0.055
const PIN_ABOVE = -0.14
const GOAL_TOP = 0.16
const GOAL_HEM = 0.014
const HANG = 0.65
/** Radius of the skinning kernel; a bit over one cluster so every vertex sees 3–4 particles. */
const BIND_RADIUS = 0.085

/**
 * Cluster the garment's vertices into a voxel grid; one particle per occupied cell. Adds
 * `aProxyIdx` / `aProxyW` attributes to every part's geometry (shared by all garments).
 */
export function buildProxy(parts: ProxyPart[]): ProxyTopology {
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

  // The yoke rides on the hanger; below it the drape loosens toward the hem.
  const goal = new Float32Array(count)
  const invMass = new Float32Array(count)
  for (let c = 0; c < count; c++) {
    const y = rest[c * 3 + 1]
    if (y > PIN_ABOVE) {
      goal[c] = 1
      invMass[c] = 0
    } else {
      const f = Math.min(1, (PIN_ABOVE - y) / HANG)
      const s = f * f * (3 - 2 * f)
      goal[c] = GOAL_TOP + (GOAL_HEM - GOAL_TOP) * s
      invMass[c] = 1
    }
  }

  // Bind each vertex to nearby particles with a smooth distance kernel. Binding by cluster
  // membership would jump at voxel borders, so the outer and inner fabric shells (2 mm apart)
  // could follow different particles and cross under large motion.
  const reach = BIND_RADIUS
  const grid = new Map<string, number[]>()
  const gkey = (x: number, y: number, z: number) => `${Math.floor(x / reach)},${Math.floor(y / reach)},${Math.floor(z / reach)}`
  for (let c = 0; c < count; c++) {
    const key = gkey(rest[c * 3], rest[c * 3 + 1], rest[c * 3 + 2])
    const list = grid.get(key)
    if (list) list.push(c)
    else grid.set(key, [c])
  }
  parts.forEach((part, p) => {
    const positions = pivotPositions[p]
    const ids = vertexCluster[p]
    const n = ids.length
    const idx = new Float32Array(n * 4)
    const wts = new Float32Array(n * 4)
    const best = [
      { c: 0, w: 0 },
      { c: 0, w: 0 },
      { c: 0, w: 0 },
      { c: 0, w: 0 },
    ]
    for (let i = 0; i < n; i++) {
      const x = positions[i * 3]
      const y = positions[i * 3 + 1]
      const z = positions[i * 3 + 2]
      for (const b of best) b.w = 0
      const bx = Math.floor(x / reach)
      const by = Math.floor(y / reach)
      const bz = Math.floor(z / reach)
      for (let ox = -1; ox <= 1; ox++)
        for (let oy = -1; oy <= 1; oy++)
          for (let oz = -1; oz <= 1; oz++) {
            for (const c of grid.get(`${bx + ox},${by + oy},${bz + oz}`) ?? []) {
              const d = Math.sqrt((x - rest[c * 3]) ** 2 + (y - rest[c * 3 + 1]) ** 2 + (z - rest[c * 3 + 2]) ** 2)
              if (d >= reach) continue
              const w = (1 - d / reach) ** 3
              let slot = -1
              for (let k = 0; k < 4; k++) if (w > best[k].w && (slot < 0 || best[k].w < best[slot].w)) slot = k
              if (slot >= 0) best[slot] = { c, w }
            }
          }
      let total = best.reduce((sum, b) => sum + b.w, 0)
      if (total === 0) {
        // Nothing within reach (should not happen): follow the own cluster.
        best[0] = { c: ids[i], w: 1 }
        total = 1
      }
      for (let k = 0; k < 4; k++) {
        idx[i * 4 + k] = best[k].c
        wts[i * 4 + k] = best[k].w / total
      }
    }
    part.geometry.setAttribute('aProxyIdx', new THREE.BufferAttribute(idx, 4))
    part.geometry.setAttribute('aProxyW', new THREE.BufferAttribute(wts, 4))
  })

  return { count, rest, edges, restLength, bendEdges, bendLength, adjStart, adjacency, goal, invMass, textureWidth: 32 }
}

const STEP = 1 / 60
const ITERATIONS = 3
const DAMPING = 0.972
/** Below this speed (m per step) cloth also loses velocity to friction. */
const SLOW = 0.0015
const SLOW_KEEP = 0.85
const RADIUS = 0.024
const MAX_OFFSET = 0.12
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
  readonly textures: THREE.DataTexture[]
  private x: Float32Array[]
  private prev: Float32Array[]
  private target: Float32Array[]
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
    this.x = Array.from({ length: garments }, () => new Float32Array(n * 3))
    this.prev = Array.from({ length: garments }, () => new Float32Array(n * 3))
    this.target = Array.from({ length: garments }, () => new Float32Array(n * 3))
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
   * `follow` (baked clip playing) track their rest shape exactly. Returns true while moving.
   */
  step(dt: number, bodies: THREE.Matrix4[], follow: boolean[]) {
    const { count: n, rest } = this.topology
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
      }
      if (Math.hypot(t[0] - a[g * 3], t[1] - a[g * 3 + 1], t[2] - a[g * 3 + 2]) > 2e-5) moving = true
      a[g * 3] = t[0]
      a[g * 3 + 1] = t[1]
      a[g * 3 + 2] = t[2]
    }
    if (!moving && this.sleep > 30) return false

    let speed = 0
    for (let s = 0; s < substeps; s++) {
      for (let g = 0; g < this.garments; g++) {
        if (follow[g]) continue
        const x = this.x[g]
        const p = this.prev[g]
        const t = this.target[g]
        for (let i = 0; i < n; i++) {
          const k = this.topology.goal[i]
          const j = i * 3
          // Slow cloth stops quickly (fabric friction); fast swings keep their momentum.
          const v2 = (x[j] - p[j]) ** 2 + (x[j + 1] - p[j + 1]) ** 2 + (x[j + 2] - p[j + 2]) ** 2
          const damping = v2 < SLOW * SLOW ? DAMPING * SLOW_KEEP : DAMPING
          for (let c = 0; c < 3; c++) {
            const vel = (x[j + c] - p[j + c]) * damping
            p[j + c] = x[j + c]
            x[j + c] += vel
            x[j + c] += (t[j + c] - x[j + c]) * k
          }
        }
      }
      this.touched.fill(0)
      for (let it = 0; it < ITERATIONS; it++) {
        for (let g = 0; g < this.garments; g++) {
          if (follow[g]) continue
          this.solveEdges(g, this.topology.edges, this.topology.restLength, 1)
          if (it === 0) this.solveEdges(g, this.topology.bendEdges, this.topology.bendLength, 0.5)
        }
        // Contacts once per step, between the edge passes, is enough at these speeds.
        if (it === 0) this.solveCollisions(follow)
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

    // Offsets back into each garment's body space, smoothed over the proxy so neighbouring
    // particles never tear the render mesh, then uploaded for the vertex shader.
    const inverse = new THREE.Matrix4()
    const { adjStart, adjacency } = this.topology
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
        v.multiplyScalar(Math.min(len, MAX_OFFSET))
        offsetChange = Math.max(offsetChange, Math.abs(data[i * 4] - v.x), Math.abs(data[i * 4 + 1] - v.y), Math.abs(data[i * 4 + 2] - v.z))
        data[i * 4] = v.x
        data[i * 4 + 1] = v.y
        data[i * 4 + 2] = v.z
      }
      this.textures[g].needsUpdate = true
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

  private cellHash(ix: number, iy: number, iz: number) {
    return Math.abs((ix * 92837111) ^ (iy * 689287499) ^ (iz * 283923481)) % TABLE
  }

  private hash(x: number, y: number, z: number) {
    const size = 2 * RADIUS
    return this.cellHash(Math.floor(x / size), Math.floor(y / size), Math.floor(z / size))
  }

  /** Push apart particles of different garments closer than two radii. */
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
    const { invMass } = this.topology
    const reach = 2 * RADIUS
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
          if (gb === ga || (own && kb <= k)) continue
          const ib = this.particleOf[kb]
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
          const c = (reach - d) / d / w
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
