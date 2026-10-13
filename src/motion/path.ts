// Hook-pivot paths for lifting a garment off the rail and putting it back.
// These must match docs/asset-spec.md §4.2: the Blender clips are baked along the same paths.

export type Ease = 'linear' | 'in' | 'out' | 'inOut'

export interface PathKey {
  t: number
  p: [number, number, number]
  /** Degrees around Y. */
  yaw: number
  /** Easing used to arrive at this key from the previous one. */
  ease: Ease
}

export const LIFT: PathKey[] = [
  { t: 0, p: [0, 0, 0], yaw: 0, ease: 'linear' },
  { t: 0.2, p: [0, 0.07, 0], yaw: 0, ease: 'out' },
  { t: 1.1, p: [0, 0.05, 0.6], yaw: 360, ease: 'inOut' },
  { t: 1.5, p: [0, 0.05, 0.6], yaw: 360, ease: 'linear' },
]

export const RETURN: PathKey[] = [
  { t: 0, p: [0, 0.05, 0.6], yaw: 0, ease: 'linear' },
  { t: 0.7, p: [0, 0.07, 0], yaw: 0, ease: 'inOut' },
  { t: 0.85, p: [0, 0, 0], yaw: 0, ease: 'in' },
  { t: 1.25, p: [0, 0, 0], yaw: 0, ease: 'linear' },
]

/** When the garment is in place and input can resume (cloth may still settle after). */
export const LIFT_ARRIVE = 1.1
export const RETURN_ARRIVE = 0.85

export function ease(kind: Ease, x: number) {
  const t = Math.min(1, Math.max(0, x))
  switch (kind) {
    case 'in':
      return t * t * t
    case 'out':
      return 1 - (1 - t) ** 3
    case 'inOut':
      return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
    default:
      return t
  }
}

export interface PathSample {
  p: [number, number, number]
  yaw: number
}

export function samplePath(keys: PathKey[], t: number): PathSample {
  if (t <= keys[0].t) return { p: [...keys[0].p], yaw: keys[0].yaw }
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1]
    const b = keys[i]
    if (t <= b.t) {
      const k = ease(b.ease, (t - a.t) / (b.t - a.t))
      return {
        p: [a.p[0] + (b.p[0] - a.p[0]) * k, a.p[1] + (b.p[1] - a.p[1]) * k, a.p[2] + (b.p[2] - a.p[2]) * k],
        yaw: a.yaw + (b.yaw - a.yaw) * k,
      }
    }
  }
  const last = keys[keys.length - 1]
  return { p: [...last.p], yaw: last.yaw }
}

export const pathDuration = (keys: PathKey[]) => keys[keys.length - 1].t

/** 0→1 progress of the "travel" segment, used to drive camera and neighbours in sync. */
export function travel(keys: PathKey[], t: number) {
  const start = keys[0].p
  const end = keys[keys.length - 1].p
  const now = samplePath(keys, t).p
  const total = Math.abs(end[2] - start[2])
  return total > 0 ? Math.abs(now[2] - start[2]) / total : t >= pathDuration(keys) ? 1 : 0
}
