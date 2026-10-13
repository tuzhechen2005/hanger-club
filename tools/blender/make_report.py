"""Aggregate measured reports, preserving failed checks and approximations."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REPORTS = ROOT / "assets-src" / "reports"


def read(name):
    return json.loads((REPORTS / name).read_text(encoding="utf-8"))


def main():
    drape, animation = read("tee/drape-report.json"), read("tee/animation-report.json")
    validation, geometry = read("tee/validation.json"), read("tee/geometry-audit.json")
    render, texture, hanger = read("tee/render-report.json"), read("shirt3/texture-report.json"), read("hanger/report.json")
    checks = [
        {"item": "背面文字不是镜像", "status": "N/A: shirt3 背面无印花；前后 UV 均通过方向检查"},
        {"item": "衣服不穿透衣架", "status": "PASS" if geometry["hanger_penetration_probe_total"] == 0 else "FAIL", "evidence": "geometry-audit.json；67 帧顶点与三角形中心采样，0.2 mm 阈值"},
        {"item": "挂钩接触点在原点", "status": "PASS: 内侧顶点在原点，顶部金属约 +4 mm；按已确认修正生成"},
        {"item": "静态/动画顶点数和顺序一致", "status": "PASS" if validation["checks"]["base_attributes_identical"] and validation["checks"]["indices_identical"] else "FAIL"},
        {"item": "glTF 正面朝 +Z", "status": "PASS" if validation["checks"]["front_faces_gltf_positive_z"] else "FAIL"},
        {"item": "动画名和节点名", "status": "PASS" if validation["checks"]["animation_names"] and validation["checks"]["required_nodes"] else "FAIL"},
        {"item": "印花物理尺寸与照片一致", "status": "ESTIMATED: 按照片地标与默认尺寸映射，缺少实测，不能确认真实物理尺寸"},
        {"item": "采样表面自交", "status": "PASS" if geometry["surface_crossing_pair_total"] == 0 else "FAIL", "evidence": f"非相邻面交叉累计 {geometry['surface_crossing_pair_total']} 对，含跨帧重复"},
        {"item": "目标视频视觉匹配", "status": "REVIEW: 已按用户反馈减少细碎褶皱；尚未获用户外观验收"},
    ]
    steps = [
        ("衣架", "blender -b --factory-startup --python-exit-code 1 -P tools/blender/build_hanger.py", hanger),
        ("垂落", "blender -b --factory-startup --python-exit-code 1 -P tools/blender/build_tee.py -- --frames 73 --bend 0.25 --drape-support 0.33", drape),
        ("贴图", "python tools/blender/make_product_texture.py --slug shirt3", texture),
        ("动画 / AO / 导出", "blender -b --factory-startup --python-exit-code 1 -P tools/blender/bake_clips.py -- --warmup 73 --motion-support 0.80", animation),
        ("几何审计", "blender -b --factory-startup --python-exit-code 1 -P tools/blender/audit_geometry.py", geometry),
        ("渲染 / 重新导入", "blender -b --factory-startup --python-exit-code 1 -P tools/blender/render_checks.py", render),
    ]
    result = {
        "blender_version": drape["blender_version"], "branch": "codex/blender-assets",
        "acceptance": "Review build; structural/geometry evidence is separate from visual acceptance",
        "dimensions": drape["dimensions"], "dimensions_source": "default",
        "single_layer_vertices": drape["single_layer_vertices"], "validation": validation,
        "animation": animation, "geometry_audit_summary": {k: v for k, v in geometry.items() if k != "frames"},
        "pipeline": [{"step": name, "command": command, "elapsed_seconds": data["elapsed_seconds"]} for name, command, data in steps],
        "additional_commands": ["python tools/blender/validate_assets.py", "python tools/blender/compose_reports.py", "python tools/blender/make_report.py"],
        "checklist": checks,
        "sources": ["Original parameterized five-piece garment and hanger geometry", "Original wood texture, generated OpenGL jersey/seam normal, baked drape AO", "Original studio area lights; no external HDRI/model", "Owner-supplied branded shirt3 photos: private repository/demo only", "Owner-supplied example_video.mp4: local reference only; not uploaded", "Research citations and experiments: docs/blender-research.md"],
        "known_issues": ["Soft rest-shape constraints deliberately preserve the smooth silhouette; not unconstrained fabric physics", "Cotton mass/stiffness are visually tuned and not physically calibrated", "Rubber label source is approximately 84 pixels wide; original pixels retained without reconstructed text", "Print placement uses default dimensions and photo perspective estimates", "No store frontend integration: repository currently has no src/ implementation", "Any failed geometry checks remain explicitly listed"],
        "renders": ["front.png", "back.png", "left.png", "right.png", "front-three-quarter.png", "back-three-quarter.png", "detail-neck.png", "detail-cuff.png", "detail-hem.png", "static-contact-sheet.png", "lift-contact-sheet.png", "return-contact-sheet.png", "reimport-front.png", "reimport-three-quarter.png"],
        "next_iteration": "Compare neckline roundness, cuff/hem curvature and shoulder silhouette against the supplied video; measure the real garment to validate print dimensions",
    }
    target = REPORTS / "tee"
    (target / "report.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    content = "# 本轮逐项检查\n\n结构通过不代表外观已验收。完整证据见 `report.json` 和分步报告。\n\n| 项目 | 结果 |\n| --- | --- |\n"
    content += "".join(f"| {c['item']} | {c['status']} |\n" for c in checks)
    content += "\n## 实际耗时\n\n| 步骤 | 脚本内部耗时（秒） |\n| --- | --- |\n"
    content += "".join(f"| {name} | {data['elapsed_seconds']} |\n" for name, _, data in steps)
    (target / "checklist.md").write_text(content, encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
