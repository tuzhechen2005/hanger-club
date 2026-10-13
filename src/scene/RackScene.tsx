import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { products } from '../data/products'
import { rig } from '../motion/rig'
import { computeFraming, FOV } from './framing'
import { createHangerGeometry, createTeeGeometry } from './geometry'
import { createFabricMaterials, createGarmentTexture, patchCloth, type ClothUniforms } from './materials'
import { useGarmentModel, type GarmentModel } from './models'
import type { Product } from '../data/products'

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
  const uniforms = meshes.map((mesh) => {
    const isInner = (mesh.material as THREE.Material).name === 'FabricInner'
    mesh.material = isInner ? inner : outer
    mesh.updateMatrix()
    const toPivot = mesh === cloth ? cloth.matrix.clone() : cloth.matrix.clone().multiply(mesh.matrix)
    return patchCloth(mesh.material as THREE.Material, toPivot)
  })
  return { hook: model.hook.clone(), wood: model.wood.clone(), cloth, meshes, uniforms, materials: [outer, inner] }
}

function fromPlaceholder(assets: PlaceholderAssets, product: Product, map: THREE.Texture): GarmentParts {
  const { outer } = createFabricMaterials(map, product)
  const cloth = new THREE.Mesh(assets.tee, outer)
  return {
    hook: new THREE.Mesh(assets.hanger.hook, assets.metal),
    wood: new THREE.Mesh(assets.hanger.wood, assets.wood),
    cloth,
    meshes: [cloth],
    uniforms: [patchCloth(outer)],
    materials: [outer],
  }
}

function Garment({ index, placeholder, model }: { index: number; placeholder: PlaceholderAssets; model: GarmentModel | null }) {
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
    for (const part of [parts.hook, parts.wood, parts.cloth]) part.traverse((o) => (o.castShadow = true))
    for (const mesh of parts.meshes) mesh.userData.index = index
    registry[index] = { slot: slot.current, swing: swing.current, spin: spin.current, body: body.current, meshes: parts.meshes, uniforms: parts.uniforms }
    invalidate()
    return () => parts.materials.forEach((m) => m.dispose())
  }, [index, parts, invalidate])

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

function Driver({ rail, wall }: { rail: React.RefObject<THREE.Mesh | null>; wall: React.RefObject<THREE.Mesh | null> }) {
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

  const framing = useMemo(() => computeFraming(size.width / size.height), [size.width, size.height])

  useEffect(() => {
    rig.aspect = size.width / size.height
    rig.pxPerItem = (0.56 / framing.browseWidth) * size.width * 1.15
    rig.pxPerRadian = (Math.min(size.width, 520) * 0.62) / Math.PI
    const root = document.documentElement.style
    root.setProperty('--browse-info-top', `${(framing.browseInfo * 100).toFixed(2)}%`)
    root.setProperty('--inspect-info-top', `${(framing.inspectInfo * 100).toFixed(2)}%`)
    invalidate()
  }, [framing, size.width, size.height, invalidate])

  useFrame((_, dt) => {
    const moving = rig.step(dt)
    const b = rig.blend
    const { browse, inspect } = framing
    camera.position.set(0, browse.cameraY + (inspect.cameraY - browse.cameraY) * b, browse.cameraZ + (inspect.cameraZ - browse.cameraZ) * b)
    camera.lookAt(0, camera.position.y, 0)

    registry.forEach((g, i) => {
      if (!g) return
      const p = rig.poses[i]
      g.slot.position.set(p.x, p.y, p.z)
      g.swing.rotation.set(p.swingX, 0, p.swingZ)
      g.spin.rotation.y = p.spin
      g.body.rotation.y = p.rackYaw
      for (const u of g.uniforms) {
        u.uBend.value.set(p.bendX, p.bendZ)
        u.uFlare.value = p.flare
        u.uTwist.value = p.twist
      }
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
    if (moving) invalidate()
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
  const model = useGarmentModel()
  useEffect(() => {
    rig.bakedClips = !!model?.animated
    rig.invalidate()
  }, [model])
  const rail = useRef<THREE.Mesh>(null)
  const wall = useRef<THREE.Mesh>(null)
  const mobile = typeof window !== 'undefined' && window.matchMedia('(max-width: 700px)').matches
  return (
    <>
      <Driver rail={rail} wall={wall} />
      <Environment />
      <hemisphereLight args={['#fffdf6', '#c9c2b4', 0.7]} />
      <directionalLight
        position={[-0.7, 2.2, 4.5]}
        intensity={1.5}
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
        <meshStandardMaterial color="#c8c8c2" metalness={1} roughness={0.25} transparent />
      </mesh>
      <mesh ref={wall} position={[0, -1.5, -0.2]} receiveShadow>
        <planeGeometry args={[40, 6]} />
        <shadowMaterial opacity={0.1} />
      </mesh>
      {products.map((p, i) => (
        <Garment key={p.id} index={i} placeholder={placeholder} model={model} />
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
