#!/usr/bin/env python3
"""pi-voice whisper 常驻转写服务。

加载 faster-whisper 模型一次，提供 HTTP 接口：
  POST /transcribe   body = 16-bit PCM WAV 字节 → {"text": "...", "language": "zh"}
  GET  /health       → {"ok": true, "model": "base"}

环境变量：
  PI_WHISPER_MODEL   模型名（默认 base，可用 tiny/base/small/medium/large-v3）
  PI_WHISPER_PORT    端口（默认 18766）
  PI_WHISPER_MODELS  模型缓存目录（默认 /opt/pi-whisper/models）
  PI_WHISPER_TOKEN   共享访问令牌；设置后 /health、/transcribe 均要求
                     Authorization: Bearer <token>，否则 401

国内网络：HuggingFace 需走 hf-mirror.com 且禁用 Xet 后端（已在代码内固化）。
"""

import json
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

MODEL = os.environ.get("PI_WHISPER_MODEL") or "base"
PORT = int(os.environ.get("PI_WHISPER_PORT", "18766"))
MODELS_DIR = os.environ.get("PI_WHISPER_MODELS", "/opt/pi-whisper/models")
LANGUAGE = os.environ.get("PI_WHISPER_LANGUAGE") or None  # 服务级默认语言；None = 自动检测
# 推理设备：cpu / cuda / auto（auto = nvidia-smi 可用则 cuda，否则 cpu）
DEVICE = (os.environ.get("PI_WHISPER_DEVICE") or "auto").lower()


def _cuda_runtime_available():
    """实测 CUDA 运行时库可加载（libcublas + libcudnn，dlopen 自动搜索 LD_LIBRARY_PATH）。
    nvidia-smi / get_cuda_device_count 只证明驱动/设备可见；缺 pip CUDA 库（libcublas.so.12 等）
    时推理必然失败，auto 探测必须在此处拦截。"""
    import ctypes

    def any_of(names):
        for n in names:
            try:
                ctypes.CDLL(n)
                return True
            except OSError:
                continue
        return False

    return any_of(["libcublas.so.13", "libcublas.so.12"]) and any_of(["libcudnn.so.9", "libcudnn.so.8"])


def _detect_device():
    """auto 探测：nvidia-smi 可用 + CUDA 运行时库可加载 → cuda，否则 cpu。"""
    if DEVICE != "auto":
        return DEVICE
    try:
        import subprocess

        subprocess.run(["nvidia-smi"], capture_output=True, timeout=5, check=True)
        if not _cuda_runtime_available():
            return "cpu"
        import ctranslate2

        return "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
    except Exception:
        return "cpu"

# OpenCC 繁→简（whisper 对中文默认输出繁体，转写后统一转简体）；
# 延迟导入：opencc 缺失时仅跳过转换，不阻塞服务启动。
_t2s = None

def _get_t2s():
    global _t2s
    if _t2s is None:
        try:
            import opencc

            _t2s = opencc.OpenCC("t2s")
        except Exception:
            _t2s = False
    return _t2s

def _to_simplified(text, language):
    """中文转写结果统一转简体（俄语/英语等其他语言不受影响）。"""
    if not text or not language or not language.startswith("zh"):
        return text
    c = _get_t2s()
    return c.convert(text) if c else text
TOKEN = os.environ.get("PI_WHISPER_TOKEN", "")

_model = None
_model_lock = threading.Lock()


def _probe_cuda(model):
    """cuda 懒加载坑：WhisperModel 构造不加载 CUDA 运行时（首次转写才 dlopen libcublas），
    构造成功 ≠ CUDA 可用。空转 0.2s 静音强制初始化，失败抛错走 get_model 的降级分支。"""
    import numpy as np

    segs = model.transcribe(np.zeros(3200, dtype=np.float32), language="zh")
    list(segs)


def get_model():
    global _model
    with _model_lock:
        if _model is None:
            from faster_whisper import WhisperModel

            device = _detect_device()
            try:
                _model = _load_model(WhisperModel, device)
                if device == "cuda":
                    _probe_cuda(_model)
            except Exception as e:  # noqa: BLE001
                if device == "cuda":
                    # CUDA 库缺失/加载失败（如 libcublas.so.12 not found，仅驱动可见）时降级 CPU，不阻塞服务
                    print(f"[whisper] CUDA 加载失败 ({e})，降级 CPU 推理", flush=True)
                    device = "cpu"
                    _model = _load_model(WhisperModel, device)
                else:
                    raise
            print(f"[whisper] model {MODEL} ready on {device}", flush=True)
            return _model
        return _model


def _load_model(WhisperModel, device):
    """按设备加载模型；GPU 用 float16（吞吐最优），CPU 用 int8 量化（内存/速度均衡）。"""
    compute_type = "float16" if device == "cuda" else "int8"
    print(f"[whisper] loading model {MODEL} device={device} compute={compute_type} ...", flush=True)
    return WhisperModel(
        MODEL,
        device=device,
        compute_type=compute_type,
        download_root=MODELS_DIR,
    )


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[whisper] %s\n" % (fmt % args))

    def _authorized(self):
        if not TOKEN:
            return True
        return self.headers.get("Authorization") == f"Bearer {TOKEN}"

    def _send(self, code, payload, ctype="application/json"):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self._authorized():
            self._send(401, {"error": "unauthorized"})
            return
        if self.path == "/health":
            # faster-whisper WhisperModel 无 .device，实际设备在内部 ctranslate2 模型上
            dev = _model.model.device if _model is not None and getattr(_model, "model", None) is not None else None
            self._send(200, {
                "ok": _model is not None,
                "model": MODEL,
                "device": dev,
            })
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._authorized():
            self._send(401, {"error": "unauthorized"})
            return
        # self.path 含 query string（?lang=zh），先解析出纯路径再判断
        parsed = urlparse(self.path)
        if parsed.path != "/transcribe":
            self._send(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            self._send(400, {"error": "empty body"})
            return
        # 请求体大小上限（审计：无上限时 Content-Length 任意值直接 read 入内存，
        # 且默认无鉴权，浏览器页面可向 127.0.0.1 POST 任意大 body 耗尽内存）。
        # 64MB 对最长语音（WAV 16kHz 16bit 单声道 ≈ 33 分钟）绰绰有余。
        if length > 64 * 1024 * 1024:
            self._send(413, {"error": "request body too large (max 64MB)"})
            return
        # 语言优先级：请求 query lang > 环境变量 PI_WHISPER_LANGUAGE > 自动检测
        query = parse_qs(parsed.query)
        lang = (query.get("lang") or [None])[0] or LANGUAGE
        try:
            raw = self.rfile.read(length)
            fd, path = tempfile.mkstemp(suffix=".wav", dir=tempfile.gettempdir())
            with os.fdopen(fd, "wb") as f:
                f.write(raw)
            try:
                segments, info = get_model().transcribe(
                    path,
                    language=lang,
                    vad_filter=True,
                )
                text = "".join(s.text.strip() + " " for s in segments).strip()
                text = _to_simplified(text, info.language)
                self._send(200, {"text": text, "language": info.language, "model": MODEL})
            finally:
                os.unlink(path)
        except Exception as e:  # noqa: BLE001
            self._send(500, {"error": str(e)})


def main():
    try:
        get_model()
    except Exception as e:  # noqa: BLE001
        print(f"[whisper] model load failed: {e}", file=sys.stderr, flush=True)
        sys.exit(1)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[whisper] listening on http://127.0.0.1:{PORT} model={MODEL}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
