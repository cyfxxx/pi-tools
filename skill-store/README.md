# skill-store：外置技能库（不入 agent/skills/，防系统提示词膨胀）

## 用途

沉淀"成功实现、可复现、有保存价值"的长任务为可复用 skill。

## 为什么不放 agent/skills/

`agent/skills/` 下的技能会被 pi 自动扫描并把 description 注入系统提示词——
技能越多系统提示词越膨胀、缓存前缀越不稳定。外置库**不被自动注入**，
只在需要时按需启用 → 提示词精简稳定。

## 目录结构

```
skill-store/
  drafts/     # 半自动草稿（task-summarizer 生成的 SKILL.md，待人工确认）
  active/     # 已人工确认的技能（需用时复制/链接到 agent/skills/ 激活）
  README.md   # 本说明
```

## 流程

1. **生成**：`scripts/task-summarizer.mjs` 批量总结任务时，识别"成功/可复现/有价值"
   的长任务 → 写 SKILL.md 草稿到 `drafts/`
2. **确认**：人工审阅草稿（name/description/步骤是否准确、不带时间戳、可复现），
   确认后移入 `active/` 或在 README 标记；不合格的删除
3. **激活**：需要某技能时，将 `active/<name>` 复制/软链到
   `agent/skills/<name>（含 SKILL.md）` → pi 自动注入启用；用毕可移除
4. **清理**：`active/` 中长时间未激活的定期归档删除

## 与 pi-backup 的关系

外置库入库 Git（/root/.pi 仓库），随 pi-backup 同步，不依赖本机单独备份。

## 防膨胀守则

- 草稿进 drafts 前由脚本标注"建议"，未确认不激活
- SKILL.md description 控制在 1-2 句、不含时间戳（缓存友好）
- 同时激活的外置技能保持少量（≤3），其余按需临时启用
