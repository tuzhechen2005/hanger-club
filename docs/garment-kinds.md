# 衣服类型：接入一种新衣服

本文写给以后要往横杆上加新衣服类型的人，可能是你、Codex 或者 Claude。动态的原理和参数见 `docs/cloth-motion.md`；本文只写从找照片到上架的步骤。2026-10-13 用这套流程一次加了五种：长袖、卫衣、冲锋衣、裙子和裤子。

## 现有的衣服类型

| kind | 衣架 | 版片（`tools/blender`） | 布料预设 | 细节贴图（`details`） |
|---|---|---|---|---|
| tee | 木衣架 | `build_tee.py`（五片） | `JERSEY_TEE` | 照片印花 |
| longsleeve | 木衣架 | `build_garment.py` 上装 | `LONGSLEEVE_JERSEY` | 罗纹袖口、下摆 |
| hoodie | 木衣架 | 上装 + 帽兜 | `FLEECE_HOODIE` | 袋鼠兜、抽绳、罗纹 |
| shell | 木衣架 | 上装 + 帽兜，更长 | `NYLON_SHELL` | 拉链、带盖口袋、抽绳 |
| skirt | 夹式衣架 | `build_garment.py` 下装 | `DENIM_SKIRT` | 宽皮带、方扣、口袋 |
| pants | 夹式衣架 | 下装 + 两条裤腿 | `TROUSERS` | 牛仔明线（jeans）或侧条纹（track） |

## 步骤

### 1. 找照片

- **优先用可自由使用的照片**。Unsplash 和 Pexels 拒绝脚本下载，Wikimedia Commons 有开放接口，可以先看这两个分类：`Category:Clothing on white background`、`Category:Colour isolated photographs of clothing`。
- 下载原图到 `assets-src/photos/<slug>-front.jpg`。作者、授权、出处写进 `assets-src/photos/credits.json`。CC BY 和 CC BY-SA 要求署名，商品数据里的 `credit` 会显示在原图下方。
- 品牌商品照片只能用于私有演示，见 `docs/asset-spec.md` §5。

### 2. 抠图

```bash
python tools/web/export_photos.py
```

- 纯色背景会自动抠掉。背景是墙面、床单、渐变或者带文字条的，在 `assets-src/photos/cutout.json` 里给提示：
  - `crop`：先裁掉的区域；
  - `grabcut`：用前景分割代替颜色抠图；
  - `drop_light`：再去掉浅色、低饱和的像素，比如衣服下面的床单；
  - `keep_light`：保护某个区域里的浅色，比如白色毛领；
  - `erode`：把蒙版往里收，去掉原图自带的白描边。
- 输出 `public/products/<slug>/photo-front.webp`（透明背景，衣服居中，大小统一）和 `photos.json`（衣服在方块里的位置，原图显影时用它对齐 3D 衣服）。
- 新商品的面料颜色取抠图后衣服的中位色，写进 `public/products/<slug>/placeholder.json`（已有的不覆盖，T 恤的这个文件里还有印花位置）。

### 3. 版片和垂坠（Blender）

如果是已有的 kind，跳过这一步。新的 kind 要在 `tools/blender/build_garment.py` 的 `KINDS` 里加一项：

- 平铺尺寸（米），以及 `family`：`top` 挂在木衣架上，`bottom` 夹在夹式衣架上。
- 上装：`sleeve_angle` 是袖子相对竖直方向的初始角度，可以加 `hood`。
- 下装：有 `rise_m` 就会长出两条裤腿。

版片是前后两片网格，坐标重合的顶点自动焊在一起，形成侧缝、内缝和帽兜的折边。起始形状按挂好的样子摆，只固定衣架真正承托的部位（木衣架上的肩缝、夹子里的腰头），其余部分交给重力。

```bash
B=/Applications/Blender.app/Contents/MacOS/Blender
$B -b --factory-startup --python-exit-code 1 -P tools/blender/build_garment.py -- --kind hoodie
python tools/blender/make_garment_maps.py --kind hoodie        # 针织和缝线法线
$B -b --factory-startup --python-exit-code 1 -P tools/blender/bake_clips.py -- --kind hoodie
$B -b --factory-startup --python-exit-code 1 -P tools/blender/audit_geometry.py -- \
  --source assets-src/blender/hoodie_animated.blend --samples assets-src/blender/hoodie_clip_samples.npz \
  --report assets-src/reports/hoodie/geometry-audit.json
npm run models
```

每一步约 1 分钟，几种衣服可以并行跑。检查图在 `assets-src/reports/<kind>/`，看正面、背面和侧面。

### 4. 这次踩过的坑

| 现象 | 原因 | 做法 |
|---|---|---|
| 长袖一前一后甩开，侧面厚 41 cm | 长袖垂得直，整形约束不够 | `sleeve_support` 2.2（短袖 0.8）；`sleeve_angle` 6° |
| 帽子像背包，或者从侧面翻出来 | 只在底部对折，两侧开口 | 帽兜做成小口袋：内层缝在后领口，外层是帽口，两侧和底部焊合 |
| 帽子缝线处留有交叉 | 帽子一离开领口就平贴后背，形成零半径折痕 | 起步先立起 5 cm 再往下垂；帽根约束更强；缝线两侧加弯曲刚度 |
| 帽根压进木衣架 2–5 mm | 领口两角正好在木头上，五条缝汇在那里 | 帽子缝线从领口两角往里收 3 格；松弛折痕时把布料推出衣架（`ShellProbe(collider=…)`） |
| 夹子里的腰头穿进夹片 | 夹片间隙比 2 mm 布料的双层还窄 | 夹片间隙 10 mm |

几何检查的标准是"衣架穿透 0、交叉 0"。目前的遗留：卫衣在取下动画的 15 帧里，衣架末端最多擦到 1.3 mm；冲锋衣的肩部有一个点擦到 0.2 mm。肉眼看不出。

### 5. 网页

1. `src/data/products.ts`：加商品，填 `kind`、`weave`（knit、fleece、denim、nylon）、`details`、`credit`。
2. 新的 kind 要做三件事：
   - 在 `Kind` 和 `KINDS` 里登记；
   - 在 `clothProxy.ts` 的 `PROFILES` 里加一组布料参数；
   - 在 `products.ts` 的 `SIZE_M` 里填尺码（M 码就是版片尺寸）。
3. 细节贴图在 `src/scene/details.ts` 里画。坐标用衣服本身的尺寸：横向是离中线的米数，纵向是离上边缘的米数。脚本会按 kind 的 UV 布局放到正确位置。
4. 验收：

```bash
npm test
PIECE=<横杆序号> npm run cloth:check
```

然后截图看浏览、近看和原图显影。原图显影要和 3D 衣服大致对齐，`photos.json` 的衣服框会自动处理。

## 做不到的事

- 帽兜从正面看只露出很少一点，正面主要靠抽绳认出是卫衣。
- 照片上的印花、图案（比如卫衣上的字、长袖上的徽章）没有画到 3D 上，只有 T 恤用照片抠出了印花。
- 每种 kind 只有一套版片，同类的不同款式（比如阔腿裤、直筒裤）共用一个版型。
