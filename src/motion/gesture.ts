// Pure gesture helpers for the rail drag. No DOM here so it can be unit tested.

export type Axis = 'none' | 'x' | 'y'

/** Decide which way a pointer drag is going once it has moved past the slop. */
export function classifyAxis(dx: number, dy: number, slop = 8): Axis {
  if (Math.hypot(dx, dy) < slop) return 'none'
  return Math.abs(dx) >= Math.abs(dy) * 0.8 ? 'x' : 'y'
}

/** iOS-style resistance past the ends: approaches `limit` items of overscroll asymptotically. */
export function rubberBand(pos: number, min: number, max: number, limit = 0.45) {
  const resist = (over: number) => limit * (1 - 1 / ((over * 0.9) / limit + 1))
  if (pos < min) return min - resist(min - pos)
  if (pos > max) return max + resist(pos - max)
  return pos
}

/**
 * Where the rail should settle after a release. A fling projects forward a little,
 * but one release never moves more than one item from where the drag started.
 */
export function releaseTarget(start: number, pos: number, velocity: number, count: number) {
  const projected = pos + velocity * 0.12
  let target = Math.round(projected)
  target = Math.max(start - 1, Math.min(start + 1, target))
  return Math.max(0, Math.min(count - 1, target))
}

/** Velocity from the last ~100 ms of samples, in units per second. */
export class VelocityTracker {
  private samples: Array<{ t: number; x: number }> = []

  reset() {
    this.samples = []
  }

  add(t: number, x: number) {
    this.samples.push({ t, x })
    while (this.samples.length > 2 && t - this.samples[0].t > 100) this.samples.shift()
  }

  velocity(now: number) {
    const s = this.samples
    if (s.length < 2) return 0
    const last = s[s.length - 1]
    // A pause before release means no fling.
    if (now - last.t > 80) return 0
    const first = s[0]
    const dt = (last.t - first.t) / 1000
    return dt > 0 ? (last.x - first.x) / dt : 0
  }
}
