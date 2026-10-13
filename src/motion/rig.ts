// The rail's motion controller. Plain mutable state stepped once per frame by the scene;
// React only hears about discrete changes (current index, mode) through the UI store.

import { products } from '../data/products'
import { useUI, type Mode } from '../state/store'
import { classifyAxis, releaseTarget, rubberBand, VelocityTracker, type Axis } from './gesture'
import {
  clipDuration,
  clipMorph,
  ease,
  LIFT,
  LIFT_ARRIVE,
  RETURN,
  RETURN_ARRIVE,
  samplePath,
  travel,
  type ClipName,
  type MorphBlend,
  type PathKey,
} from './path'
import { atRest, makeSpring, MAX_FRAME, settle, stepPendulum, stepSpring, tune, type Pendulum } from './spring'

const DEG = Math.PI / 180
const COUNT = products.length

/** Rail layout: the centre piece faces front, neighbours turn side-on and pack together. */
export const LAYOUT = { near: 0.58, far: 0.13, sideYaw: 82 * DEG, recess: 0.035 }
const INSPECT: [number, number, number] = [0, 0.05, 0.6]
const SWITCH_OUT = 0.45
const SWITCH_IN_START = 0.15
const SWITCH_END = 0.8
const PENDULUM_LENGTH = 0.42
/**
 * Hanger swing. A loaded hanger is heavily damped (cloth drag, hook friction): damping ≈ 0.85
 * of critical, and the hook's acceleration is capped so a hard flick tilts it ~10–15°, not 30°+.
 */
const SWING_DAMPING = 8
const SWING_MAX_ACCEL = 5
/** Share of rail motion (sliding, turning side-on) the cloth feels as inertia. */
const RAIL_INERTIA = 0.3

export interface Pose {
  x: number
  y: number
  z: number
  /** Turn of the whole hanger incl. hook (lift spin, inspect rotation). */
  spin: number
  /** Turn of hanger body + garment only, hook stays on the rail (side-on neighbours). */
  rackYaw: number
  /** Rigid swing of the whole hanger about the hook; the cloth's own lag comes from clothProxy. */
  swingZ: number
  swingX: number
}

interface Track {
  lateral: Pendulum
  depth: Pendulum
  px: number
  pz: number
  vx: number
  vz: number
  fresh: boolean
}

const smoothstep = (x: number) => {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

export function rackSlot(d: number) {
  const a = Math.abs(d)
  const s = Math.sign(d)
  const x = s * (a <= 1 ? LAYOUT.near * a : LAYOUT.near + (a - 1) * LAYOUT.far)
  const turn = smoothstep(a)
  return { x, z: -LAYOUT.recess * Math.min(a, 1), yaw: -s * LAYOUT.sideYaw * turn }
}

interface Drag {
  id: number
  x0: number
  y0: number
  axis: Axis
  start: number
  pos0: number
  yaw0: number
}

class Rig {
  readonly count = COUNT
  readonly pos = makeSpring(0, 1.7, 0.9)
  readonly yaw = makeSpring(0, 1.6, 0.8)
  mode: Mode = 'browse'
  active = 0
  t = 0
  blend = 0
  reduced = false
  aspect = 1
  pxPerItem = 200
  pxPerRadian = 120
  poses: Pose[] = products.map(() => ({ x: 0, y: 0, z: 0, spin: 0, rackYaw: 0, swingZ: 0, swingX: 0 }))
  private tracks: Track[] = products.map(() => ({
    lateral: { angle: 0, velocity: 0 },
    depth: { angle: 0, velocity: 0 },
    px: 0, pz: 0, vx: 0, vz: 0, fresh: true,
  }))
  private drag: Drag | null = null
  private tracker = new VelocityTracker()
  private returnSpin = 0
  private switching: { from: number; to: number; dir: number; fromSpin: number } | null = null
  private settledFrames = 0
  /** Baked cloth clip per garment; null = base mesh. */
  private clips: Array<{ name: ClipName; t: number } | null> = products.map(() => null)
  /** Set by the scene once tee_anim.glb is in: lift and return then play the baked cloth clips. */
  bakedClips = false

  /** Set by the scene: request a frame (render-on-demand). */
  invalidate: () => void = () => {}
  /** Set by the scene: which garment is under a client point. */
  pick: (x: number, y: number) => number | null = () => null

  /** Morph blend for garment i, or null when it should show the base mesh. */
  morph(i: number): MorphBlend | null {
    const clip = this.clips[i]
    return clip ? clipMorph(clip.name, clip.t) : null
  }

  private startClip(i: number, name: ClipName) {
    this.clips[i] = { name, t: 0 }
    if (name !== 'hold' && this.bakedClips) {
      // The bake already contains the swing; start from rest so the two don't add up.
      const track = this.tracks[i]
      track.lateral.angle = track.lateral.velocity = 0
      track.depth.angle = track.depth.velocity = 0
    }
  }

  /** True for rail garments pushed out of view while another piece is in the close-up. */
  offstage(i: number) {
    if (this.blend < 0.98) return false
    return i !== this.active && !(this.switching && i === this.switching.from)
  }

  /** True while garment i plays a baked clip (the bake contains the swing, so no pendulum). */
  playing(i: number) {
    const clip = this.clips[i]
    return this.bakedClips && !!clip && clip.name !== 'hold'
  }

  /**
   * How much of garment i's motion its cloth should feel as inertia. Lifting, spinning and
   * switching are physical moves of the hanger; on the rail, garments also turn side-on as
   * pure layout, so they get only part of it.
   */
  inertia(i: number) {
    return i === this.active && this.mode !== 'browse' ? 1 : RAIL_INERTIA
  }

  get current() {
    return clamp(Math.round(this.pos.target), 0, COUNT - 1)
  }

  setReducedMotion(reduced: boolean) {
    this.reduced = reduced
    tune(this.pos, reduced ? 3 : 1.7, reduced ? 1 : 0.9)
    tune(this.yaw, reduced ? 3 : 1.6, reduced ? 1 : 0.8)
  }

  private setMode(mode: Mode) {
    this.mode = mode
    this.t = 0
    useUI.setState({ mode })
    this.kick()
  }

  private syncIndex() {
    const index = this.mode === 'browse' ? clamp(Math.round(this.pos.x), 0, COUNT - 1) : this.active
    if (useUI.getState().index !== index) useUI.setState({ index })
  }

  kick() {
    this.settledFrames = 0
    this.invalidate()
  }

  // ---- commands -------------------------------------------------------------

  go(delta: number) {
    if (this.mode === 'browse') this.select(this.current + delta)
    else if (this.mode === 'inspect') this.switchBy(delta)
  }

  select(i: number) {
    if (this.mode !== 'browse') return
    this.pos.target = clamp(i, 0, COUNT - 1)
    this.kick()
  }

  lift() {
    if (this.mode !== 'browse' || this.drag?.axis === 'x') return
    this.active = this.current
    this.pos.target = this.active
    settle(this.pos)
    settle(this.yaw)
    this.yaw.x = this.yaw.target = 0
    useUI.setState({ index: this.active, size: 'M' })
    this.startClip(this.active, 'lift')
    this.setMode('lifting')
  }

  close() {
    if (this.mode !== 'inspect') return
    // Unwind to the nearest whole turn so the garment goes back facing front.
    const turn = 2 * Math.PI
    this.returnSpin = this.yaw.x - Math.round(this.yaw.x / turn) * turn
    this.startClip(this.active, 'return')
    this.setMode('returning')
  }

  switchBy(delta: number) {
    if (this.mode !== 'inspect') return
    const to = this.active + Math.sign(delta)
    if (to < 0 || to >= COUNT) return
    this.switching = { from: this.active, to, dir: Math.sign(delta), fromSpin: this.yaw.x }
    // Both keep the hung close-up shape (end of lift) while they fly.
    this.startClip(this.active, 'hold')
    this.startClip(to, 'hold')
    this.active = to
    this.pos.x = this.pos.target = to
    this.pos.v = 0
    this.yaw.x = this.yaw.target = 0
    this.yaw.v = 0
    useUI.setState({ index: to, size: 'M' })
    this.setMode('switching')
  }

  // ---- pointer input (client px, ms) ---------------------------------------

  pointerDown(id: number, x: number, y: number) {
    if (this.drag || (this.mode !== 'browse' && this.mode !== 'inspect')) return false
    this.drag = { id, x0: x, y0: y, axis: 'none', start: this.current, pos0: this.pos.x, yaw0: this.yaw.x }
    this.tracker.reset()
    return true
  }

  /** Returns true once the gesture is claimed horizontally (caller should capture the pointer). */
  pointerMove(id: number, x: number, y: number, t: number) {
    const d = this.drag
    if (!d || d.id !== id) return false
    const dx = x - d.x0
    const dy = y - d.y0
    if (d.axis === 'none') {
      d.axis = classifyAxis(dx, dy)
      if (d.axis === 'none') return false
    }
    if (d.axis === 'x') {
      if (this.mode === 'browse') {
        this.pos.x = rubberBand(d.pos0 - dx / this.pxPerItem, 0, COUNT - 1)
        this.pos.v = 0
        this.tracker.add(t, this.pos.x)
        this.syncIndex()
      } else if (this.mode === 'inspect') {
        this.yaw.x = this.yaw.target = d.yaw0 + dx / this.pxPerRadian
        this.yaw.v = 0
        this.tracker.add(t, this.yaw.x)
      }
      this.kick()
      return true
    }
    // Vertical: pulling down in the close-up puts the garment back.
    if (this.mode === 'inspect' && dy > 90) {
      this.drag = null
      this.close()
    }
    return false
  }

  pointerUp(id: number, x: number, y: number, t: number) {
    const d = this.drag
    if (!d || d.id !== id) return
    this.drag = null
    if (d.axis === 'none') {
      this.tap(x, y)
      return
    }
    if (d.axis !== 'x') return
    const v = this.tracker.velocity(t)
    if (this.mode === 'browse') {
      this.pos.target = releaseTarget(d.start, this.pos.x, v, COUNT)
      this.pos.v = clamp(v, -12, 12)
    } else if (this.mode === 'inspect') {
      // Keep a little spin, then come to rest showing the front or the back.
      this.yaw.target = Math.round((this.yaw.x + v * 0.22) / Math.PI) * Math.PI
      this.yaw.v = clamp(v, -14, 14)
    }
    this.kick()
  }

  /** Pointer cancelled, capture lost or window blurred: settle without flinging or tapping. */
  pointerCancel() {
    const d = this.drag
    if (!d) return
    this.drag = null
    if (d.axis === 'x' && this.mode === 'browse') this.pos.target = releaseTarget(d.start, this.pos.x, 0, COUNT)
    if (d.axis === 'x' && this.mode === 'inspect') this.yaw.target = Math.round(this.yaw.x / Math.PI) * Math.PI
    this.kick()
  }

  private tap(x: number, y: number) {
    if (this.mode !== 'browse') return
    const i = this.pick(x, y)
    if (i === null) return
    if (i === this.current && Math.abs(this.pos.x - this.pos.target) < 0.3) this.lift()
    else this.select(i)
  }

  // ---- simulation ------------------------------------------------------------

  private liftKeys(): PathKey[] {
    return this.reduced ? LIFT.map((k) => ({ ...k, yaw: 0 })) : LIFT
  }

  /** Advance everything by dt seconds. Returns true while anything is still moving. */
  step(rawDt: number) {
    const dt = Math.min(rawDt, MAX_FRAME)
    if (dt <= 0) return true
    this.t += dt

    if (this.mode === 'browse' && !this.drag) stepSpring(this.pos, dt)
    if (this.mode === 'inspect' && !(this.drag && this.drag.axis === 'x')) stepSpring(this.yaw, dt)

    switch (this.mode) {
      case 'lifting':
        this.blend = travel(this.liftKeys(), this.t)
        if (this.t >= LIFT_ARRIVE) this.setMode('inspect')
        break
      case 'returning':
        this.blend = 1 - travel(RETURN, this.t)
        if (this.t >= RETURN_ARRIVE) {
          this.blend = 0
          this.setMode('browse')
        }
        break
      case 'switching':
        this.blend = 1
        if (this.t >= SWITCH_END) {
          if (this.switching) this.clips[this.switching.from] = null
          this.switching = null
          this.setMode('inspect')
        }
        break
      case 'inspect':
        this.blend = 1
        break
      default:
        this.blend = 0
    }
    this.syncIndex()

    let clipsPlaying = false
    this.clips.forEach((clip, i) => {
      if (!clip || clip.name === 'hold') return
      clip.t += dt
      if (clip.t >= clipDuration(clip.name)) this.clips[i] = clip.name === 'lift' ? { name: 'hold', t: 0 } : null
      clipsPlaying = true
    })

    let moving = clipsPlaying || (this.mode !== 'browse' && this.mode !== 'inspect')
    moving ||= !!this.drag || !atRest(this.pos) || !atRest(this.yaw)
    for (let i = 0; i < COUNT; i++) moving = this.updatePose(i, dt) || moving
    // Keep rendering a few frames after everything rests so the last pose is drawn.
    if (moving) this.settledFrames = 0
    else this.settledFrames++
    return this.settledFrames < 3
  }

  private explode(d: number) {
    return Math.sign(d) * (1.2 + 1.5 * this.aspect) * this.blend
  }

  private updatePose(i: number, dt: number) {
    const pose = this.poses[i]
    const track = this.tracks[i]
    const d = i - this.pos.x
    const slot = rackSlot(d)
    let x = slot.x + (i === this.active ? 0 : this.explode(d))
    let y = 0
    let z = slot.z
    let spin = 0
    let rackYaw = slot.yaw

    const lifted = i === this.active && this.mode !== 'browse'
    if (lifted && this.mode === 'lifting') {
      const s = samplePath(this.liftKeys(), this.t)
      ;[x, y, z] = s.p
      spin = s.yaw * DEG
      rackYaw = 0
    } else if (lifted && this.mode === 'returning') {
      const s = samplePath(RETURN, this.t)
      ;[x, y, z] = s.p
      spin = this.returnSpin * (1 - ease('inOut', this.t / 0.7))
      rackYaw = 0
    } else if (lifted && this.mode === 'inspect') {
      ;[x, y, z] = INSPECT
      spin = this.yaw.x
      rackYaw = 0
    }

    const sw = this.switching
    if (sw && i === sw.from && this.t < SWITCH_OUT) {
      const k = ease('in', this.t / SWITCH_OUT)
      ;[x, y, z] = [INSPECT[0] - sw.dir * 1.8 * k, INSPECT[1], INSPECT[2]]
      spin = sw.fromSpin - sw.dir * 1.3 * k
      rackYaw = 0
    } else if (sw && i === sw.to) {
      const k = ease('out', (this.t - SWITCH_IN_START) / (SWITCH_END - SWITCH_IN_START))
      ;[x, y, z] = [INSPECT[0] + sw.dir * 1.8 * (1 - k), INSPECT[1], INSPECT[2]]
      spin = sw.dir * 1.9 * (1 - k)
      rackYaw = 0
    }

    // Pendulum swing driven by how the hook accelerates.
    let ax = 0
    let az = 0
    const jumped = Math.abs(x - track.px) > 0.5 || Math.abs(z - track.pz) > 0.5
    if (track.fresh || jumped) {
      track.vx = track.vz = 0
      track.fresh = false
    } else {
      const vx = (x - track.px) / dt
      const vz = (z - track.pz) / dt
      ax = clamp((vx - track.vx) / dt, -SWING_MAX_ACCEL, SWING_MAX_ACCEL)
      az = clamp((vz - track.vz) / dt, -SWING_MAX_ACCEL, SWING_MAX_ACCEL)
      track.vx = vx
      track.vz = vz
    }
    track.px = x
    track.pz = z

    if (this.reduced || this.playing(i)) {
      track.lateral.angle = track.lateral.velocity = 0
      track.depth.angle = track.depth.velocity = 0
    } else {
      stepPendulum(track.lateral, ax, PENDULUM_LENGTH, SWING_DAMPING, dt)
      stepPendulum(track.depth, az, PENDULUM_LENGTH, SWING_DAMPING, dt)
    }

    pose.x = x
    pose.y = y
    pose.z = z
    pose.spin = spin
    pose.rackYaw = rackYaw
    pose.swingZ = track.lateral.angle
    pose.swingX = -track.depth.angle

    const p = track.lateral
    const q = track.depth
    const swinging =
      Math.abs(p.angle) > 5e-4 || Math.abs(p.velocity) > 5e-3 ||
      Math.abs(q.angle) > 5e-4 || Math.abs(q.velocity) > 5e-3
    if (!swinging) {
      // Snap the last micro-swing to rest so the hanger (and the cloth riding on it) can sleep.
      p.angle = p.velocity = q.angle = q.velocity = 0
    }
    return swinging
  }
}

export const rig = new Rig()
