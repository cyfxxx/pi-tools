#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
colab_bridge.py —— 在 Google Colab notebook 中运行的桥接服务。

把 Colab 变成 pi（或任何本地程序）的远程 Python/GPU 执行后端：
  POST /exec      {"mode":"python|bash","code":"...","timeout":N,"cwd":"..."} -> {exit,stdout,stderr,elapsed}
  POST /upload    {"path":"/content/x.py","data":"<base64>"}                  -> {ok}
  GET  /download?path=/content/x.txt                                         -> 文件字节
  GET  /          -> 健康检查 + GPU 摘要（含 token）

认证：请求头 X-Token（或 Authorization: Bearer <token>）。token 每次启动随机生成并打印。
仅 stdlib，零依赖：Colab 里直接跑。
"""

import base64
import json
import os
import secrets
import subprocess
import sys
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

TOKEN = os.environ.get("BRIDGE_TOKEN") or secrets.token_urlsafe(16)
PORT = int(os.environ.get("BRIDGE_PORT", "8787"))
MAX_OUT = 30000  # 单端 stdout/stderr 截断字符数


def gpu_summary():
    try:
        r = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total,memory.free,driver_version",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10)
        return r.stdout.strip() or "-"
    except Exception:
        return "-"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    # ---------- 工具 ----------
    def authed(self):
        h = self.headers
        return (h.get("X-Token") == TOKEN or
                h.get("Authorization", "").replace("Bearer ", "") == TOKEN)

    def reply(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def reply_bytes(self, data, ctype="application/octet-stream"):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def read_json(self):
        try:
            ln = int(self.headers.get("Content-Length", 0))
            return json.loads(self.rfile.read(ln))
        except Exception:
            return None

    # ---------- GET ----------
    def do_GET(self):
        if not self.authed():
            return self.reply({"error": "unauthorized"}, 401)
        p = urllib.parse.urlparse(self.path)
        if p.path == "/":
            return self.reply({
                "status": "ok",
                "token": TOKEN,
                "gpu": gpu_summary(),
                "python": sys.version.split()[0],
                "cwd": os.getcwd(),
                "time": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
            })
        if p.path == "/download":
            q = urllib.parse.parse_qs(p.query)
            path = q.get("path", [""])[0]
            if not path or not os.path.exists(path):
                return self.reply({"error": "not found"}, 404)
            with open(path, "rb") as f:
                return self.reply_bytes(f.read())
        return self.reply({"error": "unknown path"}, 404)

    # ---------- POST ----------
    def do_POST(self):
        if not self.authed():
            return self.reply({"error": "unauthorized"}, 401)
        p = urllib.parse.urlparse(self.path)
        req = self.read_json()
        if req is None:
            return self.reply({"error": "bad json"}, 400)
        if p.path == "/exec":
            code = req.get("code", "")
            mode = req.get("mode", "python")
            timeout = float(req.get("timeout", 120))
            cwd = req.get("cwd") or os.getcwd()
            if mode == "bash":
                cmd = ["bash", "-lc", code]
            else:
                cmd = [sys.executable, "-c", code]
            t0 = time.time()
            try:
                r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                                   cwd=cwd, env={**os.environ, "PYTHONUNBUFFERED": "1"},
                                   errors="replace")
                return self.reply({
                    "exit": r.returncode,
                    "stdout": r.stdout[-MAX_OUT:],
                    "stderr": r.stderr[-MAX_OUT:],
                    "elapsed": round(time.time() - t0, 2),
                })
            except subprocess.TimeoutExpired:
                return self.reply({"error": "timeout",
                                   "elapsed": round(time.time() - t0, 2)}, 408)
        if p.path == "/upload":
            path = req.get("path", "")
            data = req.get("data", "")
            if not path:
                return self.reply({"error": "path required"}, 400)
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
            raw = base64.b64decode(data)
            with open(path, "wb") as f:
                f.write(raw)
            return self.reply({"ok": True, "path": path, "bytes": len(raw)})
        return self.reply({"error": "unknown path"}, 404)


if __name__ == "__main__":
    print(f"[bridge] listening on 0.0.0.0:{PORT}  token={TOKEN}", flush=True)
    print(f"[bridge] GPU: {gpu_summary()}", flush=True)
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()