---
name: pi-backup
description: 备份/恢复 pi 配置、技能、扩展源码与用户数据（tar.gz 归档或 GitHub git 同步两种模式）。用户说"备份""存档""迁移""恢复""同步""推送"时触发。不适用：仅同步单个文件/临时传文件（用 scp/rsync）；不含配置的普通代码仓库同步。
version: v1.1
更新日期: 2026-09-12
---

# pi-backup 技能

备份/恢复 pi 配置、技能、扩展源码与用户数据。

## 快速参考

| 命令 | 说明 |
|------|------|
| `pi-backup create` | 创建本地 tar.gz 归档 |
| `pi-backup sync` | 推送到 GitHub |
| `pi-backup restore` | 从归档恢复 |
| `pi-backup clone` | 从 GitHub 克隆 |
| `pi-backup rebuild` | 重建依赖 |
| `pi-backup verify` | 体检 |
| `pi-backup list` | 列出备份 |

## 文档结构

- [README.md](README.md) — 概述与注意事项
- [COMMANDS.md](COMMANDS.md) — 命令详细参数与执行步骤
- [references/BACKUP-MANIFEST.md](references/BACKUP-MANIFEST.md) — 备份清单
