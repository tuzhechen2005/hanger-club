// Hook-pivot paths for lifting a garment off the rail and putting it back.
// These must match docs/asset-spec.md §4.2 and pose() in tools/blender/bake_clips.py: the cloth
// morphs are baked along exactly these paths, including smoothstep easing on every segment.

export type Ease = 'linear' | 'in' | 'out' | 'inOut' | 'smooth'

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
  { t: 0.2, p: [0, 0.07, 0], yaw: 0, ease: 'smooth' },
  { t: 1.1, p: [0, 0.05, 0.6], yaw: 360, ease: 'smooth' },
  { t: 1.5, p: [0, 0.05, 0.6], yaw: 360, ease: 'linear' },
]

export const RETURN: PathKey[] = [
  { t: 0, p: [0, 0.05, 0.6], yaw: 0, ease: 'linear' },
  { t: 0.7, p: [0, 0.07, 0], yaw: 0, ease: 'smooth' },
  { t: 0.85, p: [0, 0, 0], yaw: 0, ease: 'smooth' },
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
    case 'smooth':
      return t * t * (3 - 2 * t)
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

// ---- baked cloth clips ------------------------------------------------------
// tee_anim.glb carries 66 morph targets (Sample_01..66), one per 24 fps frame:
// lift frames 1..36 → targets 0..35, return frames 1..30 → targets 36..65.
// Lift frame 0 is the base mesh; return frame 0 is the last lift sample (target 35).

export type ClipName = 'lift' | 'return' | 'hold'
export const CLIP_FPS = 24
export const LIFT_FRAMES = 36
export const RETURN_FRAMES = 30
export const LIFT_END_TARGET = LIFT_FRAMES - 1

export interface MorphBlend {
  /** Morph target index for the lower frame, or -1 for the base mesh. */
  a: number
  /** Morph target index for the upper frame, or -1 for the base mesh. */
  b: number
  /** Weight of `b`; `a` gets 1 - w. */
  w: number
}

export function clipMorph(name: ClipName, t: number): MorphBlend {
  if (name === 'hold') return { a: LIFT_END_TARGET, b: LIFT_END_TARGET, w: 0 }
  const frames = name === 'lift' ? LIFT_FRAMES : RETURN_FRAMES
  const target = (f: number) => (name === 'lift' ? f - 1 : LIFT_END_TARGET + f)
  const u = Math.min(Math.max(t * CLIP_FPS, 0), frames)
  const f0 = Math.min(Math.floor(u), frames - 1)
  return { a: target(f0), b: target(f0 + 1), w: u - f0 }
}

export const clipDuration = (name: ClipName) =>
  name === 'lift' ? LIFT_FRAMES / CLIP_FPS : name === 'return' ? RETURN_FRAMES / CLIP_FPS : Infinity
