# ComfyUI 工作流参考（本地实例实测可用）

> 适用实例：`default`（http://127.0.0.1:8188，Windows 本地 ComfyUI 0.33.0，RTX 3070 Ti Laptop 8GB）
> 本机模型为 **FLUX.2 klein 9B 系 + Z-Image 系 + LTX-2.3 系**，无 SD 系 checkpoint（内置 `txt2img` 模板不可用，用本页模板）。

## 0. 蓝图机制（为什么有 7 个"折叠"工作流）

本机 ComfyUI 0.33 UI 里保存的 7 个工作流（`/api/userdata?dir=workflows` 可列出）大量使用 **UUID 类型折叠节点**（如 `7b34ab90-...`、`f2fdebf6-...`）。这些是 ComfyUI 新前端（1.49.6）的 **子图蓝图（Subgraph Blueprint）**："一键出图"节点，把 UNET/CLIP/采样/解码封装成一个节点，仅暴露 prompt/尺寸/模型等少数参数。

- 折叠节点**只能在前端 UI 展开运行**，直接 API 提交会报 `missing_node_type`（后端不认 UUID 类名）
- 官方蓝图定义可通过 `GET /global_subgraphs` 列出、`GET /global_subgraphs/<id>` 获取（含完整子图 `definitions.subgraphs`）
- 本包内置的 `workflows/*.json` 已把这些蓝图**展开为标准节点 API 格式**，可脱离 UI 直接提交（依然等价于 UI 里的同名工作流）
- 用户后用 `工作流文件`（本机 UI 存的 7 个）与内置模板对应关系见下表

## 1. 内置 API 模板（可 `bin/comfyui run builtin:<名>` 直接跑）

| 内置名 | 对应 UI 工作流 | 用途 | 模型（默认） | 关键参数 | 参考耗时* |
|---|---|---|---|---|---|
| `zit_txt2img` | zit-文生图.json | Z-Image 文生图（turbo 8 步） | z_image_turbo_bf16 + qwen_3_4b(lumina2) + zit-vae | prompt/width/height 默认 1024，steps=8，cfg=1，res_multistep/simple，ModelSamplingAuraFlow(3) | 512² ~28s |
| `z_anime_txt2img` |  Z-Anime.json | Z-Image 动漫文生图 | z-anime-distill-8step-fp8 + qwen_3_4b(lumina2) + zit-vae | 同上（8 步蒸馏） | 512² ~24s |
| `flux2_klein_t2i` | flux2_text.json | FLUX.2 Klein 文生图 | flux2-klein-9b-base-fp8 + qwen_3_8b_fp8mixed(flux2) + flux2-vae | prompt/width/height（默认 768），CFGGuider cfg=5，Flux2Scheduler 20 步，euler；负向用 ConditioningZeroOut | 512² ~50s |
| `flux2_klein_edit` | flux2_edit.json | FLUX.2 Klein 图像编辑 | 同 t2i（9b fp8） | prompt=编辑指令，image=输入图；cfg=5，20 步；参考图经 ReferenceLatent+VAEEncode 注入 | 512² ~200s |
| `flux2_kv_ref` | flux2_kv.json | FLUX.2 Klein KV 多图参考（把图1元素合入图2 等） | flux2-klein-9b-kv-fp8 + qwen_3_8b_fp8mixed + flux2-kv-vae | prompt=指令；image/image2=两张参考图；lora(默认 flux2_9B_NSFW)，lora_strength；steps=4，cfg=1，euler，KV 缓存 | 512²(0.26MP) ~24s |
| `ltx23_i2v` | LTX23-图生视频.json | LTX-2.3 图生视频（含音频） | ⚠ 模型待确认（见 §4） | prompt=动作描述；image=首帧；width/height/duration/fps | 未验证 |
| `ltx23_i2v_noaudio` | LTX23-图生视频-无音频.json | 同上，无音频分支 | 同上 | 同上 | 未验证 |
| `flux2_txt2img` | —（此前调试遗留） | FLUX.2 简易版（euler/sgm_uniform） | 同 t2i | 不建议再用，被 flux2_klein_t2i 取代 | — |

\* 耗时按 8GB 笔记本 GPU + --fast 模式实测；**低分辨率测试用 512×512，KV 类务必调小 megapixels（默认 0.26 ≈ 512²，1 会把图放大到 1024²，耗时 14 倍）**。

## 2. 提示词规范（画面不正常的常见原因）

| 模型 | 语言 | 写法 |
|---|---|---|
| z-anime / zit（Z-Image 系） | **中文效果最好**（qwen_3_4b lumina2 编码器），用户 UI 默认提示词即中文 | 简洁描述主体+细节，可直接抄 UI 工作流里的示例（如"可爱的女生，亚洲的，皮肤白皙，站立的…高清的，人物细节清晰"） |
| flux2 (klein) | 中文/英文均可（qwen_3_8b） | 编辑场景用指令式中文（"把图1中的狐狸换成…保持构图不变"）；文生图用主谓宾完整句 |
| LTX-2.3 | 中文/英文 | 蓝图自带提示技巧：**描述事件与动作随时间发生的情况**+所有视觉细节+（有音频版）声音描述；负面默认 `pc game, console game, video game, cartoon, childish, ugly` |

**防翻车要点**（此前自造工作流踩过的坑）：
1. FLUX.2/Z-Image 系 **negative 必须接 ConditioningZeroOut**（不能复用 positive 的 CLIPTextEncode 或随便写负向词）
2. UNETLoader 必须带 `weight_dtype`；CLIP 维度必须匹配：flux2-klein-9b → `qwen_3_8b_fp8mixed`，Z-Image → `qwen_3_4b`（type=`lumina2`），用 4B clip 跑 9B unet 报 `mat1 and mat2 shapes cannot be multiplied (…7680 …12288…)`
3. Z-Image 系必须先接 `ModelSamplingAuraFlow(shift=3)` 再过采样器，否则画面劣化
4. 采样器：Z-Image 用 `res_multistep/simple`；Klein base 用 `euler` + CFGGuider(5)；Klein KV 用 `euler` + CFGGuider(1)
5. 蒸馏模型（z-anime 8 步 / kv）steps=4~8，不要按 base 跑 20 步

## 3. 内置模板参数位

所有模板支持 comfyui-agent 参数化（`-p '{"键":值}'`）：
- `prompt`：必填提示词/指令
- `{{int:width=…}}` / `{{int:height=…}}`：尺寸（示例默认值见上表）
- `{{seed:seed}}`：随机种子，不传自动随机
- `{{image=…}}` / `{{image2=…}}`：参考图（需先 `bin/comfyui upload <本地图>`）
- `{{ckpt=…}}` / `{{lora=…}}` / `{{lora_strength=…}}`：模型选择（`bin/comfyui models …` 查可用）

例：
```bash
comfyui run builtin:z_anime_txt2img -p '{"prompt":"一只红色的狐狸坐在雪林中，晨光","width":512,"height":512}' -o ./out
comfyui run builtin:flux2_kv_ref -p '{"prompt":"把图1的人物放到图2的场景","image":"a.png","image2":"b.png"}' -o ./out
```

## 4. 模型目录速查（/models 端点，按格式分目录）

ComfyUI 用 `GET /models` 列 50+ 分类目录，`GET /models/<目录>` 列文件。**模型不在 checkpoints 也能被识别**：不同格式放不同目录，各 loader 节点从对应目录读候选。本机主要分布：

| 目录 | 格式/用途 | 本机文件（示例） |
|---|---|---|
| `checkpoints/` | 完整打包（UNET+CLIP+VAE） | 空 |
| `diffusion_models/` | 纯扩散权重（fp16/fp8 safetensors） | flux2-klein-9b-base/kv/fp8、z-anime-distill-8step-fp8、z_image_turbo_bf16、MelBandRoformer |
| `unet_gguf/` | GGUF 量化扩散模型（ComfyUI-GGUF 加载） | **LTX-2.3-22B-distilled-1.1-Q4_K_M.gguf**、sulphur_dev-Q4_K_M.gguf |
| `clip_gguf/` | GGUF 量化文本编码器 | flux2-klein-9b-uncensored-clip-q8_0、qwen-3/3B abliterated 等 |
| `text_encoders/` | 文本编码器 | qwen_3_4b/8b、ltx-2.3_text_projection |
| `vae/` + `vae_approx/` | 完整 VAE / 近似解码器（taesd 系） | LTX23_audio/video_vae、flux2-vae/kv-vae、zit-vae；taesd×8 |
| `loras/` | LoRA | flux2_9B_NSFW、ZIT_NSFW_master、ltx-2.3 系 lora×4 |
| `latent_upscale_models/` | latent 放大模型 | ltx-2.3-spatial-upscaler-x2-1.1 |
| `upscale_models/` | 图像放大 | RealESRGAN_x4plus |

> CLI 侧 `bin/comfyui models unet|unet_gguf|clip_gguf|text_encoders|...` 直接读这些目录（见 SKILL.md 命令表）。

## 5. 待确认事项（LTX-2.3 视频）

已定位：本机无 checkpoints，LTX-2.3 视频模型在 **`models/unet_gguf/`**（`LTX-2.3-22B-distilled-1.1-Q4_K_M.gguf`、`sulphur_dev-Q4_K_M.gguf`，GGUF 量化格式），配套 clip 在 `text_encoders/ltx-2.3_text_projection_bf16.safetensors`、vae 用 `LTX23_video_vae_bf16.safetensors`（音频版 `LTX23_audio_vae_bf16.safetensors`），latent 放大模型 `ltx-2.3-spatial-upscaler-x2-1.1.safetensors` 在 `latent_upscale_models/`。

蓝图默认的 `CheckpointLoaderSimple(ckpt)` / `LTXVAudioVAELoader(ltx-2.3-22b-dev-fp8)` 是 fp 版路径，本机应替换为：**UNETLoaderGGUF（ComfyUI-GGUF 已装，候选见 unet_gguf 目录）+ LTXAVTextEncoderLoader（text_encoder 用 ltx-2.3_text_projection）+ LTXVAudioVAELoader（ckpt_name 用 LTX23_audio_vae）**。API 版模板 `ltx23_i2v*` 的加载节点保持 `{{ckpt}}` 占位，待 UI 里确认 GGUF 加载器组合后补默认值（用户暂缓测试）。

## 6. 蓝图/API 可操作性速查

- 列 UI 工作流：`curl "127.0.0.1:8188/api/userdata?dir=workflows"`
- 取某工作流：`curl "127.0.0.1:8188/api/userdata/workflows%2F<urlencode 文件名>"`
- 列官方蓝图：`curl 127.0.0.1:8188/global_subgraphs`（89 个，如 "Text to Image (Z-Image-Turbo)"、"Image to Video (LTX-2.3)"）
- 取蓝图定义：`curl 127.0.0.1:8188/global_subgraphs/<64位hash>` → `.data` 是 UI 格式工作流，`definitions.subgraphs` 是折叠子图展开
- 官方模板源：https://github.com/Comfy-Org/workflow_templates/tree/main/templates（与本机模板版本对齐）
- 官方文档：https://docs.comfy.org/zh 、FLUX.2 Klein 指南 https://docs.comfy.org/tutorials/flux/flux-2-klein （docs 页面加 `.md` 后缀可拿 Markdown）