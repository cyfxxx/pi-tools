status: proposed

## 问题
entries.json 在 crash 后清理流程中出现中间态，若未先从正确版本重建再重放清理步骤，可能导致条目丢失或重复。

## 建议改动
1) crash 后从 git 提供的正确提交（如 a77ee03）重建 entries.json 备份  
2) 仅在确认备份正确后，再执行 memory/scripts/rebuild.sh --yes 等清理步骤  
3) 清理后使用 node -e 校验 entries.json 完整性（条目数、去重标签）

## 验证方式
在清理完成后，运行 `node ~/.pi/scripts/memory-lifecycle.mjs --json` 确认 counts.junkSuspects 为 0 且 promotionCandidates 数量符合预期；如有异常请检查日志中是否有 crash 导致的写入不一致。