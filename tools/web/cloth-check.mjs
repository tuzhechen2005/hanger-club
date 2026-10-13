// Measures the cloth motion against the targets in docs/cloth-motion.md §5.
// Needs the dev server running (npm run dev) and a local Chrome; uses playwright-core only,
// no browser download.
//
//   npm run cloth:check                      # http://127.0.0.1:5173/
//   CHROME=/path/to/chrome npm run cloth:check -- http://localhost:5174/
//
// Exits 1 if any target is missed. Numbers are from this machine: on a phone the
// simulation time will be several times higher.

import { chromium } from 'playwright-core'

const url = process.argv[2] ?? 'http://127.0.0.1:5173/'
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const TARGETS = {
  restMaxCm: 1.0,
  swipePeakCm: 7.5,
  swipeSettleS: 2.0,
  liftFlareMinCm: 3.0,
  liftFlareMaxCm: 7.5,
  turnPeakCm: 7.0,
  turnSettleS: 1.5,
  idleSteps: 0,
  simMedianMs: 4.0,
}

const browser = await chromium.launch({ executablePath: chrome, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: false })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.goto(url, { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__sim && window.__rig?.bakedClips, null, { timeout: 20000 })
await page.waitForTimeout(3000)

// Per frame: each garment's 95th-percentile offset (m), the mode and the simulation time.
await page.evaluate(() => {
  const sim = window.__sim
  const rig = window.__rig
  const step = sim.step.bind(sim)
  window.__log = []
  sim.step = (...args) => {
    const start = performance.now()
    const active = step(...args)
    const ms = performance.now() - start
    const p95 = sim.textures.map((t) => {
      const d = t.image.data
      const a = []
      for (let i = 0; i < sim.topology.count * 4; i += 4) a.push(Math.hypot(d[i], d[i + 1], d[i + 2]))
      a.sort((x, y) => x - y)
      return a[Math.floor(a.length * 0.95)]
    })
    window.__log.push({ t: performance.now(), mode: rig.mode, active: rig.active, p95, ms })
    return active
  }
})

const take = () => page.evaluate(() => window.__log.splice(0))

// Garments packed on the rail must come to rest right after loading, not flicker in contact.
await page.waitForTimeout(1500)
await take()
await page.waitForTimeout(1500)
const loadIdle = (await take()).length
const peak = (log, pick) => Math.max(0, ...log.map(pick)) * 100
const settle = (log, pick) => {
  const i = log.findIndex((_, k) => log.slice(k).every((e) => pick(e) < 0.01))
  return i < 0 ? Infinity : (log[i].t - log[0].t) / 1000
}

const rest = await page.evaluate(() => {
  const sim = window.__sim
  let max = 0
  for (const t of sim.textures) {
    const d = t.image.data
    for (let i = 0; i < sim.topology.count * 4; i += 4) max = Math.max(max, Math.hypot(d[i], d[i + 1], d[i + 2]))
  }
  return max * 100
})

// A normal swipe to the next piece.
await page.mouse.move(300, 380)
await page.mouse.down()
for (let i = 1; i <= 5; i++) {
  await page.mouse.move(300 - i * 30, 380)
  await page.waitForTimeout(16)
}
await page.mouse.up()
await page.waitForTimeout(3000)
const swipe = await take()
const all = (e) => Math.max(...e.p95)

// Lift with its 360° turn, then a fast hand turn in the close-up.
await page.evaluate(() => window.__rig.lift())
await page.waitForTimeout(3500)
const lift = await take()
// A swipe frame can still trail in; the lifted garment is the one in the lifting frames.
const hero = lift.find((e) => e.mode === 'lifting').active
const own = (e) => e.p95[hero]
await page.evaluate(() => {
  const r = window.__rig
  r.pointerDown(1, 300, 500)
  for (let i = 1; i <= 6; i++) r.pointerMove(1, 300 - i * 40, 500, performance.now() + i * 16)
  r.pointerUp(1, 60, 500, performance.now() + 100)
})
await page.waitForTimeout(3000)
const turn = await take()

await page.waitForTimeout(500)
await take()
await page.waitForTimeout(1500)
const idle = (await take()).length

const times = [...swipe, ...lift, ...turn].map((e) => e.ms).sort((a, b) => a - b)
const results = {
  loadIdleSteps: loadIdle,
  restMaxCm: rest,
  swipePeakCm: peak(swipe, all),
  swipeSettleS: settle(swipe, all),
  liftFlareCm: peak(lift.filter((e) => e.mode === 'lifting'), own),
  turnPeakCm: peak(turn, own),
  turnSettleS: settle(turn, own),
  idleSteps: idle,
  simMedianMs: times[times.length >> 1],
  simP95Ms: times[Math.floor(times.length * 0.95)],
}
await browser.close()

const checks = [
  ['加载后 1.5 s 内模拟步数', results.loadIdleSteps, results.loadIdleSteps <= TARGETS.idleSteps, `= ${TARGETS.idleSteps}`],
  ['静止时最大偏移 (cm)', results.restMaxCm, results.restMaxCm <= TARGETS.restMaxCm, `≤ ${TARGETS.restMaxCm}`],
  ['滑动峰值 (cm)', results.swipePeakCm, results.swipePeakCm <= TARGETS.swipePeakCm, `≤ ${TARGETS.swipePeakCm}`],
  ['滑动后停下 (s)', results.swipeSettleS, results.swipeSettleS <= TARGETS.swipeSettleS, `≤ ${TARGETS.swipeSettleS}`],
  ['取下转圈甩出 (cm)', results.liftFlareCm, results.liftFlareCm >= TARGETS.liftFlareMinCm && results.liftFlareCm <= TARGETS.liftFlareMaxCm, `${TARGETS.liftFlareMinCm}–${TARGETS.liftFlareMaxCm}`],
  ['近看拖转峰值 (cm)', results.turnPeakCm, results.turnPeakCm <= TARGETS.turnPeakCm, `≤ ${TARGETS.turnPeakCm}`],
  ['拖转后停下 (s)', results.turnSettleS, results.turnSettleS <= TARGETS.turnSettleS, `≤ ${TARGETS.turnSettleS}`],
  ['静止 1.5 s 内模拟步数', results.idleSteps, results.idleSteps <= TARGETS.idleSteps, `= ${TARGETS.idleSteps}`],
  ['每帧模拟中位数 (ms)', results.simMedianMs, results.simMedianMs <= TARGETS.simMedianMs, `≤ ${TARGETS.simMedianMs}`],
  ['每帧模拟 p95 (ms)', results.simP95Ms, true, '记录'],
]
for (const [name, value, ok, target] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(18)} ${Number(value).toFixed(2).padStart(7)}   目标 ${target}`)
for (const e of errors) console.log(`PAGE ERROR  ${e}`)
process.exit(checks.every(([, , ok]) => ok) && errors.length === 0 ? 0 : 1)
