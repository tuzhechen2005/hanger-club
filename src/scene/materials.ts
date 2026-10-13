import * as THREE from 'three'
import type { PrintPlacement, Product } from '../data/products'
import { UV_LAYOUT } from './uvLayout'

export interface ClothUniforms {
  /** Per-particle offsets from the cloth proxy (body space, metres). */
  uDisp: { value: THREE.Texture | null }
  /** Per-particle deformation gradients (three texels per particle). */
  uGrad: { value: THREE.Texture | null }
  uDispWidth: { value: number }
  uDispOn: { value: number }
  /** Mesh node → hanger (body) space, and back. Quantised GLB meshes are not in metres. */
  uToPivot: { value: THREE.Matrix4 }
  uFromPivot: { value: THREE.Matrix4 }
}

/** Uniforms for one garment's cloth; share them between its colour and shadow materials. */
export function clothUniforms(toPivot = new THREE.Matrix4()): ClothUniforms {
  return {
    uDisp: { value: null },
    uGrad: { value: null },
    uDispWidth: { value: 32 },
    uDispOn: { value: 0 },
    uToPivot: { value: toPivot.clone() },
    uFromPivot: { value: toPivot.clone().invert() },
  }
}

/**
 * Moves each vertex by the offsets of the proxy particles it is bound to (attributes
 * aProxyIdx / aProxyW, see clothProxy.ts), after the baked morphs. Lit materials also turn
 * the normal with the particles' interpolated deformation gradients, so shading follows the
 * sway; depth materials get the offsets so shadows do too.
 */
export function patchCloth(material: THREE.Material, uniforms: ClothUniforms) {
  const lit = !(material as THREE.MeshDepthMaterial).isMeshDepthMaterial
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 aProxyIdx;
attribute vec4 aProxyW;
uniform sampler2D uDisp;
uniform float uDispWidth;
uniform float uDispOn;
uniform mat4 uToPivot;
uniform mat4 uFromPivot;
vec3 proxyOffset(float index) {
  int i = int(index + 0.5);
  int w = int(uDispWidth);
  return texelFetch(uDisp, ivec2(i % w, i / w), 0).xyz;
}`,
      )
      .replace(
        '#include <morphtarget_vertex>',
        `#include <morphtarget_vertex>
if (uDispOn > 0.5) {
  vec3 pivot = (uToPivot * vec4(transformed, 1.0)).xyz;
  pivot += aProxyW.x * proxyOffset(aProxyIdx.x) + aProxyW.y * proxyOffset(aProxyIdx.y)
         + aProxyW.z * proxyOffset(aProxyIdx.z) + aProxyW.w * proxyOffset(aProxyIdx.w);
  transformed = (uFromPivot * vec4(pivot, 1.0)).xyz;
}`,
      )
    if (lit) {
      // Deformation gradient F = I + Σ w_k J_k; normals transform by cof(F) = det(F) F⁻ᵀ.
      shader.vertexShader = shader.vertexShader
        .replace(
          'vec3 proxyOffset(float index) {',
          `uniform sampler2D uGrad;
vec3 proxyGradient(float index, int column) {
  int k = int(index + 0.5) * 3 + column;
  int w = int(uDispWidth) * 3;
  return texelFetch(uGrad, ivec2(k % w, k / w), 0).xyz;
}
vec3 proxyColumn(int column) {
  return aProxyW.x * proxyGradient(aProxyIdx.x, column) + aProxyW.y * proxyGradient(aProxyIdx.y, column)
       + aProxyW.z * proxyGradient(aProxyIdx.z, column) + aProxyW.w * proxyGradient(aProxyIdx.w, column);
}
vec3 proxyOffset(float index) {`,
        )
        .replace(
          '#include <morphnormal_vertex>',
          `#include <morphnormal_vertex>
if (uDispOn > 0.5) {
  vec3 f0 = vec3(1.0, 0.0, 0.0) + proxyColumn(0);
  vec3 f1 = vec3(0.0, 1.0, 0.0) + proxyColumn(1);
  vec3 f2 = vec3(0.0, 0.0, 1.0) + proxyColumn(2);
  vec3 n = transpose(mat3(uFromPivot)) * objectNormal;
  n = n.x * cross(f1, f2) + n.y * cross(f2, f0) + n.z * cross(f0, f1);
  objectNormal = normalize(transpose(mat3(uToPivot)) * n);
}`,
        )
    }
    // A single-sheet placeholder shows its inside through the neck: darken back faces.
    if (lit && material.side === THREE.DoubleSide) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
if (!gl_FrontFacing) diffuseColor.rgb *= 0.5;`,
      )
    }
  }
  material.customProgramCacheKey = () => `cloth-v5-${lit ? 'lit' : 'depth'}-${material.side}`
}

/** Shadow-casting material that follows the same cloth offsets as the visible one. */
export function clothDepthMaterial(uniforms: ClothUniforms) {
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
  patchCloth(depth, uniforms)
  return depth
}

function fabricMaterial(map: THREE.Texture, fabric: string, inner: boolean, source?: THREE.MeshStandardMaterial) {
  const sheen = new THREE.Color(fabric).lerp(new THREE.Color('#ffffff'), 0.35)
  return new THREE.MeshPhysicalMaterial({
    map,
    color: inner ? new THREE.Color(0.55, 0.55, 0.55) : new THREE.Color(1, 1, 1),
    normalMap: source?.normalMap ?? null,
    normalScale: source?.normalScale ?? new THREE.Vector2(1, 1),
    aoMap: source?.aoMap ?? null,
    roughnessMap: source?.roughnessMap ?? null,
    roughness: source?.roughnessMap ? 1 : 0.9,
    metalness: 0,
    sheen: 0.45,
    sheenRoughness: 0.8,
    sheenColor: sheen,
    // The placeholder is a single sheet; the Blender garment is a closed 2 mm shell.
    side: source ? THREE.FrontSide : THREE.DoubleSide,
  })
}

/** Outer + inner fabric for one product, sharing the GLB's normal/ORM maps when given. */
export function createFabricMaterials(map: THREE.Texture, product: Product, source?: { outer?: THREE.MeshStandardMaterial; inner?: THREE.MeshStandardMaterial }) {
  return {
    outer: fabricMaterial(map, product.fabric, false, source?.outer),
    inner: fabricMaterial(map, product.fabric, true, source?.inner ?? source?.outer),
  }
}

const SIZE = 1024

let knitTile: HTMLCanvasElement | null = null
function knit() {
  if (knitTile) return knitTile
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const img = g.createImageData(64, 64)
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 128 + (Math.random() - 0.5) * 70
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v
    img.data[i + 3] = 255
  }
  g.putImageData(img, 0, 0)
  knitTile = c
  return c
}

type Rect = typeof UV_LAYOUT.front

/** Place a photo-cropped print at physical scale inside a body rect (image space, y down). */
function drawPrint(g: CanvasRenderingContext2D, image: HTMLImageElement, place: PrintPlacement, rect: Rect) {
  const x0 = rect.u0 * SIZE
  const w = (rect.u1 - rect.u0) * SIZE
  const h = (rect.v1 - rect.v0) * SIZE
  const top = (1 - rect.v1) * SIZE
  const pw = place.width * w
  const ph = ((place.width * UV_LAYOUT.bodyWidth * place.aspect) / UV_LAYOUT.bodyLength) * h
  const cx = x0 + w / 2 + place.centerX * w
  g.save()
  g.beginPath()
  g.rect(x0, top, w, h)
  g.clip()
  g.drawImage(image, cx - pw / 2, top + place.top * h, pw, ph)
  g.restore()
}

const loadImage = (url: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = url
  })

/**
 * Base color for a product, in glTF UV convention (flipY = false). Uses the pipeline's
 * finished basecolor.png when there is one; otherwise composes fabric color + knit grain +
 * the photo-cropped placeholder prints.
 */
export function createGarmentTexture(product: Product, onUpdate: () => void): THREE.Texture {
  if (product.basecolor) {
    const texture = new THREE.TextureLoader().load(product.basecolor, onUpdate)
    texture.flipY = false
    texture.colorSpace = THREE.SRGBColorSpace
    texture.anisotropy = 4
    return texture
  }
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = SIZE
  const g = canvas.getContext('2d')!
  g.fillStyle = product.fabric
  g.fillRect(0, 0, SIZE, SIZE)
  g.globalAlpha = 0.07
  g.globalCompositeOperation = 'overlay'
  g.fillStyle = g.createPattern(knit(), 'repeat')!
  g.fillRect(0, 0, SIZE, SIZE)
  g.globalAlpha = 1
  g.globalCompositeOperation = 'source-over'

  const texture = new THREE.CanvasTexture(canvas)
  texture.flipY = false
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4

  for (const [side, rect] of [
    ['front', UV_LAYOUT.front],
    ['back', UV_LAYOUT.back],
  ] as const) {
    const place = product.prints[side]
    if (!place) continue
    loadImage(place.url)
      .then((image) => {
        drawPrint(g, image, place, rect)
        texture.needsUpdate = true
        onUpdate()
      })
      .catch(() => {
        // Missing print image: the plain garment still renders.
      })
  }
  return texture
}
