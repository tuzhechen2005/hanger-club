# Hanger Club

可交互衣架式服装展示网站（私有演示）。拖动横杆浏览，点一下把衣服从横杆上取下近看，拖动旋转，左右换款，下拉或 CLOSE 挂回去。

目标体验参考 Motionary 的 clothing-rack 手机演示。最初的 SVG 原型保留在 `legacy-svg/`，交接背景见 `开发交接文档.md`。

## 运行

需要 Node 20.19+。

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 单元测试（购物袋、弹簧、手势、路径）
npm run build      # 类型检查 + 构建到 dist/（会去掉网页用不到的原始 GLB 和 PNG 贴图）
npm run models     # Blender 导出更新后，重新生成网页用的压缩模型 public/models/web/
npm run cloth:check  # 开着 dev 服务器时，测量布料动态是否达标（需要本机 Chrome）
```

Blender 资产管线见 `tools/blender/README.md`，资产规格见 `docs/asset-spec.md`。
衣服动态的方法论、参数和验收标准见 `docs/cloth-motion.md`，接入新衣服时按它走。

`dist/` 是构建产物（已 gitignore），对应 `.openai/hosting.json` 的静态目录。发布到 Sites 前先 `npm run build`。

## 结构

```text
src/
  data/products.ts    商品数据（演示用）
  state/bag.ts        购物袋：稳定商品 ID、同款同码合并、版本化存储与校验
  state/store.ts      UI 状态（当前款、模式、尺码、购物袋、面板）
  motion/rig.ts       运动控制器：拖动、弹簧吸附、取下/近看/换款/归位状态机、衣架钟摆
  motion/path.ts      取下与归位路径（与 docs/asset-spec.md §4.2 一致）
  motion/spring.ts    固定子步长弹簧与钟摆积分
  motion/gesture.ts   方向锁定、橡皮筋边界、松手目标、速度估计
  scene/RackScene.tsx Three.js 场景（React Three Fiber），按需渲染
  scene/models.ts     加载 Blender 模型：先静态 tee.glb，再后台加载带布料动画的 tee_anim.glb
  scene/clothProxy.ts 实时布料：每件衣服约 380 个粒子的代理，自碰撞与衣服之间碰撞，GPU 上驱动高精度网格
  scene/geometry.ts   模型加载完成前显示的程序化占位 T 恤与衣架
  scene/materials.ts  布料材质（顶点着色器按代理偏移变形，并转动法线和阴影）与商品贴图
  scene/uvLayout.ts   读取 Blender 导出的 UV 布局，用于按实际尺寸放置印花
  scene/framing.ts    手机/桌面镜头取景
  ui/                 购物袋、INDEX 面板、SVG 缩略图
docs/asset-spec.md    Blender 资产与网页之间的契约
docs/cloth-motion.md  衣服动态方法论：三层分工、接入步骤、参数、调参与验收
tools/web/cloth-check.mjs  布料动态验收测量
docs/codex-blender-prompt.md  给 Codex 的建模任务
tools/web/extract_placeholders.py  从商品照片生成占位印花
assets-src/photos/    商品照片（LFS）
```

## 现状与已知限制

- **衣服模型**：来自 Blender 管线，6 款共用同一件 T 恤的网格。网页先加载 458 KB 的静态模型；带 66 帧布料形变的动画模型（2.2 MB）在后台加载，加载好后，取下和挂回会播放烘焙的布料动画。模型加载前、或者加载失败时，显示代码生成的占位 T 恤。
- **商品贴图**：只有 shirt3（Wood Label Tee）用的是管线做好的贴图，其余 5 款是浏览器里用照片粗略抠出的印花拼成的，仍是占位。
- **动态**：
  - 取下和挂回播放 Blender 烘焙的布料动画。
  - 实时物理一直在运行，取下和挂回时也在烘焙动画上叠加惯性。衣架绕挂钩摆动，阻尼很大。每件衣服有一套约 380 个粒子的布料代理：压在衣架上的部分固定，越往下越软，按层保持形状，所以晃起来像一件缝好的衣服而不是果冻。前后片之间、衣服之间都会碰撞。货架上的排版转身只传 30% 的惯性；拿起转圈、近看拖转是真实动作，惯性全额传递。滑动后约 1.3 秒、拖转后约 0.7 秒停下，停下后不再渲染。
  - 布料代理比渲染网格粗得多，会产生滞后、摆动和接触挤压，但出不了细小褶皱。M4 上每帧约 2.6 ms，手机预计会更慢，还没在真机上测。参数与验收数字见 `docs/cloth-motion.md`。
- **模型已知问题**：见 `docs/blender-research.md`。领口一侧有小尖角。袖子往前伸的问题已经修好：现在左右对称，侧面厚度约 15 cm。
- **视觉**：近看时邻居衣服只是滑出画面，没有视频里的景深模糊。
- **兼容性**：没有 WebGL、或者 3D 场景出错时，退化为平面 SVG 展示，尺码和购物袋仍可用。
- **测试范围**：只在桌面 Chrome 无头模式（含模拟触摸）上测过 390、768、1440 三种宽度。没在真机 iOS Safari / Android 上测过，也没测帧率。
- **授权**：商品照片是第三方品牌（Fear of God / Essentials、NBA、MLB）的商品图，仅用于私有演示。公开上线或卖货前必须全部替换。不接真实支付。
