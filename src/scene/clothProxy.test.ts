import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { buildProxy, ClothSim, JERSEY_TEE, type ProxyPart } from './clothProxy'

// A boxy "garment": front and back panels (a flattened tube) hanging below a bar, plus an inner
// shell 2 mm inside the outer one, like the Blender export.
function tube(inset: number) {
  const width = 0.6
  const depth = 0.12 - inset * 2
  const geometry = new THREE.CylinderGeometry(1, 1, 0.65, 48, 24, true)
  geometry.translate(0, -0.1 - 0.325, 0)
  const pos = geometry.getAttribute('position')
  for (let i = 0; i < pos.count; i++) pos.setXYZ(i, pos.getX(i) * (width / 2 - inset), pos.getY(i), pos.getZ(i) * (depth / 2))
  return geometry
}

function setup(garments = 1) {
  const outer: ProxyPart = { geometry: tube(0), toPivot: new THREE.Matrix4() }
  const inner: ProxyPart = { geometry: tube(0.002), toPivot: new THREE.Matrix4() }
  const bar = new THREE.CylinderGeometry(0.01, 0.01, 0.6, 8, 12).rotateZ(Math.PI / 2).translate(0, -0.11, 0)
  const topology = buildProxy([outer, inner], { geometry: bar, toPivot: new THREE.Matrix4() }, { ...JERSEY_TEE })
  return { topology, outer, inner, sim: new ClothSim(topology, garments) }
}

function maxOffset(sim: ClothSim, g = 0) {
  const data = sim.textures[g].image.data as Float32Array
  let max = 0
  for (let i = 0; i < sim.topology.count; i++) max = Math.max(max, Math.hypot(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]))
  return max
}

describe('cloth proxy', () => {
  it('pins the cloth resting on the hanger and leaves the rest free', () => {
    const { topology } = setup()
    const { rest, invMass, goal } = topology
    let pinned = 0
    for (let i = 0; i < topology.count; i++) {
      if (invMass[i] === 0) {
        pinned++
        expect(rest[i * 3 + 1]).toBeGreaterThan(-0.16)
      }
    }
    expect(pinned).toBeGreaterThan(0)
    expect(pinned).toBeLessThan(topology.count * 0.25)
    // The pull back to the drape weakens toward the free end.
    const lowest = [...Array(topology.count).keys()].reduce((a, b) => (rest[b * 3 + 1] < rest[a * 3 + 1] ? b : a))
    expect(goal[lowest]).toBeCloseTo(JERSEY_TEE.goalHem, 3)
  })

  it('binds the inner shell exactly like the nearest outer vertex', () => {
    const { outer, inner } = setup()
    const oi = outer.geometry.getAttribute('aProxyIdx')
    const ow = outer.geometry.getAttribute('aProxyW')
    const ii = inner.geometry.getAttribute('aProxyIdx')
    const iw = inner.geometry.getAttribute('aProxyW')
    // Same tessellation, so vertex k of the inner shell sits right under vertex k of the outer.
    for (let k = 0; k < ii.count; k += 37) {
      for (let c = 0; c < 4; c++) {
        expect(ii.getComponent(k, c)).toBe(oi.getComponent(k, c))
        expect(iw.getComponent(k, c)).toBe(ow.getComponent(k, c))
      }
    }
  })

  it('carries a garment moving at constant speed as one piece', () => {
    const { sim } = setup()
    const body = new THREE.Matrix4()
    let x = 0
    // Ramp up gently, then cruise at 1 m/s.
    for (let f = 0; f < 240; f++) {
      x += (Math.min(1, f / 60) * 1) / 60
      sim.step(1 / 60, [body.makeTranslation(x, 0, 0)], [false])
    }
    expect(maxOffset(sim)).toBeLessThan(0.01)
  })

  it('swings when the hanger stops, then settles and sleeps', () => {
    const { sim } = setup()
    const body = new THREE.Matrix4()
    let x = 0
    for (let f = 0; f < 20; f++) {
      x += 1.5 / 60
      sim.step(1 / 60, [body.makeTranslation(x, 0, 0)], [false])
    }
    let peak = 0
    let active = true
    let frames = 0
    for (; frames < 600 && active; frames++) {
      active = sim.step(1 / 60, [body.makeTranslation(x, 0, 0)], [false])
      peak = Math.max(peak, maxOffset(sim))
    }
    expect(peak).toBeGreaterThan(0.005)
    expect(peak).toBeLessThanOrEqual(JERSEY_TEE.maxOffset + 1e-6)
    expect(active).toBe(false)
    expect(frames / 60).toBeLessThan(3)
    expect(maxOffset(sim)).toBeLessThan(0.002)
  })

  it('feels none of a choreographed move when its inertia scale is 0', () => {
    const { sim } = setup()
    const body = new THREE.Matrix4()
    for (let f = 0; f < 60; f++) sim.step(1 / 60, [body.makeRotationY((f / 60) * Math.PI)], [false], [0])
    expect(maxOffset(sim)).toBeLessThan(1e-4)
  })

  it('keeps two garments pushed together apart', () => {
    const { sim, topology } = setup(2)
    const a = new THREE.Matrix4()
    const b = new THREE.Matrix4()
    // Slide garment 1 against garment 0 from behind until their drapes overlap by 3 cm, like
    // garments packed on the rail.
    for (let f = 0; f <= 60; f++) sim.step(1 / 60, [a, b.makeTranslation(0, 0, -0.3 + (0.21 * f) / 60)], [false, false])
    for (let f = 0; f < 120; f++) sim.step(1 / 60, [a, b], [false, false])
    const x = (sim as unknown as { x: Float32Array[] }).x
    const reach = 2 * topology.profile.radius
    let closest = Infinity
    // The tops hang from overlapping hangers and cannot part; judge the free lower half.
    const free = (i: number) => topology.rest[i * 3 + 1] < -0.4
    for (let i = 0; i < topology.count; i++) {
      if (!free(i)) continue
      for (let j = 0; j < topology.count; j++) {
        if (!free(j)) continue
        const d = Math.hypot(x[0][i * 3] - x[1][j * 3], x[0][i * 3 + 1] - x[1][j * 3 + 1], x[0][i * 3 + 2] - x[1][j * 3 + 2])
        closest = Math.min(closest, d)
      }
    }
    expect(closest).toBeGreaterThan(reach / 2)
  })
})
