# Blender 资产管线

任务入口：`docs/codex-blender-prompt.md`；资产契约：`docs/asset-spec.md`。
所有路径由脚本位置推导，脚本不依赖本机绝对路径。

## 已验证步骤

在仓库根目录，用本机 Blender 可执行文件运行：

```powershell
# 若 Blender 已在 PATH 中：
blender -b --factory-startup -P tools/blender/preflight.py
# 可选商品参数：
blender -b --factory-startup -P tools/blender/preflight.py -- --slug shirt3
```

`preflight.py` 检查 Blender ≥ 4.2、后台模式、布料接口、glTF 导入导出和照片解码。
输出 `assets-src/reports/preflight/report.json`，记录输入分辨率和脚本内耗时。
失败时抛出异常；自动化调用建议额外使用 Blender 参数 `--python-exit-code 1`。
它只检查环境，不代表模型或动画已通过验收。

## 当前状态与后续顺序

规格的挂钩原点存在矛盾，详见 `docs/blender-preflight.md`；等待确认后再开始生成几何。

后续计划依次实现衣架、缝纫版片与垂落、动态模拟与形变目标、商品贴图、导出后重新导入验收。
这些步骤目前尚未实现，没有可交付 GLB，也没有可报告的模拟耗时。
后续每一步应在此补充实际命令、参数、耗时与输出路径。
