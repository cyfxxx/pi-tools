# pi-repo-optimize improvements（经验日志，合并机制见 docs/SKILLS-MAINTENANCE.md）

- 2026-08-27 | git 历史清理大文件 scan.pdf（6.2MB）| filter-branch 在 541 提交历史中进程死亡未完成（等待 5 分钟无进展）| 用 git-filter-repo（pip install --break-system-packages git-filter-repo）替代：1.4s 完成重写 + 自动 repack。filter-repo 会自动移除 remote（防误推），需重加；需 `--force` 覆盖已 run 标记；完成后删 .git/filter-repo 备份
- 2026-08-27 | 仓库体积审计 | GitHub API `size` 字段有缓存延迟（重写后仍显示旧值 8.2MB），本地用 `git count-objects -vH` 的 size-pack 才是准的；pack 减幅可能小于被删 blob（delta 重算吸收，如删 6.2MB 后 pack 仅减 0.9MB，因 entries.json 127 版本 delta 重压缩）
- 2026-08-27 | scan.pdf 入库教训 | 建包时生成的测试扫描件（6.2MB，PDF 不可压缩且 git 无 delta 效益）直接入库，永久驻留历史才需重写 | 建包/测试产物 >1MB 二进制不入库；需要示例用同内容小文件或文本占位 + README 注明生成方法