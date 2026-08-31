# 使用经验（comfyui-agent）

## 2026-08 ComfyUI 环境与模型约束（迁自长期记忆 2026-08-31）
- 环境: Windows 宿主机 ComfyUI 0.33.0（localhost:8188，WSL2 镜像网络可直连 127.0.0.1），GPU RTX 3070 Ti Laptop 8GB
- 模型为 FLUX.2 klein 系：UNET 有 flux2-klein-9b-base-fp8 / z-anime-distill-8step-fp8 / z_image_turbo_bf16 等；CLIP 有 qwen_3_4b / qwen_3_8b_fp8mixed
- 关键约束：flux2-klein-9b 的 KSampler 需 qwen_3_8b_fp8mixed 作 CLIP（matmul 维度 12288），用 qwen_3_4b 报 'mat1 and mat2 shapes cannot be multiplied (512x7680 and 12288x4096)'；UNETLoader 必须传 weight_dtype=default；FLUX.2 用 EmptySD3LatentImage + FluxGuidance(3.5) + cfg=1.0 + euler/s（细节见 SKILL.md）
- 蓝图折叠节点（UUID 类型）API 直提报 missing_node_type；展开定义经 GET /global_subgraphs 与 /global_subgraphs/<64位hash> 获取，已展开为标准 API 模板内置到 workflows/（zit_txt2img/z_anime_txt2img/flux2_klein_t2i/flux2_klein_edit/flux2_kv_ref/ltx23_i2v/ltx23_i2v_noaudio，用法见 references/WORKFLOWS.md）
- 官方模板源 github.com/Comfy-Org/workflow_templates；官方文档 docs.comfy.org 页面加 .md 后缀可取 Markdown；UI 工作流枚举用 /api/userdata?dir=wo...
- 模型多目录机制：模型不在 checkpoints 也能被识别，GET /models 列 50+ 分类；本机 8188：checkpoints 为空；diffusion_models/ 有 flux2-klein-9b-base/fp8/kv-fp8、z-anime-distill-8step-fp8、z_image_turbo_bf16、MelBandRoformer；unet_gguf/ 有 LTX-2.3-22B-distilled-1.1-Q4_K_M.gguf 与 sulphur_dev-Q4_K_M.gguf；clip_gguf/ 有 flux2-klein uncensored、qwen3 abliterated 等；text_encoders/ 有 qwen_3_4b/8b、ltx-2.3_text_projection；vae/ 有 LTX23_audio/video_vae、flux2-vae/kv-vae、zit-vae 等
- 排查"模型找不到"时勿只查 checkpoints 目录；测试生成用低分辨率缩短耗时
