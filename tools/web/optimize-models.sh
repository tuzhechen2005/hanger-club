#!/bin/sh
# Web copies of the Blender exports: meshopt-compressed geometry/morphs, WebP textures.
# Vertex order is preserved (no weld/simplify/join/flatten) so morph targets stay valid.
set -e
cd "$(dirname "$0")/../.."
mkdir -p public/models/web
for name in tee tee_anim; do
  npx gltf-transform optimize "public/models/$name.glb" "public/models/web/$name.glb" \
    --compress meshopt --texture-compress webp --texture-size 2048 \
    --weld false --simplify false --join false --flatten false --instance false \
    --palette false --resample false --prune false
done
ls -la public/models/web
