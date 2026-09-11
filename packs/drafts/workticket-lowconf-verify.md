status: proposed

## 问题
confidence<0.8 的记忆条目在清理流程中被标记 needs_verification，但在批量删除或升格时若不先人工确认，可能丢失有价值的低置信度知识。

## 建议改动
1) 在 entries.json 批量操作前，先用 memory_search 检索 confidence<0.8 条目，人工审查后方可决定是保留、升格或删除  
2) 为每此类条目补充 content 要点或外部链接，提升其实用性  
3) 设定阈值：仅在连续 3 轮未被访问（accessedAt 旧）且 无外部引用时才标记为 junk 进行自动删除

## 验证方式
运行 memory_stats 查看低置信度条目数量变动；人工复盘后确认删除/保留的条目在后续检索中仍可命中，确认未丢失关键知识。