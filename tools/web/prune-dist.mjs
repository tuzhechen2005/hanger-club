// The site loads the optimised copies in models/web/. Drop the raw Blender exports and
// their source textures from the static output; they stay in the repo for the pipeline.
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const dist = new URL('../../dist/', import.meta.url).pathname
for (const path of ['models/tee.glb', 'models/tee_anim.glb', 'models/hanger.glb', 'models/.gitkeep', 'textures', 'products/.gitkeep']) {
  rmSync(join(dist, path), { recursive: true, force: true })
}
