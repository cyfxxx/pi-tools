#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
comfyui-agent CLI —— 单一 stdlib 依赖的 ComfyUI 远程操控工具。

设计目标：让 pi（CLI coding agent）用一条命令完成"提交工作流、参数化、
等待、下载输出"的完整闭环；不依赖 comfy-cli、不依赖任何第三方 Python 包。
协议：ComfyUI 原生 HTTP API（/prompt, /queue, /history, /view, /object_info ...）。

实践出处（取其精华）：
- ComfyUI_Skills_OpenClaw: CLI 作为 agent 主接口 + 参数 schema 收敛
- comfyui-mcp-server 的 PARAM_*：workflow JSON 字符串内嵌参数占位符
- comfy-python-sdk：workflow 加载 -> set_input -> run -> 取 output 的对象式流程
- ComfyUI 官方原生 HTTP API（v1）

参数占位符（写在 workflow JSON 的字符串值中）：
  {{name}}           自由文本，必填
  {{name=default}}   带默认值
  {{int:name}}, {{float:name}}, {{bool:name}}  类型化
  {{seed:name}}      整数，不传则随机
替换后仍保留 {{ }} 的占位符视为未提供，直接输出诊断。
"""

import argparse
import json
import os
import re
import random
import sys
import time
import urllib.request
import urllib.error
import urllib.parse

APP = "comfyui-agent"
CONFIG_ENV = "COMFYUI_AGENT_CONFIG"
DEFAULT_CONFIG = os.path.expanduser("~/.config/comfyui-agent/config.json")
PKG_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILTIN_WF_DIR = os.path.join(PKG_DIR, "workflows")
DEFAULT_TIMEOUT = 600
POLL_INTERVAL = 2.0
USER_AGENT = "comfyui-agent/1.0"


# ---------------------------------------------------------------- 配置
def load_config():
    path = os.environ.get(CONFIG_ENV) or DEFAULT_CONFIG
    if not os.path.exists(path):
        return {"path": path, "servers": {}}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        die(f"无法读取配置文件 {path}: {e}")
    data.setdefault("servers", {})
    data["path"] = path
    return data


def save_config(cfg):
    path = cfg["path"]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data = {k: v for k, v in cfg.items() if k != "path"}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def resolve_server(args):
    """找出本次调用的 base_url（命令行 server 名 / -b / 默认 default）。"""
    cfg = load_config()
    name = args.server
    if args.base_url:
        return name or "cli", args.base_url.rstrip("/")
    if not name:
        name = "default"
    srv = cfg["servers"].get(name)
    if not srv:
        candidates = ", ".join(cfg["servers"].keys()) or "(无)"
        die(f"未找到 server '{name}'。现有: {candidates}\n"
            f"  添加: comfyui servers add <名称> <http://主机:8188>")
    return name, srv.rstrip("/")


# ---------------------------------------------------------------- HTTP
def http_json(method, url, payload=None, timeout=30, accept=("application/json",),
               die_on_error=True):
    req = urllib.request.Request(url, method=method)
    req.add_header("User-Agent", USER_AGENT)
    for a in accept:
        req.add_header("Accept", a)
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data=data, timeout=timeout) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:800]
        if die_on_error:
            die(f"HTTP {e.code} {e.reason} @ {url}\n{body}")
        return None
    except urllib.error.URLError as e:
        if die_on_error:
            die(f"连接失败 @ {url}: {e.reason}\n"
                f"  确认 ComfyUI 已启动且监听该地址（远程机用 --listen 0.0.0.0）")
        return None
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return raw.decode("utf-8", "replace")


# ---------------------------------------------------------------- 工作流
def load_workflow(src, server_name, base_url):
    """src: 本地路径 | builtin:<名> | @<远程workflow名> | - (stdin)。返回 (名称, prompt_api_dict)。"""
    if src == "-":
        return "stdin", json.load(sys.stdin)
    if src.startswith("builtin:"):
        name = src[len("builtin:"):]
        path = os.path.join(BUILTIN_WF_DIR, name if name.endswith(".json") else name + ".json")
        if not os.path.exists(path):
            die(f"内置工作流不存在: {name}（可用: {list_builtin()}）")
        with open(path, "r", encoding="utf-8") as f:
            return name, json.load(f)
    if src.startswith("@"):
        name = src[1:]
        ui = http_json("GET", f"{base_url}/api/workflows/{urllib.parse.quote(name)}",
                       accept=("application/json", "text/plain"))
        return name, ui_to_api(ui, base_url)
    if os.path.exists(src):
        with open(src, "r", encoding="utf-8") as f:
            return os.path.basename(src), json.load(f)
    # 第二个含义：config 里没有 → 可能是远程 workflow 名
    raise SystemExit(f"无法解析工作流源 '{src}'（本地文件不存在）")


def list_builtin():
    return [f[:-5] for f in sorted(os.listdir(BUILTIN_WF_DIR)) if f.endswith(".json")]


def ui_to_api(ui, base_url):
    """尽力把 ComfyUI UI 格式 workflow JSON 转成 API prompt 格式。
    链接按 nodes/links 还原；widget 值按节点类型定义的 required 顺序对位填充。
    转换不完全精确时给出警告，保留原始节点以便排查。"""
    obj_info = http_json("GET", f"{base_url}/object_info")
    api = {}
    links = {l[0]: l for l in (ui.get("links") or [])}  # [id,src,s_slot,tgt,t_slot,type]
    for n in (ui.get("nodes") or []):
        nid = str(n.get("id"))
        ct = n.get("type", "")
        if ct in ("Note", "PrimitiveNode"):
            continue
        inputs = {}
        for inp in n.get("inputs") or []:
            name = inp.get("name")
            link_id = inp.get("link")
            if link_id is not None and link_id in links:
                l = links[link_id]
                inputs[name] = [str(l[1]), l[2]]
        # widget 值：查询该节点在 object_info 中 required 顺序，仅填充未被链接占用的输入
        widgets = n.get("widgets_values") or []
        wi = 0
        if ct in obj_info:
            required = obj_info[ct].get("input", {}).get("required", {})
            for name, spec in required.items():
                if name in inputs:
                    continue
                if wi >= len(widgets):
                    break
                inputs[name] = widgets[wi]
                wi += 1
        api[nid] = {"class_type": ct, "inputs": inputs}
    if not api:
        die("远程工作流为空或无法转换；请在 ComfyUI 里用 'Save (API Format)' 导出后放本地")
    return api


PLACEHOLDER = re.compile(r"\{\{\s*([^}]+?)\s*\}\}")


def apply_params(prompt, params):
    """把 prompt 中字符串值里的 {{...}} 占位符替换为参数。就地修改并返回提示。"""
    provided = set(params.keys())
    used = set()

    def fmt(spec):
        s = spec.strip()
        default = None
        if "=" in s:
            s, default = s.split("=", 1)
        typ = "str"
        if ":" in s:
            typ, s = s.split(":", 1)
        pname = s.strip()
        if pname in params:
            used.add(pname)
            return coerce(params[pname], typ, pname)
        if default is not None:
            return coerce(default, typ, pname)
        if typ == "seed":
            return random.randint(0, 2**32 - 1)
        raise ValueError(f"缺少参数 {pname}（类型 {typ}），可传 --params 或改默认值")

    def walk(node):
        if isinstance(node, dict):
            return {k: walk(v) for k, v in node.items()}
        if isinstance(node, list):
            return [walk(v) for v in node]
        if isinstance(node, str) and "{{" in node:
            def rep(m):
                return str(fmt(m.group(1)))
            return PLACEHOLDER.sub(rep, node)
        return node

    out = walk(prompt)

    remains = find_unresolved(out)
    missing = set()
    for r in remains:
        spec = r.strip().split(":")[-1].split("=")[0].strip()
        if spec not in params and not r.startswith("seed:"):
            missing.add(spec)
    return out, used, missing


def find_unresolved(node, acc=None):
    if acc is None:
        acc = []
    if isinstance(node, dict):
        for v in node.values():
            find_unresolved(v, acc)
    elif isinstance(node, list):
        for v in node:
            find_unresolved(v, acc)
    elif isinstance(node, str):
        acc.extend(m.group(1) for m in PLACEHOLDER.finditer(node))
    return acc


def coerce(val, typ, name):
    try:
        if typ == "int":
            return int(val)
        if typ == "float":
            return float(val)
        if typ == "bool":
            if isinstance(val, bool):
                return val
            return str(val).strip().lower() in ("1", "true", "yes", "on")
        if typ == "seed":
            return int(val)
        return str(val)
    except (TypeError, ValueError) as e:
        raise ValueError(f"参数 {name} 的值 {val!r} 无法转成 {typ}: {e}")


def finalize_seed(prompt):
    raise SystemExit("unused")  # placeholder 已在 apply_params 处理

# ---------------------------------------------------------------- 执行
def cmd_run(args):
    name, base = resolve_server(args)
    wf_name, wf = load_workflow(args.src, name, base)
    warn = []
    params = {}
    if args.params:
        if args.params.endswith(".json") and os.path.exists(args.params):
            with open(args.params, "r", encoding="utf-8") as f:
                params = json.load(f)
        else:
            try:
                params = json.loads(args.params)
            except Exception:
                die("--params 需为 JSON 字符串或指向 JSON 文件的路径")
    try:
        prompt, used, missing = apply_params(wf, params)
    except ValueError as e:
        die(f"参数错误: {e}")
    if missing:
        print(f"警告：以下占位符未替换（可能写法有误）: {sorted(missing)}", file=sys.stderr)

    client_id = os.urandom(16).hex()
    body = {"prompt": prompt, "client_id": client_id}
    info = http_json("POST", f"{base}/prompt", body, timeout=30)
    if not info or "prompt_id" not in info:
        die("提交失败：响应缺少 prompt_id")
    pid = info["prompt_id"]
    t0 = time.time()
    print(f"[提交] server={name} base={base} 工作流={wf_name} prompt_id={pid}", file=sys.stderr)
    print(f"[参数] 使用 {len(used)} 个: {sorted(used)}", file=sys.stderr)

    outdir = os.path.abspath(args.out or os.path.join(os.getcwd(), "comfyui_outputs"))
    result = wait_prompt(base, pid, timeout=args.timeout, outdir=outdir, download=not args.no_download)
    result.update({
        "action": "run",
        "workflow": wf_name,
        "server": name,
        "base_url": base,
        "prompt_id": pid,
        "params": {k: params[k] for k in sorted(used)},
        "elapsed_s": round(time.time() - t0, 2),
    })
    emit(result)


def wait_prompt(base, pid, timeout, outdir, download):
    if download:
        os.makedirs(outdir, exist_ok=True)
    deadline = time.time() + timeout
    fails = 0
    while time.time() < deadline:
        hist = http_json("GET", f"{base}/history/{pid}", die_on_error=False)
        if hist is None:
            fails += 1
            if fails >= 6:
                die(f"连续 6 次无法连接 {base}，放弃等待 {pid}（可能远程实例已停止）")
            time.sleep(POLL_INTERVAL)
            continue
        fails = 0
        if pid in hist:
            entry = hist[pid]
            status = entry.get("status", {}).get("status_str", "unknown")
            if status == "error":
                msgs = []
                for sid, s in (entry.get("status", {}).get("messages") or []):
                    if sid == "execution_error":
                        d = s.get("data", {})
                        msgs.append(f"{d.get('node_type')} 节点{d.get('node_id')}: {d.get('exception_type')} {d.get('exception_message')}")
                emit({"action": "error", "prompt_id": pid, "workflow_status": "error",
                      "errors": msgs or entry.get("status", {}).get("messages", []), "elapsed_s": 0}, plain_exit=True)
                return {"status": "error"}
            outputs = entry.get("outputs") or {}
            images = []
            for nid, out in outputs.items():
                for img in (out.get("images") or []):
                    path = None
                    if download:
                        path = download_image(base, img, outdir)
                    images.append({"node": nid, "file": img.get("filename"),
                                   "subfolder": img.get("subfolder", ""),
                                   "type": img.get("type", "output"),
                                   "width": img.get("width"), "height": img.get("height"),
                                   "path": path})
            # images 去重（多节点引用同一输出时）
            seen, uniq = set(), []
            for im in images:
                k = (im["node"], im["file"], im["subfolder"], im["type"])
                if k not in seen:
                    seen.add(k)
                    uniq.append(im)
            return {"status": "completed", "outputs": uniq}
        time.sleep(POLL_INTERVAL)
    die(f"等待 {pid} 超时（>{timeout}s）。可用 comfyui queue list 查看状态")


def download_image(base, img, outdir):
    qs = urllib.parse.urlencode({"filename": img.get("filename", ""),
                                 "subfolder": img.get("subfolder", ""),
                                 "type": img.get("type", "output")})
    url = f"{base}/view?{qs}"
    req = urllib.request.Request(url)
    req.add_header("User-Agent", USER_AGENT)
    fname = img.get("filename", "output.png")
    target = os.path.join(outdir, fname)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp, open(target, "wb") as f:
            data = resp.read()
            f.write(data)
    except Exception as e:
        return None
    return target


# ---------------------------------------------------------------- 其它子命令
def cmd_status(args):
    name, base = resolve_server(args)
    s = http_json("GET", f"{base}/system_stats")
    q = http_json("GET", f"{base}/queue")
    g = ""
    if s.get("devices"):
        dev = s["devices"][0]
        g = f"{dev.get('name','?')} ({dev.get('type','?')}, {dev.get('vram_total',0)//1048576}MB VRAM, {dev.get('vram_free',0)//1048576}MB 空闲)"
    print(json.dumps({
        "server": name, "base_url": base,
        "comfyui_version": s.get("system", {}).get("comfyui_version"),
        "python_version": s.get("system", {}).get("python_version"),
        "os": s.get("system", {}).get("os"),
        "device": g,
        "queue_running": len(q.get("queue_running", [])),
        "queue_pending": len(q.get("queue_pending", [])),
    }, ensure_ascii=False, indent=2))


def cmd_nodes(args):
    name, base = resolve_server(args)
    info = http_json("GET", f"{base}/object_info")
    nodes = info.get(args.node_type, {}) if args.node_type else info
    if args.node_type:
        shape = {ktype: v.get("input", {}) for ktype, v in nodes.items()} \
            if isinstance(nodes, dict) and args.node_type in nodes else nodes
        print(json.dumps(nodes, ensure_ascii=False, indent=2))
    else:
        print(f"共 {len(nodes)} 类节点。指定节点类型查看详情，例如: comfyui nodes KSampler -s {name}")


def cmd_models(args):
    name, base = resolve_server(args)
    kind = args.kind or "checkpoints"
    info = http_json("GET", f"{base}/object_info")
    # 从常见 loader / sampler 节点聚合候选资源
    collectors = {
        "checkpoints": ("CheckpointLoaderSimple", "ckpt_name"),
        "loras": ("LoraLoader", "lora_name"),
        "vaes": ("VAELoader", "vae_name"),
        "clips": ("CLIPLoader", "clip_name"),
        "samplers": ("KSampler", "sampler_name"),
        "schedulers": ("KSampler", "scheduler"),
        "upscale": ("UpscaleModelLoader", "model_name"),
    }
    # ComfyUI 模型目录（GET /models/<dir> 直读，与文件系统一致；对应格式见 WORKFLOWS.md §1）
    file_dirs = {
        "unet": "diffusion_models",      # 纯扩散模型权重（fp16/fp8 safetensors）
        "unet_gguf": "unet_gguf",        # GGUF 量化扩散模型（Q4/Q8）
        "clip_gguf": "clip_gguf",        # GGUF 量化文本编码器
        "text_encoders": "text_encoders",  # 文本编码器（qwen/ltx projection 等）
        "clip_vision": "clip_vision",
        "diffusers": "diffusers",
        "controlnet": "controlnet",
        "latent_upscale": "latent_upscale_models",
        "upscale_models": "upscale_models",
        "vae_approx": "vae_approx",
        "embeddings": "embeddings",
        "photo": "photomaker",
        "ipadapter": "ipadapter",
        "pulid": "pulid",
        "rembg": "rembg",
        "inpaint": "inpaint",
        "llm": "llm",
        "t5": "t5",
    }
    if kind in file_dirs:
        try:
            items = http_json("GET", f"{base}/models/{file_dirs[kind]}", die_on_error=False)
        except Exception:
            items = []
        if isinstance(items, list):
            print("\n".join(items) if items else "(空)")
            return
        die(f"目录 {file_dirs[kind]} 读取失败")
    if kind not in collectors:
        # 尝试直接读给定节点类型的候选列表字段
        best = None
        for node_key, node in info.items():
            for field, spec in (node.get("input", {}).get("required", {})).items():
                if isinstance(spec, list) and spec and isinstance(spec[0], list) and kind in field:
                    best = (field, spec[0])
                    break
            if best:
                break
        if best:
            print("\n".join(best[1]) if best[1] else "(空)")
            return
        die(f"未知类型 {kind}，可用: {', '.join(collectors)}")
    node_typ, field = collectors[kind]
    items = []
    nd = info.get(node_typ)
    if nd:
        sp = nd.get("input", {}).get("required", {}).get(field)
        if isinstance(sp, list) and sp:
            items = sp[0]
    print("\n".join(items) if items else "(空)")


def cmd_workflows(args):
    name, base = resolve_server(args)
    op = args.op
    if op == "list":
        data = http_json("GET", f"{base}/api/workflows", accept=("application/json", "text/plain"))
        if isinstance(data, list):
            names = data
        elif isinstance(data, dict):
            names = list(data.get("workflows") or data.keys())
        else:
            names = []
        print("\n".join(names) if names else "(无已保存工作流)")
    elif op == "get":
        wf = http_json("GET", f"{base}/api/workflows/{urllib.parse.quote(args.name)}",
                       accept=("application/json", "text/plain"))
        out = args.name if args.name.endswith(".json") else args.name + ".json"
        out = os.path.join(os.getcwd(), out)
        with open(out, "w", encoding="utf-8") as f:
            json.dump(wf, f, ensure_ascii=False, indent=2)
        print(f"已保存 {out}（UI 格式，如需运行请导出 API 格式或让 pi 转换）")
    elif op == "save":
        body = {}
        with open(args.file, "r", encoding="utf-8") as f:
            body = json.load(f)
        r = http_json("PUT", f"{base}/api/workflows/{urllib.parse.quote(args.name)}", body)
        print(f"已保存到 {args.name}")
    else:
        die("未知操作")


def cmd_queue(args):
    name, base = resolve_server(args)
    if args.op == "clear":
        r = http_json("POST", f"{base}/queue", {"clear": True})
        print("队列已清空")
    else:
        q = http_json("GET", f"{base}/queue")
        out = {"running": [p.get("prompt_id", "?")[:8] for p in q.get("queue_running", [])],
               "pending": [p.get("prompt_id", "?")[:8] for p in q.get("queue_pending", [])]}
        print(json.dumps(out, ensure_ascii=False, indent=2))


def cmd_upload(args):
    name, base = resolve_server(args)
    filepath = args.file
    if not os.path.exists(filepath):
        die(f"文件不存在: {filepath}")
    import mimetypes
    import uuid
    # multipart 上传
    boundary = "----comfyuiagent" + uuid.uuid4().hex
    fn = os.path.basename(filepath)
    parts = []
    parts.append(f"--{boundary}".encode())
    parts.append(f'Content-Disposition: form-data; name="image"; filename="{fn}"'.encode())
    parts.append(b"")
    with open(filepath, "rb") as f:
        parts.append(f.read())
    parts.append(f"--{boundary}--\r\n".encode())
    body = b"\r\n".join(parts)
    req = urllib.request.Request(f"{base}/upload/image", data=body, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    req.add_header("User-Agent", USER_AGENT)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            r = json.loads(resp.read())
        print(json.dumps({**r, "notes": "上传成功，可在工作流中用 image 输入（subfolder/type=input）"}, ensure_ascii=False, indent=2))
    except urllib.error.HTTPError as e:
        die(f"上传失败 HTTP {e.code}: {e.read().decode('utf-8','replace')[:400]}")


def cmd_servers(args):
    cfg = load_config()
    if args.op == "add":
        if not args.name or not args.url:
            die("用法: comfyui servers add <名称> <http://主机:8188>")
        cfg["servers"][args.name] = args.url
        save_config(cfg)
        print(f"已添加 server {args.name} -> {args.url}")
    elif args.op == "rm":
        cfg.get("servers", {}).pop(args.name, None)
        save_config(cfg)
        print(f"已删除 server {args.name}")
    else:
        print(json.dumps(cfg.get("servers", {}), ensure_ascii=False, indent=2))


# ---------------------------------------------------------------- 输出
_JSON_OUTPUT = False


def emit(data, plain_exit=False):
    if _JSON_OUTPUT or os.environ.get("COMFYUI_AGENT_JSON") == "1":
        print(json.dumps(data, ensure_ascii=False))
    else:
        print(_human(data))
    if plain_exit:
        raise SystemExit(0)


def _human(d):
    lines = []
    if d.get("action") == "run":
        lines.append(f"状态: {d.get('status')}")
        if d.get("status") == "completed":
            outs = d.get("outputs") or []
            lines.append(f"输出 {len(outs)} 张图:")
            for o in outs:
                lines.append(f"  node {o['node']}: {o['file']} ({o.get('width')}x{o.get('height')}) -> {o.get('path')}")
        lines.append(f"耗时: {d.get('elapsed_s')}s  prompt_id: {d.get('prompt_id')}")
        if d.get("params"):
            lines.append(f"参数: {d.get('params')}")
    elif d.get("action") == "error":
        lines.append("运行失败:")
        for e in d.get("errors", []):
            lines.append(f"  {e}")
    else:
        return json.dumps(d, ensure_ascii=False, indent=2)
    return "\n".join(lines)


def die(msg, code=1):
    print(f"[comfyui-agent] {msg}", file=sys.stderr)
    raise SystemExit(code)


# ---------------------------------------------------------------- main
def build_parser():
    common = argparse.ArgumentParser(add_help=False)
    # SUPPRESS：子命令解析时不覆盖（允许 -s 出现在子命令前或后）
    common.add_argument("-s", "--server", default=argparse.SUPPRESS, help="server 名（默认 default）")
    common.add_argument("-b", "--base-url", default=argparse.SUPPRESS, help="覆盖 base URL")
    common.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help="JSON 输出")

    p = argparse.ArgumentParser(prog="comfyui", description="ComfyUI 远程操控 CLI（pi 集成）")
    p.add_argument("-s", "--server", help="server 名（默认 default，子命令前指定）")
    p.add_argument("-b", "--base-url", help="覆盖 base URL")
    p.add_argument("--json", action="store_true", help="JSON 输出")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("status", parents=[common], help="实例状态/显卡/队列")
    sp.set_defaults(func=cmd_status)

    sp = sub.add_parser("nodes", parents=[common], help="节点目录（object_info）")
    sp.add_argument("node_type", nargs="?", default=None)
    sp.set_defaults(func=cmd_nodes)

    sp = sub.add_parser("models", parents=[common], help="列出模型/采样器等候选")
    sp.add_argument("kind", nargs="?", default="checkpoints")
    sp.set_defaults(func=cmd_models)

    sp = sub.add_parser("workflows", parents=[common], help="远程工作流管理")
    sp.add_argument("op", choices=["list", "get", "save"])
    sp.add_argument("name", nargs="?", default=None)
    sp.add_argument("--file", help="save 时上传的本地文件")
    sp.set_defaults(func=cmd_workflows)

    sp = sub.add_parser("run", parents=[common], help="提交并等待工作流，下载输出")
    sp.add_argument("src", help="本地 .json | builtin:<名> | @<远程名> | - (stdin)")
    sp.add_argument("-p", "--params", help="JSON 字符串或 .json 文件")
    sp.add_argument("-o", "--out", help="输出目录（默认 ./comfyui_outputs）")
    sp.add_argument("-t", "--timeout", type=int, default=DEFAULT_TIMEOUT, help="超时秒数")
    sp.add_argument("--no-download", action="store_true", help="只回传图像元数据不下载")
    sp.set_defaults(func=cmd_run)

    sp = sub.add_parser("queue", parents=[common], help="查看/清空队列")
    sp.add_argument("op", nargs="?", default="list", choices=["list", "clear"])
    sp.set_defaults(func=cmd_queue)

    sp = sub.add_parser("upload", parents=[common], help="上传输入图像到远程 ComfyUI")
    sp.add_argument("file")
    sp.set_defaults(func=cmd_upload)

    sp = sub.add_parser("servers", parents=[common], help="管理 server 配置")
    sp.add_argument("op", nargs="?", default="list", choices=["list", "add", "rm"])
    sp.add_argument("name", nargs="?", default=None)
    sp.add_argument("url", nargs="?", default=None)
    sp.set_defaults(func=cmd_servers)
    return p


def main():
    p = build_parser()
    global _JSON_OUTPUT
    args = p.parse_args()
    _JSON_OUTPUT = getattr(args, "json", False)
    args.func(args)


if __name__ == "__main__":
    main()
