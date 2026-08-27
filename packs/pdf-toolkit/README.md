# pdf-toolkit —— PDF 处理技能包

基于 GitHub 开源方案整合与优化的 PDF 通用处理能力，遵循 packs 仓库"通用能力可用化 + 专用能力分类 + 繁重能力记录"原则。

## 结构

```
pdf-toolkit/
├── SKILL.md                  # 入口：路由速查 + pdf_core 用法 + 执行纪律
├── requirements.txt          # pypdf / pdfplumber / pymupdf / reportlab
├── bin/pdf_core              # 通用能力 CLI（13 个子命令）
├── skills/
│   ├── pdf-forms/            # 专用：表单填写（AcroForm 字段 + 坐标插入 + 验证）
│   │   └── scripts/          # extract_form / fill_form / verify_form
│   └── pdf-ocr/              # 专用：扫描件 OCR（可搜索 PDF + Markdown）
│       └── scripts/          # ocr_pipeline
└── references/
    └── specialized-tools.md  # 记录：去水印/签名/压缩/Stirling/MinerU/pdf-lib/整书管线等
```

## 能力分层（整合原则）

| 层 | 内容 | 形态 |
|---|---|---|
| 通用 | 提取/合并/拆分/旋转/加密/水印/渲染/报告 | pdf_core CLI，即用 |
| 专用 | 表单填写、扫描件 OCR | 子技能 + 脚本，按触发使用 |
| 记录 | 去水印、签名、压缩、Stirling-PDF、MinerU/Marker、pdf-lib、整书 OCR→EPUB、pandoc 生成 | specialized-tools.md 要点，按需临时启用 |

## 借鉴来源（GitHub 调研 2026-06）

- **anthropics/skills `pdf`**（官方，proprietary LICENSE.txt）：技术栈与工具选型（pypdf/pdfplumber/reportlab/pymupdf/tesseract），表单四步流程（结构提取→坐标→填充→验证）与脚本设计
- **xiexikang/skill-pdf-content-extractor**：综合报告、触发词组织、去水印规则/启发式模式（效果不佳的教训已记录）
- **KyoSakuyo/skills pdf-set**：扫描书 OCR→Markdown→翻译→EPUB 管线设计（重场景，记录于 specialized-tools §7）
- **Stirling-PDF**（80k stars）：功能清单作能力规划参照，部署方式记录于 specialized-tools §4
- 参考本仓库 `embedded-dev` / `pcb-design` 的"通用整合 + specialized-tools 记录"组织模式

## 验证记录

在 /root/.pi/packs/pdf-toolkit/examples/ 下用生成样本实测：生成→提取→表格→合并→拆分→旋转→加密→解密→水印→报告→表单填写→验证（记录见 examples/README.md；本环境已实测通过后清理）。

## 环境备注（环境：termux-ubuntu —— proot-Distro aarch64，Android 宿主的 proot 容器，uname 含 PRoot；同步到其他设备后以各自环境为准）

- 依赖安装采用 `pip install --break-system-packages`（PEP 668 环境,先例见 reverse-skill；此环境实测于 Ubuntu 24.04 noble proot）
- OCR 需额外 `apt install tesseract-ocr tesseract-ocr-chi-sim`（Debian 系；本环境已装 tesseract 5 + chi_sim/eng，其他环境按需安装）
- 坐标约定全包统一 pymupdf 左上原点，避免混用