---
title: 2026 开源旗舰模型架构核实（DeepSeek-V4 / Kimi-K3 / GLM-5 / Qwen3.8）
collected: 2026-08-29
valid-until: 2026-11-30
refresh-trigger: 任意一家发布下一代模型（V4.x/R2、K4、GLM-6、Qwen3.9/4）或注意力机制换代论文时复核
source: 官方渠道直查——HuggingFace 各模型 config.json/README（经 hf-mirror）、GitHub org（deepseek-ai / QwenLM / zai-org / MoonshotAI）repo 清单、deepseek.com 首页、kimi.com 官网与 platform.kimi.com 文档；未采信任何 SEO 转述文章
confidence: high（config/README 为一手数据）；标注"未验证"的字段除外
tags: [llm-architecture, deepseek-v4, kimi-k3, glm-5, qwen3.8, mla, sparse-attention, linear-attention, moe, mhc]
---

# 2026 开源旗舰模型架构核实

> 核实时间 2026-08-29。全部数据来自官方 HF config.json / README / GitHub repo，参数值以 config 为准。

## 一、DeepSeek-V4（MIT）

官方定位："Towards Highly Efficient Million-Token Context Intelligence"。技术报告 arXiv 2606.19348。

| | V4-Flash | V4-Pro |
|---|---|---|
| 总参/激活 | 284B / 13B | 1.6T / 49B |
| 层数 / hidden | 43 / 4096 | 61 / 7168 |
| head_dim / KV heads | 512 / 1 | 512 / 1 |
| q_lora_rank | 1024 | 1536 |
| 稀疏索引 index_topk | 512（index_n_heads 64） | 1024（index_n_heads 64） |
| 专家 | 256+1 共享，top-6 | 384+1 共享，top-6 |
| scoring_func | sqrtsoftplus，noaux_tc | 同左 |
| MTP | 1 层 | 1 层 |
| 上下文 / 词表 | 1M / 129280 | 1M / 129280 |
| 权重精度 | FP4(MoE experts) + FP8 混合 | 同左（另有 FP8-Mixed Base 版） |

关键架构事实：

1. **CSA + HCA 混合压缩注意力**（Compressed Sparse Attention / Heavily Compressed Attention）：V3.2 DSA 的正式换代。KV 不再是 MLA 低秩 latent（config `num_key_value_heads=1, head_dim=512`，KV 压缩为单头 512 维），配合 lightning indexer（index_n_heads 64）只对 top-k token 做精确注意力。官方数据：**1M 上下文下单 token 推理 FLOPs 为 V3.2 的 27%、KV cache 为其 10%**。1M 上下文为全系列标配。
2. **mHC（Manifold-Constrained Hyper-Connections，流形约束超连接）**：替换普通残差连接，改善深层信号传播稳定性。GLM-5.3-Flash 同款。
3. **Muon 优化器**：Kimi K2 验证后 DeepSeek 正式跟进。32T tokens 预训练。
4. **FP4 专家权重首发**：MoE 专家参数以 FP4 发布——量化从部署选项变成发布格式。
5. **后训练两段式**：领域专家独立培养（SFT + RL/GRPO）→ on-policy distillation 整合为单模型；推理分 Pro-Max / Flash-Max effort 档。

## 二、Kimi K3（2.78T，U8 权重，自定义 kimi-k3 协议）

GitHub/HF 已开源（"Open Frontier Intelligence"），当前总参数最大的开源模型。

- text 模型类型 `kimi_linear`：**93 层 = 69 层 KDA（Kimi Delta Attention，线性注意力）+ 24 层全注意力，精确 3:1**（full_attn_layers = 4,8,...,92,93）。KDA head_dim 128，gate_lower_bound -5（门控增量规则支持覆盖旧记忆）。Kimi Linear 架构直接放大到 2.78T。
- **MLA 潜空间 + Attention Residual**：全注意力层走 MLA latent（kv_lora_rank 512、q_lora_rank 1536、v_head_dim 128），叠加注意力残差（官方研究仓库 MoonshotAI/Attention-Residuals，2026-03）。
- 两个"减法"：**无 DSA/索引式稀疏注意力**（靠 KDA 扛长度）；**无 MTP**（num_nextn_predict_layers=0，K2 有）——推断与 KDA 状态尺寸固定后投机解码收益结构变化有关。
- 其余：1M 上下文、原生视觉（image-text-to-text）、词表 163840、first_k_dense_replace 1、noaux_tc、routed_scaling_factor 1.0。
- 配套推理基建：FlashKDA kernel、MoonEP（专家并行）、checkpoint-engine（权重热更新）。K2.5（视觉 agentic）为中间版本已先行开源。
- 未验证：激活参数量与专家数（config 未捕获到对应字段，官方博客未明示；K2 为 1T-A32B/384 专家，可作量级参考）。

## 三、GLM-5 家族（Apache-2.0）

| | GLM-5 | GLM-5.3-Flash |
|---|---|---|
| 总参 | 754B（BF16） | 321B（FP8 发布） |
| 架构类 | GlmMoeDsaForCausalLM | Glm5NextForConditionalGeneration |
| 层数 / hidden | 78 / 6144 | 45 / 4096 |
| 注意力 | MLA（kv_lora 512、q_lora 2048、v_head_dim 256）+ DSA 索引（index_topk 2048、32 头） | MLA（kv_lora 512、q_lora 1536）+ DSA 索引（2048）+ **linear_attn 混合** |
| 专家 | 256+1，top-8，sigmoid+noaux_tc | 288+1，top-8 |
| MTP | 1 层 | 1 层 |
| 上下文 / 词表 | 200K（202752）/ 154880 | **1M（1048576）** / 154880 |
| 其他 | — | **mHC: true**，原生视觉，30T 多模态语料 |

1. **GLM-5 直接采用 DeepSeek 路线**：MLA + DSA 稀疏索引。
2. **GLM-5.3 与 5.2 同 base，纯后训练提升**（官方 README 明示）：代码能力 +50%、CyberGym 漏洞挖掘 SOTA。"架构趋同后竞争转向后训练"的直接证据。
3. **GLM-5.3-Flash 是真正的新架构**：GLM 系首个 sparse + linear 混合注意力（MLA + DSA + linear 三者并存）。
4. GLM-5 技术报告 arXiv 2602.15763；5.3/5.3-Flash 博客 z.ai/blog/glm-5.3(-flash)。

## 四、Qwen3.5 / Qwen3.8（Apache-2.0）

通义把 Qwen3-Next 路线全线铺开，线性注意力成为默认架构而非效率特供。

| 型号 | 规格 | 注意力 | MoE |
|---|---|---|---|
| Qwen3.5 dense | 0.8B / 2B / 4B / 9B / 27B | GDN 混合 | dense |
| Qwen3.5-35B-A3B | 36B/A3B，40 层，hidden 2048 | GDN（linear 16k/32v heads，conv 4）+ 门控全注意力（attn_output_gate） | top-8 |
| Qwen3.8-Flash-Next | 180B/~A3B，48 层，hidden 2560 | GDN + 门控注意力 + **lightning indexer（budget 2048，压缩比 4）** | top-10 |
| Qwen3.8-2.4T-A95B | 2.45T/A95B（3.9% 激活），92 层，hidden 8192 | GDN（linear value heads 128）+ 门控注意力，无 indexer | **512 专家 top-10** |

共同点：rope_theta 10M、上下文 256K（262144，比别家 1M 保守）、词表 248320（全场最大）、原生视觉（vision tower 内置）、Flash-Next 带 MTP（mtp 1 层）。BF16 + FP8 双版本。
开源旗舰是 Qwen3.8-2.4T-A95B；网上流传的"Qwen3.8-Max 2.4 万亿"为该开源型号的讹传，Max 版本仅 API 不开源。

## 五、这一代（vs V3.2 / Qwen3 / GLM-4.5 / K2）的共性规律

1. **混合线性注意力从"异端"变默认**：四家旗舰全部携带线性注意力或等价物（KDA/GDN/CSA），纯全注意力 dense 旗舰消失。全注意力层占比收敛在 ~25%（K3 24/93、Qwen3-Next 1/4）。
2. **MLA 潜空间 KV 完成技术扩散**：从 DeepSeek 独家 → GLM、Kimi 采用（三家 kv_lora_rank 均 512）。DeepSeek 自身则继续进化为单头压缩 KV + CSA/HCA。
3. **稀疏索引普及**：DSA 思想以不同名字落地（DeepSeek indexer、GLM DSA、Qwen indexer_budget），topk 普遍 512–2048。
4. **稳定化组件趋同**：mHC（DeepSeek/GLM）、attention residual（Kimi）、Muon 优化器（K2→V4）——训练 stability"标准件"正在形成。
5. **MTP 分化**：DeepSeek/GLM/Qwen 保留，Kimi K3 移除——MTP 并非无条件正收益，取决于注意力形态。
6. **量化即发布格式**：V4 的 FP4 专家、K3 的 U8、GLM-Flash 的 FP8。
7. **激活比压到 2–5%**：A13B（V4-Flash，4.6%）、A95B@2.4T（3.9%）、512 专家 top-10。
8. **多模态原生分化**：Qwen/GLM/K3 内置 vision；DeepSeek 仍纯文本，押注 agent+代码。
9. **竞争重心后移**：架构差距收窄后，GLM-5.3 靠同 base 后训练拉开差距，DeepSeek 靠领域专家蒸馏流程，推理 effort 分档成为产品面。

## 六、选型速查

- 极限长上下文/低成本服务：DeepSeek-V4-Flash（13B 激活 + 1M ctx）
- 超大参数上限：Kimi K3 或 V4-Pro
- 单卡/消费级：Qwen3.5 dense 小杯、GLM-5.3-Flash 小杯后续、V4-Flash 量化版
- agent/代码：GLM-5.3、V4-Pro-Max

## 核实渠道附录

- HF（经 hf-mirror.com）：deepseek-ai/DeepSeek-V4-Flash、DeepSeek-V4-Pro（config.json + README）、moonshotai/Kimi-K3、zai-org/GLM-5、zai-org/GLM-5.3-Flash、Qwen/Qwen3.5-35B-A3B、Qwen/Qwen3.8-Flash-Next、Qwen/Qwen3.8-2.4T-A95B
- GitHub：deepseek-ai（deepseek-harness、DeepGEMM、DeepEP、FlashMLA、DeepSpec、Engram、DeepSeek-OCR-2）、MoonshotAI（Kimi-K3、Kimi-K2.5、FlashKDA、Attention-Residuals、MoonEP、checkpoint-engine、Kimi-Linear、MoBA）、zai-org（GLM-5）
- 官网：deepseek.com（首页列 V4）、kimi.com（K3 上线公告）、platform.kimi.com/docs
