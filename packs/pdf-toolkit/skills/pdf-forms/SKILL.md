---
name: pdf-forms
description: 填写 PDF 表单：自动识别可填写字段（AcroForm），对无字段的扫描/版式表单按视觉坐标插入文字，并渲染验证结果。处理表单填写场景（申请表/合同/税表/SF 表）。依赖 pdf-forms/scripts 下三个脚本。
---

# PDF 表单填写

用户需要"填表 / 填写 PDF 表单 / 签表"时使用本子技能。流程四步，任何一步的输出都要给用户展示，不得静默跳过验证。

## 流程

### Step 1 结构提取（确定表单类型）

```bash
python3 scripts/extract_form.py <表单.pdf> [-o 输出目录]
```

输出：
- `fillable_fields.txt` —— AcroForm 可填写字段清单（名称/类型/现值）。字段类型：`Tx`=文本框，`Ch`=选择框，`Btn`=按钮
- `p001.png...` —— 每页渲染图（dpi 150），用于非 fillable 表单的坐标定位

判定：
- 清单字段数 > 0 → 走 **A 路线**（fillable 字段，直接赋值）
- 清单为空 → 表单是版式/扫描件 → 走 **B 路线**（坐标插入）

### Step 2 构造 fields.json

```json
{
  "fields": [
    {"name": "fld_1", "value": "张三"},                    // A 路线：fillable 字段名（见 fillable_fields.txt）
    {"page": 1, "x": 120, "y": 780, "text": "2026-06-01", "fontsize": 12}  // B 路线：坐标插入
  ]
}
```

坐标约定（重要）：
- 坐标原点 = 渲染图（extract_form 输出 PNG）的**左上角**，与 pymupdf 一致，直接量图填数
- y 随图像向下增大（非 PDF 标准左下原点，二者切勿混用）
- 定位技巧：文字应落在目标格内偏左上，留 1-2px 余量；字体大小参考同一表单其他文字的 `get_text("dict")` 字号，新插入文字默认 `china-s`（内置 CJK 字体，中文无乱码）

补充：若字段格位置不确定，可先渲染局部放大图核对（用 pdf_core render -p 页 -dpi 300，裁剪后贴给用户确认）。

### Step 3 填写

```bash
python3 scripts/fill_form.py <表单.pdf> <fields.json> -o 输出_filled.pdf
```

- fillable 字段用 pypdf `update_page_form_field_values`（按字段名匹配，跨页安全）
- 坐标插入用 pymupdf `insert_text`
- 中文默认内置 `china-s` 字体；纯西文表单可用 `--font helv` 更接近原字体

### Step 4 验证（必做）

```bash
python3 scripts/verify_form.py 输出_filled.pdf -o 检查目录 --expect 张三 --expect 2026-06-01
```

- 校验每个关键值是否出现在目标页文本层
- 渲染 PNG（fillable 字段值在文本层可能不出现，属正常——以渲染 PNG 视觉核对为准）
- 验证不通过：调整坐标/字号重做 Step 3，禁止直接把未验证的文件交付

## 边界

- 加密 PDF：先 `pdf_core decrypt`
- 需勾选/单选（`Btn`/`Ch` 字段）：`Ch` 值填选项名（pypdf `/Opt` 中定义）；`Btn` 填 `true`/`false`（勾选）或 `/Off` 选项名，逐项试填后用 verify_form 的 PNG 核对
- 复杂 AcroForm（JS 脚本联动/计算字段）：浏览器方式填写更可靠（见 references/specialized-tools.md 的 pdf-lib 条目），本脚本管线不覆盖
- 签名：见 references/specialized-tools.md（签名属不常用能力，按需启用）