# Hanger Club

可交互衣架式服装展示网站（私有演示）。拖动横杆浏览，点一下把衣服从横杆上取下近看，拖动旋转，左右换款，下拉或 CLOSE 挂回去。

目标体验参考 Motionary 的 clothing-rack 手机演示。最初的 SVG 原型保留在 `legacy-svg/`，交接背景见 `开发交接文档.md`。

## 运行

需要 Node 20.19+。

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 单元测试（购物袋、弹簧、手势、路径）
npm run build      # 类型检查 + 构建到 dist/
```

`dist/` 是构建产物（已 gitignore），对应 `.openai/hosting.json` 的静态目录。发布到 Sites 前先 `npm run build`。

## 结构

```text
src/
  data/products.ts    商品数据（演示用）
  state/bag.ts        购物袋：稳定商品 ID、同款同码合并、版本化存储与校验
  state/store.ts      UI 状态（当前款、模式、尺码、购物袋、面板）
  motion/rig.ts       运动控制器：拖动、弹簧吸附、取下/近看/换款/归位状态机、钟摆与衣摆滞后
  motion/path.ts      取下与归位路径（与 docs/asset-spec.md §4.2 一致）
  motion/spring.ts    固定子步长弹簧与钟摆积分
  motion/gesture.ts   方向锁定、橡皮筋边界、松手目标、速度估计
  scene/RackScene.tsx Three.js 场景（React Three Fiber），按需渲染
  scene/geometry.ts   占位 T 恤与衣架几何体
  scene/materials.ts  布料材质（顶点着色器做衣摆滞后与转身外甩）与占位贴图
  scene/framing.ts    手机/桌面镜头取景
  ui/                 购物袋、INDEX 面板、SVG 缩略图
docs/asset-spec.md    Blender 资产与网页之间的契约
docs/codex-blender-prompt.md  给 Codex 的建模任务
tools/web/extract_placeholders.py  从商品照片生成占位印花
assets-src/photos/    商品照片（LFS）
```

## 现状与已知限制

- **衣服是占位模型。** 由代码生成的"枕头形"T 恤加简单褶皱，不是布料模拟。印花是从照片里粗略抠出来的占位贴图。真实网格与烘焙动画由 Blender 管线制作（见 `docs/`），交付后替换。
- 衣摆滞后、转身外甩、钟摆摆动都是实时近似，不是真实布料物理；烘焙的 `lift` / `return` 形变动画尚未接入。
- 近看时邻居衣服是滑出画面，没有做视频里的景深模糊。
- 没有 WebGL 时退化为平面 SVG 展示，尺码和购物袋仍可用。
- 已在桌面 Chrome（无头模式，含模拟触摸）上验证 390、768、1440 宽度；尚未在真机 iOS Safari / Android 上测试，也没有测帧率。
- **授权：** 商品照片是第三方品牌（Fear of God / Essentials、NBA、MLB）的商品图，仅用于私有演示。公开上线或卖货前必须全部替换。不接真实支付。
