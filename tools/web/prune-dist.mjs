// The site loads the optimised copies in models/web/. Drop the raw Blender exports and
// their source textures from the static output; they stay in the repo for the pipeline.
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const dist = new URL('../../dist/', import.meta.url).pathname
import { readdirSync } from 'node:fs'

// Raw Blender exports of every garment kind (the page loads models/web/<kind>*.glb instead).
const raw = readdirSync(join(dist, 'models')).filter((name) => name.endsWith('.glb')).map((name) => `models/${name}`)
for (const path of [...raw, 'models/.gitkeep', 'textures', 'products/.gitkeep']) {
  rmSync(join(dist, path), { recursive: true, force: true })
}
// Pipeline-only product files: full-size base colour sources and print crops stay in the repo.
for (const slug of readdirSync(join(dist, 'products'))) {
  for (const name of ['print_front.png', 'print_back.png']) rmSync(join(dist, 'products', slug, name), { force: true })
}
