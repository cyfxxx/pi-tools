---
name: repo-size-audit
description: 审计 git 仓库（本地与远程）体积，定位历史大对象与不该入库的内容，按"忽略+说明或清历史"分级处置。
---

# git 仓库体积审计

适用：用户要求"检查仓库体积""看看有没有不该存入的内容"。

## 步骤

1. **总量**
   - `git count-objects -vH`，关注 size-pack。

2. **定位大对象**
   ```bash
   git rev-list --objects --all \
     | git cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)' \
     | awk '$1=="blob"' | sort -k3 -n | tail -20
   ```

3. **远程体积**
   - 平台仓库页/Insights；精确测量用 `git clone --bare` 后 `du -sh`；深入分析用 git-sizer。

4. **判定不该入库的内容**
   - 大二进制、日志、构建产物、缓存、密钥。
   - 多环境同步仓库（如 .pi）特别检查运行时数据（sessions/logs/summaries）是否被误提交。

5. **分级处置**
   - 轻度：补 `.gitignore` + 在 README 加说明，防止复发。
   - 重度（历史已污染）：`git filter-repo` 清历史；多环境仓库必须通知所有设备重新 clone/同步，避免旧对象被推回。

6. **答疑口径**
   - delta 压缩是 git 打包对象的常规压缩机制，体积报告中出现 delta 属正常且正向（传输/存储更小），无需处理。

7. **收尾**
   - 结论 memory_store 入库；文档更新走正常提交流程（remote 含 token 时先恢复无凭证 URL）。
