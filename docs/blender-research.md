# 布料与目标视频对照

## 本地视觉目标

项目拥有者于 2026-10-12 指定 `example_video.mp4` 为目标。已读取本机原视频：27.15 秒、1860 × 1860、120 fps。
视频及提取帧仅用于本地对照，位于忽略目录 `assets-src/reference-local/`，不纳入仓库发布资产。

- 约 0–7 秒：衣架横向浏览，相邻款接近侧面，中心款转正；前后片保持体积，衣摆有轻微滞后。
- 约 7–9 秒：绿色上衣升钩、离杆、转身并进入近看；主体保持完整，变形幅度有限。
- 约 10–11 秒：归位，邻居恢复排列。
- 约 15–17 秒：黑色短袖近看，圆领、自然落肩、平顺主体、纵向宽褶皱、卷边袖口和下摆。
- 约 17–20 秒：近看换款与白色短袖取放，衣服仍保持原有版型。

静态验收应优先关注主体平顺、圆领、侧面体积与适量褶皱；不以增加皱褶数量为目标。
视频只能提供视觉目标，不能据此断言其内部求解器、模型拓扑或烘焙方式。

## 资料与采用的结论

1. [Blender 官方 Cloth Shape](https://docs.blender.org/manual/en/latest/physics/cloth/settings/shape.html)：缝合可以用连接版片边界的无面边作为 sewing springs；静止形状与预垂落形状应区分。用于检查版片与物理约束的关系。
2. [Blender 官方物理属性](https://docs.blender.org/manual/en/5.3/physics/cloth/settings/physical_properties.html)：张力、压缩、剪切、弯曲与各自阻尼需分别控制。参数先用于视觉匹配，不能仅凭数值宣称布料已物理标定。
3. [Blender ClothSettings API](https://docs.staging.blender.org/api/current/bpy.types.ClothSettings.html) 与 [Blender 求解器源码](https://github.com/blender/blender/blob/main/source/blender/blenkernel/intern/cloth.cc)：`mass` 分配到每个顶点，不能直接当作 kg/m²。
4. [Garment Tool 作者工作流](https://joseconseco.github.io/GarmentToolDocs/quick_guide/)：版片、缝合、模拟、shape key 烘焙分开；用于组织管线，没有复制其模型、代码或素材。
5. [Reactive In-Air Clothing Manipulation，附录 7.1](https://mhtippur.github.io/inairclothmanipulation/static/pdfs/CoRL2025_InAirReactiveManipulation.pdf)：研究者公开了 Blender 衣服数据生成的网格、步数及刚度范围。作为独立交叉检查，不能把论文参数直接当作本项目的已校准参数。

## 已拒绝的实验

原型探索曾同时改变多个变量，造成测试输出覆盖，已改为独立目录 `assets-src/experiments/<name>/`。
这些实验不作为交付资产，也不推送其失败渲染。

- 按目标克重换算顶点质量的实验，在当前网格/约束下出现过度皱缩及持续抖动。
- 平铺 rest shape 实验发现当前 Blender 创建形变键时默认权重为 1；未归零会改变起始装配姿态。已显式归零并增加起始坐标一致性断言。
- 分离版片 sewing springs 实验尚未得到稳定、符合目标的垂落，不能声称通过验收。
- 恢复匹配版片边界、模拟前缝合的稳定基线；`baseline` 参数是视觉调节值，报告必须标注未完成物理标定，不能把每顶点质量冒充克重。

后续仅将通过视觉与结构检查的输出提升为正式资产。

## 根据「太皱皱巴巴」反馈的调整

用户看到 GLB 预览后要求进一步减少细碎褶皱。当前选定 `smooth-volume`：主体保留宽浅纵向起伏，肩颈和袖子使用分区静止形状约束。
领口罗纹改为沿椭圆法线内收；袖口按平铺宽等于周长一半换算，避免张得过宽。
模拟前固定三角划分，避免非平面四边形内外层使用不同对角线后相交。
肩部前后片在装配时更早撑开，避免约束的静止形状和大面片跨进衣架木身。
67 个采样姿态的衣架顶点/面中心穿透及非相邻表面交叉检查通过；外观仍为可供检查的迭代版本，不能视作用户已验收。
高密度肩部排布和增大碰撞余量的尝试产生新的皱缩，已拒绝，没有提升为正式文件。

用户随后指出该版本过平、肩部难看，`smooth-volume` 的视觉方案已被替代。选定后续 `reference-detail`：
肩袖从直线改为连续圆弧过渡，领口从 24 增至 40 段，单层网格 4,442 顶点。
减小全衣约束，分别控制肩颈和袖子；把宽浅纵褶集中到衣身两侧，保留中央印花区域。
下摆有轻微悬垂弧度与卷边，Normal 沿真实肩颈 UV 边界布置缝线，并加入袖口/下摆双排细节。
该版同样通过 67 帧采样几何检查。保留全部拒绝理由，不能把数值通过当作用户认可外观。
