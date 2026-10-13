import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { products } from '../data/products'
import { rig } from '../motion/rig'
import { computeFraming, FOV, GARMENT_BOTTOM, INSPECT_Y, INSPECT_Z } from './framing'
import { useUI } from '../state/store'
import { createHangerGeometry, createTeeGeometry } from './geometry'
import { clothDepthMaterial, clothUniforms, createFabricMaterials, createGarmentTexture, patchCloth, type ClothUniforms } from './materials'
import { useGarmentModels, type GarmentModel } from './models'
import { buildProxy, ClothSim, coarser, JERSEY_TEE, PROFILES, type ProxyPart, type ProxyTopology } from './clothProxy'
import type { Kind, Product } from '../data/products'

interface GarmentRefs {
  slot: THREE.Group
  swing: THREE.Group
  spin: THREE.Group
  body: THREE.Group
  /** Cloth meshes: picked by the raycaster, driven by baked morphs. */
  meshes: THREE.Mesh[]
  uniforms: ClothUniforms[]
}

const registry: GarmentRefs[] = []
let cssRail = ''
/** Lift time (s) at which the photo starts developing: the turn is at ~270°, coming round. */
const PHOTO_REVEAL_AT = 0.8
let cssLift = ''

function usePlaceholderAssets() {
  return useMemo(() => {
    const tee = createTeeGeometry()
    const hanger = createHangerGeometry()
    const wood = new THREE.MeshStandardMaterial({ color: '#8a5434', roughness: 0.5, metalness: 0 })
    const metal = new THREE.MeshStandardMaterial({ color: '#d4d4cf', roughness: 0.22, metalness: 1 })
    return { tee, hanger, wood, metal }
  }, [])
}
type PlaceholderAssets = ReturnType<typeof usePlaceholderAssets>

interface GarmentParts {
  hook: THREE.Object3D
  wood: THREE.Object3D
  cloth: THREE.Object3D
  meshes: THREE.Mesh[]
  uniforms: ClothUniforms[]
  materials: THREE.Material[]
}

/** The Blender garment for one product: shared geometry and maps, its own base color. */
function fromModel(model: GarmentModel, product: Product, map: THREE.Texture): GarmentParts {
  const cloth = model.garment.clone(true)
  const meshes: THREE.Mesh[] = []
  cloth.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh)
  })
  const sources = meshes.map((m) => m.material as THREE.MeshStandardMaterial)
  const { outer, inner } = createFabricMaterials(map, product, {
    outer: sources.find((m) => m.name === 'Fabric'),
    inner: sources.find((m) => m.name === 'FabricInner'),
  })
  cloth.updateMatrix()
  const materials: THREE.Material[] = [outer, inner]
  // Each mesh (outer, inner shell) has its own node transform from quantisation, so its own
  // uniforms, shared by its colour material and its shadow material.
  const uniforms = meshes.map((mesh) => {
    const isInner = (mesh.material as THREE.Material).name === 'FabricInner'
    mesh.material = isInner ? inner : outer
    mesh.updateMatrix()
    const toPivot = mesh === cloth ? cloth.matrix.clone() : cloth.matrix.clone().multiply(mesh.matrix)
    const u = clothUniforms(toPivot)
    patchCloth(mesh.material as THREE.Material, u)
    mesh.customDepthMaterial = clothDepthMaterial(u)
    materials.push(mesh.customDepthMaterial)
    return u
  })
  return { hook: model.hook.clone(), wood: model.wood.clone(), cloth, meshes, uniforms, materials }
}

function fromPlaceholder(assets: PlaceholderAssets, product: Product, map: THREE.Texture): GarmentParts {
  const { outer } = createFabricMaterials(map, product)
  const cloth = new THREE.Mesh(assets.tee, outer)
  const uniforms = clothUniforms()
  patchCloth(outer, uniforms)
  cloth.customDepthMaterial = clothDepthMaterial(uniforms)
  return {
    hook: new THREE.Mesh(assets.hanger.hook, assets.metal),
    wood: new THREE.Mesh(assets.hanger.wood, assets.wood),
    cloth,
    meshes: [cloth],
    uniforms: [uniforms],
    materials: [outer, cloth.customDepthMaterial],
  }
}

/**
 * The template the cloth proxy is built from (all garments share this geometry): the fabric
 * parts, outer surface first, and the hanger they rest on.
 */
function proxyParts(model: GarmentModel | null, placeholder: PlaceholderAssets): { parts: ProxyPart[]; support: ProxyPart } {
  if (!model) {
    return { parts: [{ geometry: placeholder.tee, toPivot: new THREE.Matrix4() }], support: { geometry: placeholder.hanger.wood, toPivot: new THREE.Matrix4() } }
  }
  model.garment.updateMatrix()
  const parts: ProxyPart[] = []
  model.garment.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    mesh.updateMatrix()
    const toPivot = mesh === model.garment ? mesh.matrix.clone() : model.garment.matrix.clone().multiply(mesh.matrix)
    const part = { geometry: mesh.geometry, toPivot }
    if ((mesh.material as THREE.Material).name === 'FabricInner') parts.push(part)
    else parts.unshift(part)
  })
  model.wood.updateMatrix()
  return { parts, support: { geometry: model.wood.geometry, toPivot: model.wood.matrix.clone() } }
}

function Garment({ index, placeholder, model, sim }: { index: number; placeholder: PlaceholderAssets; model: GarmentModel | null; sim: ClothSim }) {
  const invalidate = useThree((s) => s.invalidate)
  const product = products[index]
  const map = useMemo(() => createGarmentTexture(product, () => rig.invalidate()), [product])
  const parts = useMemo(
    () => (model ? fromModel(model, product, map) : fromPlaceholder(placeholder, product, map)),
    [model, placeholder, product, map],
  )
  const slot = useRef<THREE.Group>(null!)
  const swing = useRef<THREE.Group>(null!)
  const spin = useRef<THREE.Group>(null!)
  const body = useRef<THREE.Group>(null!)

  useEffect(() => {
    for (const u of parts.uniforms) {
      u.uDisp.value = sim.textures[index]
      u.uGrad.value = sim.gradients[index]
      u.uDispWidth.value = sim.topologies[index].textureWidth
      u.uDispOn.value = 1
    }
    for (const part of [parts.hook, parts.wood, parts.cloth]) part.traverse((o) => (o.castShadow = true))
    for (const mesh of parts.meshes) mesh.userData.index = index
    registry[index] = { slot: slot.current, swing: swing.current, spin: spin.current, body: body.current, meshes: parts.meshes, uniforms: parts.uniforms }
    invalidate()
    return () => parts.materials.forEach((m) => m.dispose())
  }, [index, parts, sim, invalidate])

  useEffect(() => () => map.dispose(), [map])

  return (
    <group ref={slot}>
      <group ref={swing}>
        <group ref={spin}>
          <primitive object={parts.hook} />
          <group ref={body}>
            <primitive object={parts.wood} />
            <primitive object={parts.cloth} />
          </group>
        </group>
      </group>
    </group>
  )
}

/** Hanger-space top and bottom of each product's garment (placeholder tee until its model loads). */
type Extents = { top: number; bottom: number }[]

function Driver({ rail, wall, sim, onSlow, extents }: { rail: React.RefObject<THREE.Mesh | null>; wall: React.RefObject<THREE.Mesh | null>; sim: ClothSim; onSlow: () => void; extents: Extents }) {
  const bodies = useMemo(() => products.map(() => new THREE.Matrix4()), [])
  const follow = useMemo(() => products.map(() => false), [])
  const inertia = useMemo(() => products.map(() => 1), [])
  const { camera, size, invalidate, raycaster, gl } = useThree()

  useEffect(() => {
    rig.invalidate = invalidate
    rig.pick = (clientX, clientY) => {
      const rect = gl.domElement.getBoundingClientRect()
      const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
      raycaster.setFromCamera(ndc, camera)
      const hits = raycaster.intersectObjects(registry.filter(Boolean).flatMap((g) => g.meshes), false)
      return hits.length ? (hits[0].object.userData.index as number) : null
    }
    invalidate()
  }, [camera, gl, invalidate, raycaster])

  // Browse fits the longest garment on the rail; each close-up fits its own piece.
  const aspect = size.width / size.height
  const browseBottom = Math.min(...extents.map((e) => e.bottom))
  const framings = useMemo(() => extents.map((e) => computeFraming(aspect, browseBottom, e.bottom)), [aspect, browseBottom, extents])
  const index = useUI((s) => s.index)
  const framing = framings[index]
  /** The close-up camera eases to the active piece's framing (switching tee → trousers). */
  const inspectCamera = useRef<{ x: number; y: number; z: number } | null>(null)

  useEffect(() => {
    rig.aspect = size.width / size.height
    rig.pxPerItem = (0.56 / framing.browseWidth) * size.width * 1.15
    rig.pxPerRadian = (Math.min(size.width, 520) * 0.62) / Math.PI
    const root = document.documentElement.style
    root.setProperty('--browse-info-top', `${(framing.browseInfo * 100).toFixed(2)}%`)
    root.setProperty('--inspect-info-top', `${(framing.inspectInfo * 100).toFixed(2)}%`)
    // Where the close-up garment lands on screen, so the original photo can develop right on
    // top of it (ui/PhotoView): the photo's garment box is matched to the 3D garment's height.
    const cam = new THREE.PerspectiveCamera(FOV, size.width / size.height, 0.1, 40)
    cam.position.set(framing.inspect.cameraX, framing.inspect.cameraY, framing.inspect.cameraZ)
    cam.lookAt(framing.inspect.cameraX, framing.inspect.cameraY, 0)
    cam.updateMatrixWorld()
    const toScreen = (y: number) => {
      const v = new THREE.Vector3(0, y, INSPECT_Z).project(cam)
      return { x: ((v.x + 1) / 2) * size.width, y: ((1 - v.y) / 2) * size.height }
    }
    const top = toScreen(INSPECT_Y + extents[index].top)
    const hem = toScreen(INSPECT_Y + extents[index].bottom)
    const [l, t, r, b] = products[index].photos[0].bbox
    const side = (hem.y - top.y) / (b - t)
    root.setProperty('--g-x', `${(top.x - ((l + r) / 2 - 0.5) * side).toFixed(1)}px`)
    root.setProperty('--g-y', `${((top.y + hem.y) / 2 - ((t + b) / 2 - 0.5) * side).toFixed(1)}px`)
    root.setProperty('--g-s', `${side.toFixed(1)}px`)
    invalidate()
  }, [framing, index, extents, size.width, size.height, invalidate])

  const revealed = useRef(false)
  useFrame((_, dt) => {
    const moving = rig.step(dt)
    // As the lift turn swings back toward the front, the garment develops into its photo.
    if (rig.mode === 'browse') revealed.current = false
    else if (rig.mode === 'lifting' && !revealed.current && rig.t >= (rig.reduced ? 0.8 : PHOTO_REVEAL_AT)) {
      revealed.current = true
      if (!useUI.getState().photo) useUI.getState().openPhoto('garment')
    }
    const b = rig.blend
    const { browse } = framing
    const goal = framings[rig.active].inspect
    const ease = inspectCamera.current ? 1 - Math.exp(-Math.min(dt, 0.1) * 7) : 1
    const current = (inspectCamera.current ??= { x: goal.cameraX, y: goal.cameraY, z: goal.cameraZ })
    current.x += (goal.cameraX - current.x) * ease
    current.y += (goal.cameraY - current.y) * ease
    current.z += (goal.cameraZ - current.z) * ease
    const easing = Math.abs(goal.cameraZ - current.z) + Math.abs(goal.cameraY - current.y) > 1e-4
    const inspect = { cameraX: current.x, cameraY: current.y, cameraZ: current.z }
    const cx = browse.cameraX + (inspect.cameraX - browse.cameraX) * b
    camera.position.set(cx, browse.cameraY + (inspect.cameraY - browse.cameraY) * b, browse.cameraZ + (inspect.cameraZ - browse.cameraZ) * b)
    camera.lookAt(cx, camera.position.y, 0)
    // The page's backdrop (giant numerals) slides with the rail and fades in the close-up.
    const railPos = rig.pos.x.toFixed(3)
    const lift = b.toFixed(3)
    if (railPos !== cssRail || lift !== cssLift) {
      document.documentElement.style.setProperty('--rail', railPos)
      document.documentElement.style.setProperty('--lift', lift)
      cssRail = railPos
      cssLift = lift
    }

    registry.forEach((g, i) => {
      if (!g) return
      const p = rig.poses[i]
      g.slot.position.set(p.x, p.y, p.z)
      g.swing.rotation.set(p.swingX, 0, p.swingZ)
      g.spin.rotation.y = p.spin
      g.body.rotation.y = p.rackYaw
      const morph = rig.morph(i)
      for (const mesh of g.meshes) {
        const influences = mesh.morphTargetInfluences
        if (!influences) continue
        influences.fill(0)
        if (!morph) continue
        if (morph.a >= 0) influences[morph.a] += 1 - morph.w
        if (morph.b >= 0) influences[morph.b] += morph.w
      }
    })
    if (rail.current) {
      const m = rail.current.material as THREE.MeshStandardMaterial
      m.opacity = 1 - 0.8 * b
    }
    if (wall.current) (wall.current.material as THREE.ShadowMaterial).opacity = 0.1 * (1 - 0.75 * b)
    // Cloth proxies ride on the hanger bodies; baked clips (and reduced motion) override them.
    registry.forEach((g, i) => {
      if (!g) return
      g.body.updateWorldMatrix(true, false)
      bodies[i].copy(g.body.matrixWorld)
      // Off-screen neighbours during the close-up, and the far ends of the rail, don't need
      // cloth, just their rest shape.
      // Baked clips keep simulating: the bake is the shape, the proxy adds the inertia.
      follow[i] = rig.reduced || rig.offstage(i) || rig.distant(i)
      inertia[i] = rig.inertia(i)
    })
    const clothMoving = registry.length === products.length && sim.step(dt, bodies, follow, inertia)
    if (sim.slow) onSlow()
    if (moving || clothMoving || (easing && b > 0)) invalidate()
  })
  return null
}

function Environment() {
  const { gl, scene } = useThree()
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl)
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    scene.environment = env
    scene.environmentIntensity = 0.35
    return () => {
      env.dispose()
      pmrem.dispose()
    }
  }, [gl, scene])
  return null
}

function SceneContent() {
  const placeholder = usePlaceholderAssets()
  const models = useGarmentModels()
  useEffect(() => {
    rig.baked = products.map((p) => !!models[p.kind]?.animated)
    rig.invalidate()
  }, [models])
  // One proxy topology per garment kind (built from its geometry and fabric profile), one
  // simulation for all garments. A device that cannot keep up gets coarser proxies once
  // (the cloth resets to rest).
  const [coarse, setCoarse] = useState(false)
  const sim = useMemo(() => {
    const profile = (kind: Kind) => (coarse ? coarser(PROFILES[kind]) : PROFILES[kind])
    let fallback: ProxyTopology | null = null
    const byKind = new Map<Kind, ProxyTopology>()
    const topologyFor = (kind: Kind) => {
      const model = models[kind]
      if (!model) {
        if (!fallback) {
          const { parts, support } = proxyParts(null, placeholder)
          fallback = buildProxy(parts, support, coarse ? coarser(JERSEY_TEE) : JERSEY_TEE)
        }
        return fallback
      }
      if (!byKind.has(kind)) {
        const { parts, support } = proxyParts(model, placeholder)
        byKind.set(kind, buildProxy(parts, support, profile(kind)))
      }
      return byKind.get(kind)!
    }
    return new ClothSim(products.map((p) => topologyFor(p.kind)))
  }, [models, placeholder, coarse])
  const extents = useMemo<Extents>(
    () => products.map((p) => ({ top: models[p.kind]?.top ?? -0.08, bottom: models[p.kind]?.bottom ?? GARMENT_BOTTOM })),
    [models],
  )
  const scene = useThree((state) => state.scene)
  useEffect(() => {
    if (import.meta.env.DEV) Object.assign(window, { __sim: sim, __scene: scene })
    return () => [...sim.textures, ...sim.gradients].forEach((t) => t.dispose())
  }, [sim, scene])
  const rail = useRef<THREE.Mesh>(null)
  const wall = useRef<THREE.Mesh>(null)
  const mobile = typeof window !== 'undefined' && window.matchMedia('(max-width: 700px)').matches
  return (
    <>
      <Driver rail={rail} wall={wall} sim={sim} onSlow={() => setCoarse(true)} extents={extents} />
      <Environment />
      {/* Studio three-point light: warm key from front left, cool fill, a rim from behind
          that separates the garments from the backdrop and shows their volume. */}
      <hemisphereLight args={['#fff6e8', '#b9b2a6', 0.55]} />
      <directionalLight position={[2.4, 1.2, 2.6]} intensity={0.35} color="#dfe6ff" />
      <directionalLight position={[1.2, 1.8, -3]} intensity={1.1} color="#fff1dc" />
      <directionalLight
        position={[-1.4, 2.4, 4.2]}
        intensity={1.7}
        color="#fff4e4"
        castShadow
        shadow-mapSize={mobile ? [1024, 1024] : [2048, 2048]}
        shadow-camera-left={-3}
        shadow-camera-right={3}
        shadow-camera-top={1}
        shadow-camera-bottom={-2.5}
        shadow-camera-near={0.5}
        shadow-camera-far={10}
        shadow-radius={8}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
      />
      <mesh ref={rail} position={[0, -0.011, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[0.011, 0.011, 40, 20]} />
        <meshStandardMaterial color="#c9a46a" metalness={1} roughness={0.3} transparent />
      </mesh>
      <mesh ref={wall} position={[0, -1.5, -0.2]} receiveShadow>
        <planeGeometry args={[40, 6]} />
        <shadowMaterial opacity={0.1} />
      </mesh>
      {products.map((p, i) => (
        <Garment key={p.id} index={i} placeholder={placeholder} model={models[p.kind] ?? null} sim={sim} />
      ))}
    </>
  )
}

export default function RackScene() {
  return (
    <Canvas
      className="scene"
      frameloop="demand"
      dpr={[1, 2]}
      shadows="percentage"
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      camera={{ fov: FOV, near: 0.1, far: 40, position: [0, -0.5, 6] }}
      onCreated={({ gl }) => {
        gl.setClearColor(0x000000, 0)
        gl.toneMapping = THREE.NeutralToneMapping
        gl.toneMappingExposure = 1
      }}
    >
      <SceneContent />
    </Canvas>
  )
}
