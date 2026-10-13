import { describe, expect, it } from 'vitest'
import { classifyAxis, releaseTarget, rubberBand, VelocityTracker } from './gesture'
import { LIFT, RETURN, samplePath, travel } from './path'
import { makeSpring, stepPendulum, stepSpring } from './spring'

describe('spring', () => {
  it('settles on target', () => {
    const s = makeSpring(0, 2.2, 0.9)
    s.target = 3
    for (let i = 0; i < 240; i++) stepSpring(s, 1 / 60)
    expect(s.x).toBeCloseTo(3, 3)
  })

  it('moves the same at 60 Hz and 120 Hz', () => {
    const a = makeSpring(0, 2, 0.7)
    const b = makeSpring(0, 2, 0.7)
    a.target = b.target = 1
    for (let i = 0; i < 30; i++) stepSpring(a, 1 / 60)
    for (let i = 0; i < 60; i++) stepSpring(b, 1 / 120)
    expect(a.x).toBeCloseTo(b.x, 3)
  })

  it('does not explode on a long frame', () => {
    const s = makeSpring(0, 3, 0.5)
    s.target = 1
    stepSpring(s, 5)
    expect(Math.abs(s.x)).toBeLessThan(2)
  })

  it('pendulum swings opposite to pivot acceleration, then damps out', () => {
    const p = { angle: 0, velocity: 0 }
    stepPendulum(p, 4, 0.45, 2, 1 / 20)
    expect(p.angle).toBeLessThan(0)
    for (let i = 0; i < 600; i++) stepPendulum(p, 0, 0.45, 2, 1 / 60)
    expect(Math.abs(p.angle)).toBeLessThan(1e-3)
  })
})

describe('gesture', () => {
  it('locks to the dominant axis only past the slop', () => {
    expect(classifyAxis(3, 2)).toBe('none')
    expect(classifyAxis(20, 4)).toBe('x')
    expect(classifyAxis(3, 20)).toBe('y')
  })

  it('a fling advances at most one item', () => {
    expect(releaseTarget(2, 2.3, 40, 6)).toBe(3)
    expect(releaseTarget(2, 1.6, -40, 6)).toBe(1)
  })

  it('a slow short drag snaps back', () => {
    expect(releaseTarget(2, 2.3, 0, 6)).toBe(2)
  })

  it('a slow long drag lands on the nearest item', () => {
    expect(releaseTarget(2, 2.7, 0, 6)).toBe(3)
  })

  it('clamps to the ends', () => {
    expect(releaseTarget(5, 5.4, 30, 6)).toBe(5)
    expect(releaseTarget(0, -0.3, -30, 6)).toBe(0)
  })

  it('rubber-bands past the ends without exceeding the limit', () => {
    expect(rubberBand(2, 0, 5)).toBe(2)
    const over = rubberBand(8, 0, 5)
    expect(over).toBeGreaterThan(5)
    expect(over).toBeLessThan(5.45)
    expect(rubberBand(-1, 0, 5)).toBeLessThan(0)
  })

  it('reports zero velocity after a pause', () => {
    const v = new VelocityTracker()
    v.add(0, 0)
    v.add(50, 1)
    expect(v.velocity(55)).toBeCloseTo(20, 5)
    expect(v.velocity(300)).toBe(0)
  })
})

describe('paths', () => {
  it('lift starts on the rail and ends in the inspect pose', () => {
    expect(samplePath(LIFT, 0).p).toEqual([0, 0, 0])
    expect(samplePath(LIFT, 9).p).toEqual([0, 0.05, 0.6])
    expect(samplePath(LIFT, 1.1).yaw).toBe(360)
  })

  it('return mirrors lift', () => {
    expect(samplePath(RETURN, 0).p).toEqual(samplePath(LIFT, 1.5).p)
    expect(samplePath(RETURN, 1.25).p).toEqual([0, 0, 0])
  })

  it('travel progress goes 0 → 1', () => {
    expect(travel(LIFT, 0)).toBe(0)
    expect(travel(LIFT, 1.5)).toBe(1)
    expect(travel(RETURN, 0)).toBe(0)
    expect(travel(RETURN, 1.25)).toBe(1)
  })
})
