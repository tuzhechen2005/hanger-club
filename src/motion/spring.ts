// Damped springs integrated in fixed substeps, so motion is identical at 60/120 Hz
// and a long frame cannot explode the simulation.

export interface Spring {
  x: number
  v: number
  target: number
  k: number
  c: number
}

const STEP = 1 / 240
export const MAX_FRAME = 1 / 20

/** Spring from natural frequency (Hz) and damping ratio (1 = critical). */
export function makeSpring(x: number, frequency: number, damping: number): Spring {
  const k = (2 * Math.PI * frequency) ** 2
  return { x, v: 0, target: x, k, c: 2 * damping * Math.sqrt(k) }
}

export function tune(s: Spring, frequency: number, damping: number) {
  s.k = (2 * Math.PI * frequency) ** 2
  s.c = 2 * damping * Math.sqrt(s.k)
}

export function stepSpring(s: Spring, dt: number) {
  const frame = Math.min(dt, MAX_FRAME)
  const n = Math.max(1, Math.ceil(frame / STEP))
  const h = frame / n
  for (let i = 0; i < n; i++) {
    const a = -s.k * (s.x - s.target) - s.c * s.v
    s.v += a * h
    s.x += s.v * h
  }
}

export function atRest(s: Spring, eps = 1e-4) {
  return Math.abs(s.x - s.target) < eps && Math.abs(s.v) < eps * 10
}

export function settle(s: Spring) {
  s.x = s.target
  s.v = 0
}

/**
 * Pendulum hanging from a pivot that accelerates sideways (m/s²).
 * angle in radians; positive = bottom swings toward +x.
 */
export interface Pendulum {
  angle: number
  velocity: number
}

export function stepPendulum(p: Pendulum, pivotAccel: number, length: number, damping: number, dt: number) {
  const frame = Math.min(dt, MAX_FRAME)
  const n = Math.max(1, Math.ceil(frame / STEP))
  const h = frame / n
  for (let i = 0; i < n; i++) {
    const a = (-9.81 * Math.sin(p.angle) - pivotAccel * Math.cos(p.angle)) / length - damping * p.velocity
    p.velocity += a * h
    p.angle += p.velocity * h
  }
}
