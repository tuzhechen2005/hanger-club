// The rail's motion controller. Plain mutable state stepped once per frame by the scene;
// React only hears about discrete changes (current index, mode) through the UI store.

import { products } from '../data/products'
import { useUI, type Mode } from '../state/store'
import { classifyAxis, releaseTarget, rubberBand, VelocityTracker, type Axis } from './gesture'
import { ease, LIFT, LIFT_ARRIVE, RETURN, RETURN_ARRIVE, samplePath, travel, type PathKey } from './path'
import { atRest, makeSpring, MAX_FRAME, settle, stepPendulum, stepSpring, tune, type Pendulum } from './spring'

const DEG = Math.PI / 180
const COUNT = products.length

/** Rail layout: the centre piece faces front, neighbours turn side-on and pack together. */
export const LAYOUT = { near: 0.56, far: 0.09, sideYaw: 82 * DEG, recess: 0.035 }
const INSPECT: [number, number, number] = [0, 0.05, 0.6]
const SWITCH_OUT = 0.45
const SWITCH_IN_START = 0.15
const SWITCH_END = 0.8
const PENDULUM_LENGTH = 0.42

export interface Pose {
  x: number
  y: number
  z: number
  /** Turn of the whole hanger incl. hook (lift spin, inspect rotation). */
  spin: number
  /** Turn of hanger body + garment only, hook stays on the rail (side-on neighbours). */
  rackYaw: number
  swingZ: number
  swingX: number
  /** Hem lag in garment-local space, metres at the hem. */
  bendX: number
  bendZ: number
  /** Radial spread of the hem from spinning. */
  flare: number
  /** Hem twist lagging behind the spin, radians at the hem. */
  twist: number
}

interface Track {
  lateral: Pendulum
  depth: Pendulum
  px: number
  pz: number
  vx: number
  vz: number
  pspin: number
  spinVel: number
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
  poses: Pose[] = products.map(() => ({ x: 0, y: 0, z: 0, spin: 0, rackYaw: 0, swingZ: 0, swingX: 0, bendX: 0, bendZ: 0, flare: 0, twist: 0 }))
  private tracks: Track[] = products.map(() => ({
    lateral: { angle: 0, velocity: 0 },
    depth: { angle: 0, velocity: 0 },
    px: 0, pz: 0, vx: 0, vz: 0, pspin: 0, spinVel: 0, fresh: true,
  }))
  private drag: Drag | null = null
  private tracker = new VelocityTracker()
  private returnSpin = 0
  private switching: { from: number; to: number; dir: number; fromSpin: number } | null = null
  private settledFrames = 0

  /** Set by the scene: request a frame (render-on-demand). */
  invalidate: () => void = () => {}
  /** Set by the scene: which garment is under a client point. */
  pick: (x: number, y: number) => number | null = () => null

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
    this.setMode('lifting')
  }

  close() {
    if (this.mode !== 'inspect') return
    // Unwind to the nearest whole turn so the garment goes back facing front.
    const turn = 2 * Math.PI
    this.returnSpin = this.yaw.x - Math.round(this.yaw.x / turn) * turn
    this.setMode('returning')
  }

  switchBy(delta: number) {
    if (this.mode !== 'inspect') return
    const to = this.active + Math.sign(delta)
    if (to < 0 || to >= COUNT) return
    this.switching = { from: this.active, to, dir: Math.sign(delta), fromSpin: this.yaw.x }
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

    let moving = this.mode !== 'browse' && this.mode !== 'inspect'
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
      track.spinVel = 0
      track.fresh = false
    } else {
      const vx = (x - track.px) / dt
      const vz = (z - track.pz) / dt
      ax = clamp((vx - track.vx) / dt, -30, 30)
      az = clamp((vz - track.vz) / dt, -30, 30)
      track.vx = vx
      track.vz = vz
      const spinVel = (spin + rackYaw - track.pspin) / dt
      track.spinVel += (spinVel - track.spinVel) * Math.min(1, dt * 18)
    }
    track.px = x
    track.pz = z
    track.pspin = spin + rackYaw

    if (this.reduced) {
      track.lateral.angle = track.lateral.velocity = 0
      track.depth.angle = track.depth.velocity = 0
      track.spinVel = 0
    } else {
      stepPendulum(track.lateral, ax, PENDULUM_LENGTH, 2.4, dt)
      stepPendulum(track.depth, az, PENDULUM_LENGTH, 2.8, dt)
    }

    // Hem lag: world-space lag rotated into the garment's own frame.
    const wx = clamp(-track.lateral.velocity * 0.03, -0.06, 0.06)
    const wz = clamp(-track.depth.velocity * 0.03, -0.06, 0.06)
    const psi = spin + rackYaw
    const c = Math.cos(psi)
    const s = Math.sin(psi)
    pose.x = x
    pose.y = y
    pose.z = z
    pose.spin = spin
    pose.rackYaw = rackYaw
    pose.swingZ = track.lateral.angle
    pose.swingX = -track.depth.angle
    pose.bendX = wx * c - wz * s
    pose.bendZ = wx * s + wz * c
    pose.flare = this.reduced ? 0 : Math.min(0.2, track.spinVel ** 2 * 0.0018)
    pose.twist = this.reduced ? 0 : clamp(-track.spinVel * 0.035, -0.3, 0.3)

    const p = track.lateral
    const q = track.depth
    return (
      Math.abs(p.angle) > 2e-4 || Math.abs(p.velocity) > 2e-3 ||
      Math.abs(q.angle) > 2e-4 || Math.abs(q.velocity) > 2e-3 ||
      Math.abs(track.spinVel) > 1e-3
    )
  }
}

export const rig = new Rig()
