# Blender 资产管线

契约：`docs/asset-spec.md`；任务：`docs/codex-blender-prompt.md`。
本轮使用 Blender 5.2.1 LTS，分支 `codex/blender-assets`。目标视频观察、资料与实验记录见 `docs/blender-research.md`。

## 运行顺序

在仓库根目录运行。`blender` 替换为本机可执行文件；`python` 需要 Pillow、NumPy。
路径由 `pathlib` 根据脚本位置推导，不依赖机器绝对路径。

```powershell
blender -b --factory-startup --python-exit-code 1 -P tools/blender/preflight.py
blender -b --factory-startup --python-exit-code 1 -P tools/blender/build_hanger.py
blender -b --factory-startup --python-exit-code 1 -P tools/blender/build_tee.py -- --frames 73 --bend 0.25 --drape-support 0.33
python tools/blender/make_product_texture.py --slug shirt3
blender -b --factory-startup --python-exit-code 1 -P tools/blender/bake_clips.py -- --warmup 73 --motion-support 0.80
python tools/blender/validate_assets.py
blender -b --factory-startup --python-exit-code 1 -P tools/blender/audit_geometry.py
blender -b --factory-startup --python-exit-code 1 -P tools/blender/render_checks.py
python tools/blender/compose_reports.py
python tools/blender/make_report.py
```

每步实际耗时、命令、逐项结果与已知问题汇总在 `assets-src/reports/tee/report.json` 和 `checklist.md`。
脚本内部耗时包含自身渲染。改变版型后必须重新生成贴图、动画和验收材料。

## 网格与模拟

默认尺寸来自契约；`assets-src/photos/<slug>-measurements.json` 可覆盖默认值。
前片、后片、两袖、领口五个参数化版片按匹配边界顶点在模拟前连接。
单层 4,442 顶点；模拟前锁定三角划分，模拟后只用固定拓扑的 2 mm Solidify。
`tee_patterns.blend` 为装配状态，`tee_simulation.blend` 保留模拟设置，`tee_drape.blend` 保留单层垂落结果与未应用的 Solidify。
肩部初始网格根据实际衣架拟合顶点间距，并加快前后片撑开，避免大面片跨过木身；不增加模拟后的顶点。
袖口平铺宽按组装开口周长的一半换算。

用户视频要求平顺主体、少量宽浅纵褶。当前用软静止形状约束保持版型，肩部、领口与袖子分别控制。
肩袖采用连续圆弧过渡，主要宽褶集中于衣身两侧，中央留出较平顺的印花区；领口增加分段，正常网格中的袖口/下摆做卷边。
共享 Normal 追踪真实肩颈 UV 边界，并增加袖口和下摆双排缝线。检查图另外包含领口、袖口、下摆近景。
这些约束服务于视觉目标，**没有完成 180–220 g/m² 的物理标定**，不能把求解器质量参数当作克重。
`--profile sewn` 是未通过验收的 sewing-springs 实验，不能用于正式输出。

## 动画与材质

预跑 72 帧，再连续模拟 lift 36 帧、return 30 帧。67 个样本对应基础姿态加 66 个形变目标。
`HookPivot` 携带位移和完整转动，形变保存在衣架局部坐标中。两个 NLA 动画各从 0 秒开始导出。
return 起始与 lift 结束共用同一样本；return 结束与基础网格的残差记录在报告中。
静态文件从实际动画 GLB 去掉动画和形变数据，基础属性、索引逐项比较一致。
2048²共享 Normal/ORM 嵌入 GLB，AO 在静止垂落姿态烘焙；商品 basecolor 保持外置。

shirt3 胶标保留原照片像素，不重画文字或商标；底色取布料区域中位色，背面为纯色。
照片布料褶皱不进入底色，针织与缝线由自制 Normal 提供。
胶标源图约 84 像素宽，印花位置按照片地标和默认尺寸估算，缺少实测数据。
新商品使用 `make_product_texture.py --slug <slug> --config <JSON>`，需要先检查照片地标；无法可靠分离时脚本报错。
照片的授权范围是私有仓库和私有演示，见 `product.json`。

## 实验与验收

给 `build_tee.py` 添加 `--experiment NAME` 可隔离输出。对应动画使用：

```powershell
blender -b --factory-startup --python-exit-code 1 -P tools/blender/bake_clips.py -- --source assets-src/experiments/NAME/blender/tee_drape.blend --experiment NAME
```

实验目录被 Git 忽略；失败结果不提升为正式资产。动画实验会重烘共享 ORM，正式输出前应从选定模型重新烘焙。
`validate_assets.py` 检查实际 GLB 的拓扑、预算、节点、材质、贴图、朝向、UV、时长与切换连续性。
`audit_geometry.py` 检查 67 个姿态的顶点/三角形中心衣架穿透和非相邻三角形交叉；不覆盖连续时间的所有姿态、相邻面或共面接触。
六视图、每四帧动画拼图、全新场景重新导入 GLB 的渲染在 `assets-src/reports/tee/`。数值检查不能代替视觉验收。

```powershell
python -m http.server 8765 --bind 127.0.0.1
```

打开 `http://127.0.0.1:8765/tools/blender/preview.html` 查看实际 GLB，拖动旋转、播放或拖动动画。
`?trial=NAME` 查看本地实验。检查页从 jsDelivr 加载与项目相同版本 Three.js，模型和商品贴图在本机加载。
当前仓库没有 `src/` 页面实现，本轮提供资产和检查工具，尚未集成商店界面。
