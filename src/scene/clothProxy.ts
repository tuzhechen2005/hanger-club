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
   * Shape keeping per local region (0–1): each patch of cloth tries to stay a rotated copy of
   * its drape. Regions can turn against each other (sway, a sleeve swinging at the armhole),
   * but a patch cannot crumple or shear, so the garment moves like cloth instead of jelly.
   */
  shape: number
  /** Largest offset the render mesh may take from the authored drape (m). */
  maxOffset: number
  /** Particle collision radius (m): about half the cell, more than the fabric thickness. */
  radius: number
}

/** Mid-weight cotton jersey tee on a wooden hanger (the demo's boxy tee). */
export const JERSEY_TEE: ClothProfile = {
  cell: 0.04,
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
  radius: 0.018,
}

/** Jersey long sleeve: the tee's fabric, but its long sleeves need more shape keeping. */
export const LONGSLEEVE_JERSEY: ClothProfile = { ...JERSEY_TEE, goalHem: 0.06, shape: 0.5, maxOffset: 0.1 }

/** Heavy brushed fleece hoodie: hangs heavier, swings less, holds its shape. */
export const FLEECE_HOODIE: ClothProfile = { ...JERSEY_TEE, cell: 0.046, radius: 0.02, goalTop: 0.36, goalHem: 0.07, damping: 0.93, airDrag: 0.006, shape: 0.45, bend: 0.8 }

/** Light nylon shell jacket: stiff, crisp panels, more air drag. */
export const NYLON_SHELL: ClothProfile = { ...JERSEY_TEE, cell: 0.048, radius: 0.021, goalTop: 0.36, goalHem: 0.065, damping: 0.94, airDrag: 0.008, shape: 0.5, bend: 0.85 }

/** Denim skirt on a clip hanger: stiff, short, barely sways. */
export const DENIM_SKIRT: ClothProfile = { ...JERSEY_TEE, goalTop: 0.35, goalHem: 0.07, shape: 0.45, bend: 0.9, maxOffset: 0.07 }

/** Trousers on a clip hanger: long legs that swing from the waistband. */
export const TROUSERS: ClothProfile = { ...JERSEY_TEE, goalHem: 0.05, damping: 0.94, shape: 0.4, bend: 0.75, maxOffset: 0.1 }

/** Fabric profile for each garment kind (docs/cloth-motion.md §6). */
export const PROFILES: Record<string, ClothProfile> = {
  tee: JERSEY_TEE,
  longsleeve: LONGSLEEVE_JERSEY,
  hoodie: FLEECE_HOODIE,
  shell: NYLON_SHELL,
  skirt: DENIM_SKIRT,
  pants: TROUSERS,
}

/** The same fabric on a coarser proxy, for devices that cannot keep up (about half the cost). */
export function coarser(profile: ClothProfile): ClothProfile {
  return { ...profile, cell: profile.cell * 1.35, radius: profile.radius * 1.35 }
}

/** Average simulation time per step (ms) above which a device counts as too slow. */
export const SLOW_STEP_MS = 7

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
  /** Overlapping local regions for shape keeping (CSR: members of region r). */
  regionStart: Uint32Array
  regions: Uint32Array
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
  const pivotPositions = parts.map(pivotPoints)
  const points = pivotPositions[0]
  const vertexCount = points.length / 3
  const index = parts[0].geometry.getIndex()
  const corners = index ? index.array : Uint32Array.from({ length: vertexCount }, (_, i) => i)

  // Patches: vertices in the same voxel that are also connected on the cloth within it. A plain
  // voxel grid glues a sleeve to the body side (or front to back) wherever they hang within one
  // cell, and the sleeve can then never swing on its own.
  const parent = Int32Array.from({ length: vertexCount }, (_, i) => i)
  const find = (i: number) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]]
    return i
  }
  const union = (a: number, b: number) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[ra] = rb
    return rb
  }
  const voxel = (i: number) => `${Math.floor(points[i * 3] / CELL)},${Math.floor(points[i * 3 + 1] / CELL)},${Math.floor(points[i * 3 + 2] / CELL)}`
  const voxels = Array.from({ length: vertexCount }, (_, i) => voxel(i))
  // UV seams split vertices at one position: weld them.
  const welded = new Map<string, number>()
  for (let i = 0; i < vertexCount; i++) {
    const key = `${Math.round(points[i * 3] * 1e4)},${Math.round(points[i * 3 + 1] * 1e4)},${Math.round(points[i * 3 + 2] * 1e4)}`
    const other = welded.get(key)
    if (other === undefined) welded.set(key, i)
    else union(i, other)
  }
  const forEachEdge = (visit: (a: number, b: number) => void) => {
    for (let t = 0; t < corners.length; t += 3) {
      visit(corners[t], corners[t + 1])
      visit(corners[t + 1], corners[t + 2])
      visit(corners[t + 2], corners[t])
    }
  }
  forEachEdge((a, b) => {
    if (voxels[a] === voxels[b]) union(a, b)
  })
  // Fold slivers (a patch clipped by a voxel corner) into the neighbour they touch: anything
  // under a quarter of the typical patch.
  const patchSizes = () => {
    const size = new Map<number, number>()
    for (let i = 0; i < vertexCount; i++) size.set(find(i), (size.get(find(i)) ?? 0) + 1)
    return size
  }
  const typical = [...patchSizes().values()].sort((p, q) => p - q)
  const minSize = Math.max(2, typical[typical.length >> 1] / 4)
  for (let pass = 0; pass < 4; pass++) {
    const size = patchSizes()
    let merged = false
    forEachEdge((a, b) => {
      const ra = find(a)
      const rb = find(b)
      if (ra === rb) return
      const sa = size.get(ra)!
      const sb = size.get(rb)!
      if (Math.min(sa, sb) >= minSize) return
      const root = sa < sb ? union(a, b) : union(b, a)
      size.set(root, sa + sb)
      merged = true
    })
    if (!merged) break
  }
  const clusterOfRoot = new Map<number, number>()
  const outerCluster = new Int32Array(vertexCount)
  const sums: number[] = []
  const counts: number[] = []
  for (let i = 0; i < vertexCount; i++) {
    const root = find(i)
    let id = clusterOfRoot.get(root)
    if (id === undefined) {
      id = counts.length
      clusterOfRoot.set(root, id)
      counts.push(0)
      sums.push(0, 0, 0)
    }
    outerCluster[i] = id
    counts[id]++
    for (let k = 0; k < 3; k++) sums[id * 3 + k] += points[i * 3 + k]
  }

  const count = counts.length
  const rest = new Float32Array(count * 3)
  for (let c = 0; c < count; c++) for (let k = 0; k < 3; k++) rest[c * 3 + k] = sums[c * 3 + k] / counts[c]

  // Edges wherever a cloth edge joins two patches.
  const edgeSet = new Set<number>()
  const neighbors: Set<number>[] = Array.from({ length: count }, () => new Set())
  forEachEdge((va, vb) => {
    const i = outerCluster[va]
    const j = outerCluster[vb]
    if (i === j) return
    edgeSet.add(Math.min(i, j) * count + Math.max(i, j))
    neighbors[i].add(j)
    neighbors[j].add(i)
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

  // Shape-keeping regions: a centre particle and everything two links away on the cloth.
  // Centres are spread so every particle neighbours one, so regions overlap and hold each other,
  // while a sleeve (joined to the body only at the armhole) can still swing on its own.
  const covered = new Uint8Array(count)
  const regionLists: number[][] = []
  for (let c = 0; c < count; c++) {
    if (covered[c]) continue
    const members = new Set([c])
    for (let q = adjStart[c]; q < adjStart[c + 1]; q++) {
      const j = adjacency[q]
      members.add(j)
      covered[j] = 1
      for (let r = adjStart[j]; r < adjStart[j + 1]; r++) members.add(adjacency[r])
    }
    covered[c] = 1
    const list = [...members]
    if (list.length >= 4 && list.some((m) => invMass[m] > 0)) regionLists.push(list)
  }
  const regionStart = new Uint32Array(regionLists.length + 1)
  regionLists.forEach((m, r) => (regionStart[r + 1] = regionStart[r] + m.length))
  const regions = Uint32Array.from(regionLists.flat())

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

  bindSurface(parts, pivotPositions, rest, outerCluster, adjStart, adjacency, CELL * 1.55)

  return { count, rest, edges, restLength, bendEdges, bendLength, adjStart, adjacency, goal, invMass, covInverse, regionStart, regions, textureWidth: 32, profile }
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
 * normalised). Binding only to the own patch would jump at patch borders. Candidates are the
 * own patch and its neighbours on the cloth, never a particle that is merely close in space
 * (a sleeve vertex must not follow the body side it hangs against).
 */
function bindSurface(
  parts: ProxyPart[],
  positions: Float32Array[],
  rest: Float32Array,
  cluster: Int32Array,
  adjStart: Uint32Array,
  adjacency: Uint32Array,
  reach: number,
) {
  const outer = positions[0]
  const outerCount = outer.length / 3
  const idx = new Float32Array(outerCount * 4)
  const wts = new Float32Array(outerCount * 4)
  const best = Array.from({ length: 4 }, () => ({ c: 0, k: 0 }))
  for (let i = 0; i < outerCount; i++) {
    const x = outer[i * 3]
    const y = outer[i * 3 + 1]
    const z = outer[i * 3 + 2]
    const own = cluster[i]
    for (const b of best) Object.assign(b, { c: own, k: 0 })
    const consider = (c: number) => {
      const d = Math.sqrt((x - rest[c * 3]) ** 2 + (y - rest[c * 3 + 1]) ** 2 + (z - rest[c * 3 + 2]) ** 2)
      // The own patch always counts, however far its centre.
      const k = Math.max((1 - Math.min(d / reach, 1)) ** 3, c === own ? 1e-4 : 0)
      if (k === 0) return
      let slot = -1
      for (let s = 0; s < 4; s++) if (k > best[s].k && (slot < 0 || best[s].k < best[slot].k)) slot = s
      if (slot >= 0) Object.assign(best[slot], { c, k })
    }
    consider(own)
    for (let q = adjStart[own]; q < adjStart[own + 1]; q++) consider(adjacency[q])
    const total = best.reduce((sum, b) => sum + b.k, 0)
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
const POLAR_ITERATIONS = 3
/** Below this speed (m per step) cloth also loses velocity to friction. */
const SLOW = 0.0015
const SLOW_KEEP = 0.85
/**
 * Share of a contact's overlap resolved per step. Resolving all of it overshoots against the
 * shape and bending pull and leaves resting contact flickering between two states.
 */
const CONTACT_RELAX = 0.6
/** Offset (m) beyond which a garment's own panels are checked against each other. */
const SELF_CONTACT_ABOVE = 0.01
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
  /** Each region's rotation (xyzw), warm start for the next polar decomposition. */
  private regionRotation: Float32Array[]
  private anchor: Float32Array
  private sleep = 0
  private awake = true
  /** Time not yet simulated (s). */
  private clock = 0
  /** Last step's activity, for debugging. */
  stats = { moving: false, speed: 0, offsetChange: 0 }
  /** Moving average of the time one call to step() takes while active (ms). */
  stepMs = 0
  private timedSteps = 0
  // Spatial hash (counting sort) over all particles.
  private cellStart = new Int32Array(TABLE + 1)
  private cellEntries: Int32Array
  private garmentOf: Int32Array
  private particleOf: Int32Array
  /** Particles that touched another garment this step (flat index g * n + i). */
  private touched: Uint8Array
  /** Flat indices of the particles that can touch something this step. */
  private candidates: Int32Array
  private boxes: Float32Array
  /** Garments bent enough last frame that their front could meet their back. */
  private deformed: boolean[]
  /** Garments at rest whose zero offsets are already uploaded. */
  private zeroed: boolean[]
  private offsets: Float32Array
  private smoothed: Float32Array

  /** Proxy structure per garment; garments of the same kind share one object. */
  readonly topologies: ProxyTopology[]
  readonly garments: number
  /** Flat index of each garment's first particle in the collision tables. */
  private base: Int32Array
  /** Hash cell size: the largest contact distance (two radii) of any garment. */
  private reach: number

  constructor(topologies: ProxyTopology[]) {
    this.topologies = topologies
    const garments = (this.garments = topologies.length)
    this.base = new Int32Array(garments + 1)
    topologies.forEach((t, g) => (this.base[g + 1] = this.base[g] + t.count))
    const total = this.base[garments]
    const largest = Math.max(...topologies.map((t) => t.count))
    this.reach = 2 * Math.max(...topologies.map((t) => t.profile.radius))
    const texture = (t: ProxyTopology, columns: number) => {
      const rows = Math.ceil(t.count / t.textureWidth)
      const tex = new THREE.DataTexture(new Float32Array(t.textureWidth * columns * rows * 4), t.textureWidth * columns, rows, THREE.RGBAFormat, THREE.FloatType)
      tex.needsUpdate = true
      return tex
    }
    this.textures = topologies.map((t) => texture(t, 1))
    this.gradients = topologies.map((t) => texture(t, 3))
    this.x = topologies.map((t) => new Float32Array(t.count * 3))
    this.prev = topologies.map((t) => new Float32Array(t.count * 3))
    this.target = topologies.map((t) => new Float32Array(t.count * 3))
    this.lastTarget = topologies.map((t) => new Float32Array(t.count * 3))
    this.lastBody = topologies.map(() => new THREE.Matrix4())
    this.regionRotation = topologies.map((t) => {
      const regionCount = t.regionStart.length - 1
      const q = new Float32Array(regionCount * 4)
      for (let r = 0; r < regionCount; r++) q[r * 4 + 3] = 1
      return q
    })
    this.anchor = new Float32Array(garments * 3).fill(NaN)
    this.cellEntries = new Int32Array(total)
    this.garmentOf = new Int32Array(total)
    this.particleOf = new Int32Array(total)
    this.touched = new Uint8Array(total)
    this.candidates = new Int32Array(total)
    this.boxes = new Float32Array(garments * 6)
    this.deformed = topologies.map(() => false)
    this.zeroed = topologies.map(() => false)
    this.offsets = new Float32Array(largest * 3)
    this.smoothed = new Float32Array(largest * 3)
    for (let g = 0; g < garments; g++) {
      for (let i = 0; i < topologies[g].count; i++) {
        this.garmentOf[this.base[g] + i] = g
        this.particleOf[this.base[g] + i] = i
      }
    }
  }

  /** True once enough steps have run slower than SLOW_STEP_MS on average. */
  get slow() {
    return this.timedSteps >= 60 && this.stepMs > SLOW_STEP_MS
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
    // Fixed 1/60 s steps from accumulated time: a 120 Hz display steps every other frame
    // instead of running the cloth at double speed.
    this.clock = Math.min(this.clock + dt, 1 / 20)
    const substeps = Math.floor(this.clock / STEP + 1e-6)
    if (substeps === 0) return this.awake
    this.clock -= substeps * STEP
    const began = performance.now()
    const v = new THREE.Vector3()
    let moving = false

    // Goals in world space; a hanger that jumps (switch teleport) resets its cloth.
    for (let g = 0; g < this.garments; g++) {
      const { count: n, rest } = this.topologies[g]
      const t = this.target[g]
      const m = bodies[g]
      const e = m.elements
      for (let j = 0; j < n * 3; j += 3) {
        const x = rest[j]
        const y = rest[j + 1]
        const z = rest[j + 2]
        t[j] = e[0] * x + e[4] * y + e[8] * z + e[12]
        t[j + 1] = e[1] * x + e[5] * y + e[9] * z + e[13]
        t[j + 2] = e[2] * x + e[6] * y + e[10] * z + e[14]
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
    if (!moving && this.sleep > 30) return (this.awake = false)

    let speed = 0
    for (let s = 0; s < substeps; s++) {
      const along = (s + 1) / substeps
      for (let g = 0; g < this.garments; g++) {
        if (follow[g]) continue
        const { count: n, goal, profile } = this.topologies[g]
        const x = this.x[g]
        const p = this.prev[g]
        const t = this.target[g]
        const last = this.lastTarget[g]
        for (let i = 0; i < n; i++) {
          const k = goal[i]
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
          const T = this.topologies[g]
          if (it === 0) this.solveShape(g, along)
          this.solveEdges(g, T.edges, T.restLength, 1)
          if (it === 0) this.solveEdges(g, T.bendEdges, T.bendLength, T.profile.bend)
        }
        // Contacts once per step, last, so the drawn cloth is free of contact at these speeds.
        if (it === ITERATIONS - 1) this.solveCollisions(follow)
      }
      for (let g = 0; g < this.garments; g++) {
        const n = this.topologies[g].count
        const x = this.x[g]
        const p = this.prev[g]
        for (let i = 0; i < n; i++) {
          // Cloth pressed against cloth: friction eats the velocity that the edge
          // constraints would otherwise keep re-injecting against the contact.
          if (this.touched[this.base[g] + i]) {
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
    const raw = this.offsets
    const smooth = this.smoothed
    let offsetChange = 0
    for (let g = 0; g < this.garments; g++) {
      // A resting garment's offsets are all zero: upload them once, then skip it.
      if (follow[g] && this.zeroed[g]) continue
      this.zeroed[g] = follow[g]
      const { count: n, adjStart, adjacency, invMass, profile } = this.topologies[g]
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
      let largest = 0
      for (let i = 0; i < n; i++) {
        const len = Math.sqrt(raw[i * 3] ** 2 + raw[i * 3 + 1] ** 2 + raw[i * 3 + 2] ** 2)
        largest = Math.max(largest, len)
        v.set(raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2]).transformDirection(inverse)
        v.multiplyScalar(Math.min(len, profile.maxOffset))
        offsetChange = Math.max(offsetChange, Math.abs(data[i * 4] - v.x), Math.abs(data[i * 4 + 1] - v.y), Math.abs(data[i * 4 + 2] - v.z))
        data[i * 4] = v.x
        data[i * 4 + 1] = v.y
        data[i * 4 + 2] = v.z
      }
      this.textures[g].needsUpdate = true
      this.writeGradients(g, data)
      this.deformed[g] = largest > SELF_CONTACT_ABOVE
    }

    // Judge rest by how much the rendered offsets still change: resting contact keeps a small
    // stored velocity that the constraints cancel every step, so `speed` never reaches zero.
    const active = moving || offsetChange > 3e-5
    this.stats = { moving, speed, offsetChange }
    this.sleep = active ? 0 : this.sleep + 1
    const ms = performance.now() - began
    this.timedSteps++
    this.stepMs += (ms - this.stepMs) / Math.min(this.timedSteps, 30)
    return (this.awake = active || this.sleep <= 30)
  }

  private solveEdges(g: number, edges: Uint32Array, restLength: Float32Array, stiffness: number) {
    const { invMass } = this.topologies[g]
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
    const { count: n, rest, adjStart, adjacency, covInverse } = this.topologies[g]
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
    const { count: n, profile } = this.topologies[g]
    const { maxInertialStep } = profile
    const inertia = profile.inertia * scale
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
   * Shape matching per region (Müller et al. 2005): find the rotation that best maps the region's
   * drape onto where its particles are now, and pull them toward that rotated drape. The
   * rotation comes from a few warm-started iterations of Müller et al. 2016.
   */
  private solveShape(g: number, along: number) {
    const { regionStart, regions, invMass, profile } = this.topologies[g]
    const x = this.x[g]
    const t = this.target[g]
    const last = this.lastTarget[g]
    const rot = this.regionRotation[g]
    for (let r = 0; r < regionStart.length - 1; r++) {
      const from = regionStart[r]
      const to = regionStart[r + 1]
      // Centroids of the drape (goal, interpolated like the integration) and of the cloth.
      let gx = 0, gy = 0, gz = 0, cx = 0, cy = 0, cz = 0
      for (let m = from; m < to; m++) {
        const j = regions[m] * 3
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
        const j = regions[m] * 3
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
      // Polar decomposition (Müller et al. 2016), warm-started from last step's rotation, so
      // a few iterations suffice. Quaternion q, rotation columns c0..c2, all inline.
      let qx = rot[r * 4], qy = rot[r * 4 + 1], qz = rot[r * 4 + 2], qw = rot[r * 4 + 3]
      let c00 = 1, c01 = 0, c02 = 0, c10 = 0, c11 = 1, c12 = 0, c20 = 0, c21 = 0, c22 = 1
      for (let k = 0; k <= POLAR_ITERATIONS; k++) {
        c00 = 1 - 2 * (qy * qy + qz * qz); c01 = 2 * (qx * qy + qw * qz); c02 = 2 * (qx * qz - qw * qy)
        c10 = 2 * (qx * qy - qw * qz); c11 = 1 - 2 * (qx * qx + qz * qz); c12 = 2 * (qy * qz + qw * qx)
        c20 = 2 * (qx * qz + qw * qy); c21 = 2 * (qy * qz - qw * qx); c22 = 1 - 2 * (qx * qx + qy * qy)
        if (k === POLAR_ITERATIONS) break
        const dot = c00 * a00 + c01 * a10 + c02 * a20 + c10 * a01 + c11 * a11 + c12 * a21 + c20 * a02 + c21 * a12 + c22 * a22
        const scale = 1 / (Math.abs(dot) + 1e-9)
        // ω = Σ c_k × a_k / |Σ c_k · a_k|
        const ox = (c01 * a20 - c02 * a10 + c11 * a21 - c12 * a11 + c21 * a22 - c22 * a12) * scale
        const oy = (c02 * a00 - c00 * a20 + c12 * a01 - c10 * a21 + c22 * a02 - c20 * a22) * scale
        const oz = (c00 * a10 - c01 * a00 + c10 * a11 - c11 * a01 + c20 * a12 - c21 * a02) * scale
        const w = Math.sqrt(ox * ox + oy * oy + oz * oz)
        if (w < 1e-7) {
          k = POLAR_ITERATIONS - 1
          continue
        }
        const sh = Math.sin(w / 2) / w
        const ax = ox * sh, ay = oy * sh, az = oz * sh, aw = Math.cos(w / 2)
        const nx = ax * qw + aw * qx + ay * qz - az * qy
        const ny = ay * qw + aw * qy + az * qx - ax * qz
        const nz = az * qw + aw * qz + ax * qy - ay * qx
        const nw = aw * qw - ax * qx - ay * qy - az * qz
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw)
        qx = nx / len; qy = ny / len; qz = nz / len; qw = nw / len
      }
      rot[r * 4] = qx
      rot[r * 4 + 1] = qy
      rot[r * 4 + 2] = qz
      rot[r * 4 + 3] = qw
      for (let m = from; m < to; m++) {
        const i = regions[m]
        if (invMass[i] === 0) continue
        const j = i * 3
        const ux = last[j] + (t[j] - last[j]) * along - gx
        const uy = last[j + 1] + (t[j + 1] - last[j + 1]) * along - gy
        const uz = last[j + 2] + (t[j + 2] - last[j + 2]) * along - gz
        x[j] += (cx + c00 * ux + c10 * uy + c20 * uz - x[j]) * profile.shape
        x[j + 1] += (cy + c01 * ux + c11 * uy + c21 * uz - x[j + 1]) * profile.shape
        x[j + 2] += (cz + c02 * ux + c12 * uy + c22 * uz - x[j + 2]) * profile.shape
      }
    }
  }

  private cellHash(ix: number, iy: number, iz: number) {
    return Math.abs((ix * 92837111) ^ (iy * 689287499) ^ (iz * 283923481)) % TABLE
  }

  private hash(x: number, y: number, z: number) {
    const size = this.reach
    return this.cellHash(Math.floor(x / size), Math.floor(y / size), Math.floor(z / size))
  }

  /**
   * Push apart particles closer than two radii: from different garments always, from the same
   * garment when they started further apart (front panel meeting the back panel).
   */
  private solveCollisions(follow: boolean[]) {
    const reach = this.reach
    // Broad phase: only particles inside the overlap of two garments' boxes can meet another
    // garment; a garment's own panels only meet when it is bent.
    const box = this.boxes
    for (let g = 0; g < this.garments; g++) {
      const n = this.topologies[g].count
      const x = this.x[g]
      box[g * 6] = box[g * 6 + 1] = box[g * 6 + 2] = Infinity
      box[g * 6 + 3] = box[g * 6 + 4] = box[g * 6 + 5] = -Infinity
      for (let j = 0; j < n * 3; j += 3) {
        for (let c = 0; c < 3; c++) {
          box[g * 6 + c] = Math.min(box[g * 6 + c], x[j + c])
          box[g * 6 + 3 + c] = Math.max(box[g * 6 + 3 + c], x[j + c])
        }
      }
    }
    const overlaps = (a: number, b: number) =>
      box[a * 6] - reach < box[b * 6 + 3] && box[b * 6] - reach < box[a * 6 + 3] &&
      box[a * 6 + 1] - reach < box[b * 6 + 4] && box[b * 6 + 1] - reach < box[a * 6 + 4] &&
      box[a * 6 + 2] - reach < box[b * 6 + 5] && box[b * 6 + 2] - reach < box[a * 6 + 5]
    let total = 0
    for (let g = 0; g < this.garments; g++) {
      // A resting (follow) garment only matters where it touches a live one.
      const others: number[] = []
      for (let h = 0; h < this.garments; h++) if (h !== g && !(follow[g] && follow[h]) && overlaps(g, h)) others.push(h)
      if (!others.length && (follow[g] || !this.deformed[g])) continue
      const n = this.topologies[g].count
      const x = this.x[g]
      for (let i = 0; i < n; i++) {
        let take = this.deformed[g] && !follow[g]
        for (let o = 0; o < others.length && !take; o++) {
          const h = others[o]
          take =
            x[i * 3] > box[h * 6] - reach && x[i * 3] < box[h * 6 + 3] + reach &&
            x[i * 3 + 1] > box[h * 6 + 1] - reach && x[i * 3 + 1] < box[h * 6 + 4] + reach &&
            x[i * 3 + 2] > box[h * 6 + 2] - reach && x[i * 3 + 2] < box[h * 6 + 5] + reach
        }
        if (take) this.candidates[total++] = this.base[g] + i
      }
    }
    if (!total) return
    const start = this.cellStart
    start.fill(0)
    for (let m = 0; m < total; m++) {
      const k = this.candidates[m]
      const x = this.x[this.garmentOf[k]]
      const i = this.particleOf[k]
      start[this.hash(x[i * 3], x[i * 3 + 1], x[i * 3 + 2])]++
    }
    for (let c = 1; c <= TABLE; c++) start[c] += start[c - 1]
    for (let m = 0; m < total; m++) {
      const k = this.candidates[m]
      const x = this.x[this.garmentOf[k]]
      const i = this.particleOf[k]
      this.cellEntries[--start[this.hash(x[i * 3], x[i * 3 + 1], x[i * 3 + 2])]] = k
    }
    for (let m = 0; m < total; m++) {
      const k = this.candidates[m]
      const ga = this.garmentOf[k]
      const ia = this.particleOf[k]
      const xa = this.x[ga]
      const ta = this.topologies[ga]
      const wa = follow[ga] ? 0 : ta.invMass[ia]
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
          const tb = this.topologies[gb]
          // Contact distance for this pair: one radius from each side.
          const contact = ta.profile.radius + tb.profile.radius
          if (gb === ga) {
            if (ib === ia || !this.deformed[ga]) continue
            const rest = ta.rest
            const rx = rest[ib * 3] - rest[ia * 3]
            const ry = rest[ib * 3 + 1] - rest[ia * 3 + 1]
            const rz = rest[ib * 3 + 2] - rest[ia * 3 + 2]
            if (rx * rx + ry * ry + rz * rz <= contact * contact) continue
          }
          const xb = this.x[gb]
          const wb = follow[gb] ? 0 : tb.invMass[ib]
          const w = wa + wb
          if (w === 0) continue
          const dx = xb[ib * 3] - xa[ia * 3]
          const dy = xb[ib * 3 + 1] - xa[ia * 3 + 1]
          const dz = xb[ib * 3 + 2] - xa[ia * 3 + 2]
          const d2 = dx * dx + dy * dy + dz * dz
          if (d2 >= contact * contact) continue
          const d = Math.sqrt(d2) || 1e-9
          const c = ((contact - d) / d / w) * CONTACT_RELAX
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
