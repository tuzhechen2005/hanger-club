# Hanger Club：交接（2026-10-13）

本文写给接手的新会话。项目背景、原始需求和 Codex 时期的情况见 `开发交接文档.md`，那份文档已过时：它描述的是早期的 SVG 原型。现状以本文为准。

## 一句话现状

可交互的衣架式服装展示网站，目前只做私有演示。12 件衣服，6 种类型，都在 Blender 里建模并做了重力垂坠，网页上有实时布料物理。视觉概念叫"Cloakroom Nº 1"（俱乐部衣帽间）。取下衣服转圈时，3D 衣服会"显影"成商品原图。

## 用户与约定

- **语言**：用中文回复。用户会直接说"太丑了""太晃"这类感受，需要先找出原因，再说明怎么改。
- **动态要符合自然物理**：不穿模；不能像固体，也不能像果冻；不要在着色器里伪造效果。见 memory `feedback-natural-physics`。
- **设计**：用户要求不要照抄示例视频（Motionary 的衣架演示），可以自由发挥；改版要开新分支。
- **授权**：
  - T 恤照片是品牌商品图（Fear of God / Essentials、NBA、MLB），只能用于私有演示，公开前必须全部替换。
  - 新增的 6 张照片来自 Wikimedia Commons，署名在 `assets-src/photos/credits.json`，页面上原图下方显示。
- **禁止事项**：不接真实支付；不改 Sites 的访问权限；不新建 Sites 项目替换现有项目（`.openai/hosting.json`）。用户邮箱只用于识别身份。
- **持久记忆**：在 `~/.claude/projects/-Users-tuzhechen-Documents-Codex-2026-10-12-kan-outputs-hanger-club/memory/`，新会话会自动加载。

## 分支（github.com/tuzhechen2005/hanger-club，私有）

| 分支 | 内容 | 状态 |
|---|---|---|
| `main` | React 网站、实时布料、方法论文档 | 稳定 |
| `redesign/atelier` | 在 main 上：新视觉"Cloakroom Nº 1"、版型改长（衣长 76 cm）、原图拍立得与显影转场 | 已推送，**未合并** |
| `feature/garment-types` | 在 redesign 上：长袖、卫衣、冲锋衣、裙子、裤子五种类型；多模型；每件衣服独立的布料参数 | 已推送，**当前分支，未合并** |
| `codex/blender-assets` | Codex 时期的 Blender 分支，已合并进 main | 检出在 git worktree `../hanger-club-blender` |

**等用户决定的事**
1. 两个分支是否合并进 main。上一轮回复里已经提议，用户还没回复。
2. 取下衣服时原图要不要每次都自动显影？可选：一直自动、只在第一次自动、显示 2–3 秒后自动溶解回 3D。这个问题问过，用户还没回答。

## 运行与检查

需要 Node 20.19+，以及本机 Chrome（检查脚本用 playwright-core 驱动系统 Chrome，不另外下载浏览器）。

```bash
npm install
npm run dev                         # http://127.0.0.1:5173
npx vite --port 5174 --host 0.0.0.0 # 给手机看：同一 Wi-Fi 下打开 http://<Mac 的局域网 IP>:5174/（ipconfig getifaddr en0）
npm test                            # vitest，31 个
npm run check:ui                    # 交互检查 24 项（需要 dev 服务器在跑）
npm run cloth:check                 # 布料验收 10 项，取下 0 号 T 恤
PIECE=4 npm run cloth:check         # 取下其他衣服，目标按类型（docs/cloth-motion.md §6）
npm run build                       # 类型检查 + 构建 dist/（约 17 MB），dist 是 Sites 的静态目录
npm run models                      # Blender 导出后重新压缩 public/models/web/
```

上一个会话在后台开着 5173 和 5174 两个 dev 服务器，会话结束后可能已经关了，需要重新启动。

## 资产管线（Blender 5.2.2 LTS，`/Applications/Blender.app/Contents/MacOS/Blender`）

- **Python 环境**：脚本需要 Python 3.10+ 以及 `tools/blender/requirements.txt` 里的依赖（Pillow、NumPy、OpenCV）。可以这样建：`python3.12 -m venv .venv && .venv/bin/pip install -r tools/blender/requirements.txt`。上一个会话的环境在临时目录里，已经不在了。
- 不要加 `-I` 参数，否则找不到同目录的模块。
- 在 zsh 里不要写 `$B args` 这类没加引号的变量，zsh 不会按空格拆分；写完整路径，或者用 `${=VAR}`。
- **T 恤**：`tools/blender/README.md` 的运行顺序（`build_tee.py` → 贴图 → `bake_clips.py` → 校验、几何检查、渲染）。
- **其他类型**：`build_garment.py --kind <kind>` → `make_garment_maps.py` → `bake_clips.py --kind` → `audit_geometry.py`（用参数指定文件），详见 `docs/garment-kinds.md`。每步约 1 分钟，可以并行。
- **照片**：`tools/web/export_photos.py`，抠图提示写在 `assets-src/photos/cutout.json`。
- 大文件（blend、glb、png、webp、npz）走 Git LFS。

## 代码地图

```text
src/App.tsx                 页面：寄存牌、刻度条、规格牌（尺码、尺寸、Claim）、键盘与焦点
src/ui/PhotoView.tsx        原图：从 3D 衣服或别针小照片处显影 → 拍立得 → 收回
src/ui/Sheets.tsx           购物袋（收据样式）、索引（照片寄存牌墙）
src/data/products.ts        商品数据：kind、weave、details、照片、尺码 measurements()
src/motion/rig.ts           运动控制：拖动、取下/近看/换款/挂回状态机、钟摆、惯性比例、远处衣服静止
src/scene/RackScene.tsx     场景：按类型加载模型、粒子结构、取景缓动、原图对齐用的 CSS 变量
src/scene/clothProxy.ts     实时布料（PBD）：按类型的面料参数 PROFILES、碰撞、形状保持、法线梯度
src/scene/models.ts         按类型加载 public/models/web/<kind>.glb 和 <kind>_anim.glb
src/scene/details.ts        在贴图上画结构细节：口袋、拉链、明线、皮带、条纹，以及面料纹理
src/scene/materials.ts      着色器补丁（布料偏移、法线、阴影、麻灰纹理）、各面料的表面参数
src/scene/framing.ts        按最长的衣服、当前这件的长度计算取景
tools/blender/              build_tee.py、build_garment.py、build_hanger.py（木衣架 / 夹式衣架）、bake_clips.py、shells.py、audit_geometry.py
tools/web/                  cloth-check.mjs、interaction-check.mjs、export_photos.py、optimize-models.sh、prune-dist.mjs
```

## 文档

- `docs/cloth-motion.md`：衣服动态方法论，包括三层分工、参数、症状与对应参数、验收标准、面料预设。改动态之前先读。
- `docs/garment-kinds.md`：新增衣服类型的步骤和踩过的坑。
- `docs/asset-spec.md`：Blender 与网页之间的契约，包括坐标、节点、动画路径、尺寸。
- `docs/blender-research.md`：Blender 调参记录，包括已经证实不可行的做法。

## 已知问题与可以接着做的事

- 卫衣和冲锋衣在几何检查里还有擦碰：卫衣在取下动画中擦到衣架末端，最多 1.3 mm；冲锋衣肩部有 0.2 mm。其余类型都是 0/0。
- 帽兜从正面几乎看不到；照片上的印花（卫衣上的字、长袖上的徽章）没有画到 3D 上。每种类型只有一个版型。
- 木衣架两端的肩角还有轻微鼓包（肩宽 58 cm、衣架 44 cm）。根治要把衣架加宽，需要重跑 T 恤的全流程。
- 没在真机上测过帧率。设备算不过来时会自动换成粗一档的粒子，只换一次。
- 首次加载约 17 MB 模型：先加载各类型的静态模型，动画模型逐个在后台加载。手机流量偏大，可以考虑按需加载。
- 只有 Wood Label Tee 用的是管线做好的贴图，其他 T 恤是照片粗略抠出的印花。
