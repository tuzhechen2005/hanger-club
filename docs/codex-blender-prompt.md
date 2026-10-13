# 给 Codex 的 Blender 建模任务（第 1 轮：衣架 + 第一件短袖 T 恤）

把下面分隔线之间的内容整段发给游戏本上的 Codex。第一件样衣是 `shirt3`（正反面都有、1024 像素、纯色底只有小胶标，最适合先验证流程）。

---

你在一台装有 Blender 的 Windows 电脑上工作。任务是为 Hanger Club 网站制作网页实时渲染用的 3D 衣服资产。网页用 Three.js 加载 glTF，衣服挂在一根横杆上，可以被取下、旋转、再挂回去。

## 准备

1. 克隆仓库 `https://github.com/tuzhechen2005/hanger-club`，确认 Git LFS 已启用（`git lfs install`）。
2. **先完整阅读 `docs/asset-spec.md`。** 它是网页与资产之间的契约：单位、原点、朝向、节点名、材质槽、UV 布局、动画名和路径都以它为准，网页代码已经按它编写。规格里有做不到或自相矛盾的地方，停下来说明原因并提出修改建议，不要自行改变约定。
3. 找到本机的 Blender（通常在 `C:\Program Files\Blender Foundation\` 下），记录版本号。需要 4.2 或更新。

## 工作方式

- 所有建模、模拟、烘焙、导出都写成 Python 脚本，放在 `tools/blender/`，用 `blender -b -P <脚本> -- <参数>` 在后台运行。不要依赖手动在界面里操作的步骤。目标是以后换一张照片、换一组尺寸就能重新跑出新衣服。
- 脚本可以分成：`build_hanger.py`、`build_tee.py`（版片、缝合、垂落模拟）、`bake_clips.py`（`lift` / `return` 动画）、`make_product_texture.py`（照片到贴图）、`render_checks.py`（验收渲染）。按需调整，但要在 `tools/blender/README.md` 写清楚运行顺序、参数和每一步的耗时。
- 路径一律用 `pathlib`，不要写死本机的绝对路径。
- `.blend` 源文件存到 `assets-src/blender/`（走 LFS）。

## 本轮要交付的东西

1. `public/models/hanger.glb`：规格第 2 节。
2. `public/models/tee.glb` 和 `public/models/tee_anim.glb`，以及 `public/models/tee_uv_layout.json`：规格第 3、4 节。
   - 版型：用缝纫版片（前片、后片、两袖、领口罗纹）缝合后挂到衣架上做布料模拟，得到自然垂落，不要直接雕刻成一个实心的衣服形状。
   - 模拟前就把网格定到最终密度。模拟后不得减面、重拓扑或细分，否则形变目标会对不上。
   - 布料参数按中等克重的纯棉针织（约 180–220 g/m²）来调：垂坠，但不像丝绸那样飘。
3. `public/products/shirt3/`：用 `assets-src/photos/shirt3-front.webp`、`shirt3-back.webp` 生成的 `basecolor.png`、`print_front.png`、`print_back.png`、`product.json`，按规格第 5 节。版型参考 `assets-src/photos/` 里所有照片：它们都是同一类 oversize boxy 落肩 T 恤，用来校准规格第 3.1 节的默认尺寸、肩线位置和袖子角度。
   - 照片里平铺的褶皱、阴影、反光都不能进贴图。底色取纯色，印花单独抠出来，布料质感交给共享的法线贴图。
   - 抠印花没把握时停下来，把中间结果给我看，不要编造图案。
4. 验收材料 `assets-src/reports/`：规格第 6 节列出的渲染、动画拼图、重新导入后的渲染、`report.json`，以及自检清单的逐项结果。

## 质量要求

- 衣服是网站的主角，近看要经得起：领口、袖口、下摆有厚度和卷边，肩缝、侧缝能看出来，衣服在衣架肩部自然撑起，前后片自然下垂、有真实的褶皱。
- 侧面不能是一张没有厚度的片；正面、侧面、背面都要有合理的结构。
- 背面的文字不能是镜像；印花要随布料曲面变化。
- 衣服与衣架不能互相穿透。`lift` 的转身阶段允许布料明显甩开，但不能自相交得很明显。
- 模型、布料纹理、HDRI 等资产全部自制，或者使用许可明确的素材，并在 `report.json` 里记录来源。商品照片由项目拥有者提供，授权限制见规格第 5 节。

## 汇报方式

在分支 `assets/tee-v1` 上工作，不要直接推 `main`（网页代码同时在 `main` 上开发）。只改 `tools/blender/`、`assets-src/`、`public/models/`、`public/products/shirt3/` 下的文件。每完成一步（衣架、垂落、动画、贴图），提交并推送一次，提交信息写清楚做了什么。最后的汇报请包括：

- 实际运行了哪些命令、各花了多久；
- 自检清单逐项的结果；
- 渲染图的路径；
- 与规格有出入的地方和原因；
- 已知问题，以及你建议下一轮改什么。

做不到的就直接说做不到，不要把占位资产说成完成品。

---

## 发送前确认

- [ ] 仓库已推送到 GitHub，游戏本能访问，并已登录有权限的 GitHub 账号
- [ ] 如果量了尺寸，写成 `assets-src/photos/shirt3-measurements.json`，例如 `{"length_m":0.70,"chest_flat_m":0.62,"shoulder_m":0.60,"sleeve_m":0.24}`

第一轮通过之后，剩下 5 件（shirt2、shirt4–7）共用同一套网格和动画，只需要让 Codex 运行 `make_product_texture.py` 生成贴图。
