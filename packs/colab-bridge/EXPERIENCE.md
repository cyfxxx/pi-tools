# 使用经验（colab-bridge）

## 2026-08 Colab CLI 与使用边界（迁自长期记忆 2026-08-31）
- 环境: all（WSL2/termux 均可）
- colab-bridge 整合包用法与限制见 SKILL.md；Colab CLI 0.6.0 跑通：认证、版本坑、可用命令链见 SKILL.md/references
- colab 定位仅限代码测试与微调训练：图像/视频模型体积大，上传存放不现实；视频模型本地可直接生成，无需 colab（用户决策：ComfyUI 不用 Colab，Colab 仅用于代码测试与微调训练）
- 与 comfyui-agent 的边界：多目录模型布局见 comfyui-agent/EXPERIENCE.md
