// Interaction checks for the whole page (24 items): rendering stops when idle, keyboard and
// drag browsing, fling, rail ends, tap to lift, the original-photo reveal, focus moves, pull
// down to put back, bag merge and persistence, corrupt storage, reduced motion, touch axes.
// Needs the dev server running (npm run dev) and a local Chrome; playwright-core only.
//
//   npm run check:ui                       # http://127.0.0.1:5173/
//   CHROME=/path/to/chrome npm run check:ui -- http://localhost:5174/
//
// Some checks name products by their place on the rail (src/data/products.ts): update them
// when the rail order changes. Exits 1 if any check fails or the page throws.
import { chromium } from 'playwright-core'

const url = process.argv[2] ?? 'http://127.0.0.1:5173/'
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
})
const errors = []
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`)
}

async function open(options = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, ...options })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(e.message))
  await page.addInitScript(() => {
    window.__raf = 0
    const raf = window.requestAnimationFrame.bind(window)
    window.requestAnimationFrame = (cb) => {
      window.__raf++
      return raf(cb)
    }
  })
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.waitForTimeout(3500)
  return { ctx, page }
}
const mode = (page) => page.getAttribute('.app', 'data-mode')
const name = (page) => page.textContent('.rack-name')
// Lifting develops the original photo; dismiss it to get back to the 3D close-up.
const dismissPhoto = async (page) => {
  if (await page.evaluate(() => document.querySelector('.photo-view')?.open)) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1000)
  }
}

{
  const { ctx, page } = await open()
  // Idle: render-on-demand should stop requesting frames (marquee is CSS, not rAF).
  const a = await page.evaluate(() => window.__raf)
  await page.waitForTimeout(1500)
  const b = await page.evaluate(() => window.__raf)
  check('idle stops rendering', b - a < 5, `(${b - a} rAF in 1.5s)`)

  // Keyboard browse.
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(1200)
  check('arrow keys browse', (await name(page)) === 'Wood Label Tee', await name(page))

  // Fast fling still advances only one item.
  const before = await name(page)
  await page.mouse.move(300, 380)
  await page.mouse.down()
  for (let i = 1; i <= 4; i++) await page.mouse.move(300 - i * 60, 380)
  await page.mouse.up()
  await page.waitForTimeout(1500)
  check('fling moves one item', (await name(page)) === 'Script Tee', `${before} -> ${await name(page)}`)

  // Over-drag at the end rubber-bands and comes back.
  await page.evaluate(() => window.__rig.select(window.__rig.count - 1))
  await page.waitForTimeout(1500)
  await page.mouse.move(300, 380)
  await page.mouse.down()
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(300 - i * 25, 380)
    await page.waitForTimeout(16)
  }
  await page.waitForTimeout(200)
  await page.mouse.up()
  await page.waitForTimeout(1500)
  check('end rubber-band returns to last', (await name(page)) === 'Stripe Track Pant', await name(page))

  // Tap on the centre garment lifts it; mashing during the lift doesn't break anything.
  await page.mouse.click(195, 400)
  await page.mouse.click(195, 400)
  await page.click('.see', { force: true }).catch(() => {})
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1600)
  check('lift develops the original photo', await page.evaluate(() => { const d = document.querySelector('.photo-view'); return d.open && d.dataset.origin === 'garment' }))
  await dismissPhoto(page)
  check('tap lifts, mashing ignored', (await mode(page)) === 'inspect', await mode(page))
  check('focus moved to detail title', await page.evaluate(() => document.activeElement?.tagName === 'H2'))

  // Pull down puts it back.
  await page.mouse.move(195, 250)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(197, 250 + i * 18)
    await page.waitForTimeout(16)
  }
  await page.mouse.up()
  await page.waitForTimeout(1600)
  check('pull down returns to rail', (await mode(page)) === 'browse', await mode(page))
  check('focus back on See the piece', await page.evaluate(() => document.activeElement?.className === 'see'))

  // Escape closes; switching at the first item is disabled.
  await page.keyboard.press('Home')
  await page.click('.see')
  await page.waitForTimeout(1500)
  await dismissPhoto(page)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1500)
  check('escape closes', (await mode(page)) === 'browse')

  // Bag: add twice same size merges; persists across reload.
  await page.click('.see')
  await page.waitForTimeout(1500)
  await dismissPhoto(page)
  await page.click('.sizes button:has-text("L")')
  await page.click('.detail .primary')
  await page.click('.detail .primary')
  await page.click('.close-button')
  await page.waitForTimeout(1500)
  check('bag count', (await page.textContent('.bag-button'))?.includes('2'), await page.textContent('.bag-button'))
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(800)
  await page.click('.bag-button')
  const lines = await page.locator('.bag-lines li').count()
  const qty = await page.textContent('.qty span')
  check('bag merged and persisted', lines === 1 && qty === '2', `lines=${lines} qty=${qty}`)
  await page.screenshot({ path: new URL('./shots/bag.png', import.meta.url).pathname })
  await page.click('.qty button[aria-label="Decrease quantity"]')
  await page.click('.qty button[aria-label="Decrease quantity"]')
  check('empty bag message', (await page.locator('.empty').count()) === 1)
  await ctx.close()
}

{
  // Baked cloth clip plays during lift and return, and ends on the base mesh.
  const { ctx, page } = await open()
  check('animated model loaded', await page.evaluate(() => window.__rig.bakedClips))
  await page.click('.see')
  await page.waitForTimeout(500)
  const mid = await page.evaluate(() => window.__rig.morph(window.__rig.active))
  check('lift plays baked morphs', !!mid && mid.a > 5 && mid.a < 30, JSON.stringify(mid))
  await page.waitForTimeout(1500)
  const held = await page.evaluate(() => window.__rig.morph(window.__rig.active))
  check('close-up holds lift end', !!held && held.a === 35, JSON.stringify(held))
  await dismissPhoto(page)
  check('photo dissolves back into the 3D close-up', !(await page.evaluate(() => document.querySelector('.photo-view').open)) && (await page.evaluate(() => document.activeElement?.tagName)) === 'H2')
  await page.click('.proof')
  await page.waitForTimeout(900)
  check('clipped proof opens the photo', await page.evaluate(() => { const d = document.querySelector('.photo-view'); return d.open && d.dataset.origin === 'clip' && d.dataset.phase === 'open' }))
  await dismissPhoto(page)
  await page.click('.close-button')
  await page.waitForTimeout(600)
  const back = await page.evaluate(() => window.__rig.morph(window.__rig.active))
  check('return plays baked morphs', !!back && back.a >= 35, JSON.stringify(back))
  await page.waitForTimeout(1200)
  check('back on base mesh after return', (await page.evaluate(() => window.__rig.morph(window.__rig.active))) === null)
  await ctx.close()
}

{
  // Corrupt storage must not white-screen.
  const { ctx, page } = await open()
  await page.evaluate(() => localStorage.setItem('hanger-bag-v2', '{"items":[{"productId":"x"}, 5, null]}'))
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(800)
  check('corrupt storage survives', (await page.textContent('.bag-button'))?.includes('0'))
  await ctx.close()
}

{
  // Reduced motion: lift without the spin, still reaches inspect.
  const { ctx, page } = await open({ reducedMotion: 'reduce' })
  await page.click('.see')
  await page.waitForTimeout(1500)
  check('reduced motion lift', (await mode(page)) === 'inspect')
  await ctx.close()
}

{
  // Touch: vertical swipes on the rail don't move it; horizontal ones do.
  const { ctx, page } = await open({ hasTouch: true, isMobile: true })
  const cdp = await ctx.newCDPSession(page)
  const touch = async (points) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: points[0][0], y: points[0][1] }] })
    for (const [x, y] of points.slice(1)) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] })
      await page.waitForTimeout(16)
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }
  await touch(Array.from({ length: 10 }, (_, i) => [200, 300 + i * 15]))
  await page.waitForTimeout(1000)
  check('vertical touch leaves rail', (await name(page)) === 'Oat Label Tee', await name(page))
  await touch(Array.from({ length: 10 }, (_, i) => [300 - i * 22, 380]))
  await page.waitForTimeout(1200)
  check('horizontal touch browses', (await name(page)) === 'Sand Fleece Hoodie', await name(page))
  await ctx.close()
}

console.log(errors.length ? `page errors:\n${errors.join('\n')}` : 'no page errors')
await browser.close()
process.exit(failed || errors.length ? 1 : 0)
