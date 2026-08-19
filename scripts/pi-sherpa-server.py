#!/usr/bin/env python3
"""pi-voice sherpa-onnx (SenseVoice) 常驻转写服务。

与 whisper-server.py 并列的独立后端：加载 SenseVoice int8 模型一次，
提供 HTTP 接口（Bearer 鉴权与 whisper 一致，端口错开 18768）：
  POST /transcribe  body = 16-bit 16kHz 单声道 PCM WAV → {"text","rtf","duration","model"}
  GET  /health      → {"ok","model","loaded","error"}

环境变量：
  PI_SHERPA_PORT          端口（默认 18768）
  PI_SHERPA_MODELS_DIR    模型根目录（默认 /opt/pi-sherpa/models）
  PI_SHERPA_MODEL_DIR     SenseVoice 模型子目录（默认 sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17）
  PI_SHERPA_MODEL_FILE    模型文件（默认 model.int8.onnx）
  PI_SHERPA_LANGUAGE      识别语言（默认 zh；空 = 自动检测）
  PI_SHERPA_NUM_THREADS   onnxruntime 线程数（默认 2）
  PI_SHERPA_TOKEN         共享令牌；设置后 /health、/transcribe 均要求 Bearer，否则 401

设计原则：
  * 独立进程、HTTP 通信——绝不加载进 pi 的 Node 进程（原生库崩溃不影响 pi）
  * 模型懒加载 + 线程锁；解码串行（CPU 密集，pi-voice 同时只转一条）
  * 服务端不依赖 ffmpeg：客户端上传前需转 16k 单声道（扩展已有 convertToWav）
"""

import io
import json
import os
import re
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

PORT = int(os.environ.get("PI_SHERPA_PORT", "18768"))
MODELS_DIR = os.environ.get("PI_SHERPA_MODELS_DIR", "/opt/pi-sherpa/models")
MODEL_DIRNAME = os.environ.get(
    "PI_SHERPA_MODEL_DIR", "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"
)
MODEL_FILE = os.environ.get("PI_SHERPA_MODEL_FILE", "model.int8.onnx")
LANGUAGE = os.environ.get("PI_SHERPA_LANGUAGE", "zh")
NUM_THREADS = int(os.environ.get("PI_SHERPA_NUM_THREADS", "4"))
TOKEN = os.environ.get("PI_SHERPA_TOKEN", "")
MAX_BODY = int(os.environ.get("PI_SHERPA_MAX_BODY", "67108864"))  # 64MB

MODEL_PATH = os.path.join(MODELS_DIR, MODEL_DIRNAME, MODEL_FILE)
TOKENS_PATH = os.path.join(MODELS_DIR, MODEL_DIRNAME, "tokens.txt")

_rec = None
_rec_lock = threading.Lock()
_decode_lock = threading.Lock()


def _load_rec():
    """懒加载 SenseVoice 识别器（首次请求时），线程安全。"""
    global _rec
    with _rec_lock:
        if _rec is None:
            import numpy as np  # noqa: F401  确保依赖可用性检查
            import sherpa_onnx

            for p in (MODEL_PATH, TOKENS_PATH):
                if not os.path.isfile(p):
                    raise FileNotFoundError(f"SenseVoice 模型缺失: {p}")
            t0 = time.time()
            _rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(
                model=MODEL_PATH,
                tokens=TOKENS_PATH,
                num_threads=NUM_THREADS,
                sample_rate=16000,
                feature_dim=80,
                language=LANGUAGE,
                use_itn=True,
            )
            print(
                f"[sherpa] SenseVoice 就绪 {MODEL_DIRNAME} "
                f"加载耗时 {time.time() - t0:.1f}s (language={LANGUAGE or 'auto'})",
                flush=True,
            )
        return _rec


def _strip_tags(s):
    """去掉 SenseVoice 输出的 <|...|> 控制标签。"""
    return re.sub(r"<\|[^>]*\|>", "", s).strip()

# ---- KWS 唤醒（Keyword Spotting） ----
PI_SHERPA_KWS_DIR = os.environ.get("PI_SHERPA_KWS_DIR", "sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01")
KWS_DIR = os.path.join(MODELS_DIR, PI_SHERPA_KWS_DIR)
KWS_KEYWORDS_FILE = os.environ.get("PI_SHERPA_KWS_KEYWORDS", os.path.join(MODELS_DIR, "wakeup_keywords.txt"))
# 默认唤醒词（见扩展 /voice wake 文档）：可自定义同格式拼音序列，每行一个
DEFAULT_WAKEUP_KEYWORDS = "k āi q ǐ y ǔ y īn sh ū r ù @开启语音输入\n"

_kws = None
_kws_lock = threading.Lock()


def _load_kws():
    """懒加载 KWS 检测器；keywords 文件缺失时自动生成含默认唤醒词的配置文件。"""
    global _kws
    with _kws_lock:
        if _kws is None:
            import numpy as np  # noqa: F401
            import sherpa_onnx

            encoder = os.path.join(KWS_DIR, "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx")
            decoder = os.path.join(KWS_DIR, "decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx")
            joiner = os.path.join(KWS_DIR, "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx")
            tokens = os.path.join(KWS_DIR, "tokens.txt")
            for p in (encoder, decoder, joiner, tokens):
                if not os.path.isfile(p):
                    raise FileNotFoundError(f"KWS 模型缺失: {p}（请从 modelscope 镜像下载 sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01）")
            if not os.path.isfile(KWS_KEYWORDS_FILE):
                os.makedirs(os.path.dirname(KWS_KEYWORDS_FILE), exist_ok=True)
                with open(KWS_KEYWORDS_FILE, "w", encoding="utf-8") as f:
                    f.write(DEFAULT_WAKEUP_KEYWORDS)
            t0 = time.time()
            _kws = sherpa_onnx.KeywordSpotter(
                tokens=tokens, encoder=encoder, decoder=decoder, joiner=joiner,
                keywords_file=KWS_KEYWORDS_FILE, num_threads=2,
            )
            print(f"[sherpa] KWS 就绪 {os.path.basename(KWS_DIR)} ({KWS_KEYWORDS_FILE}) 加载耗时 {time.time() - t0:.2f}s", flush=True)
        return _kws


def wake_detect(pcm_bytes):
    """对一段 16k/16bit/单声道裸 PCM 做唤醒词检测（无状态：每次全新 stream）。
    返回 (hits, 音频秒数)。命中列表 = 检测到的关键词文本。"""
    import numpy as np

    if not pcm_bytes or len(pcm_bytes) < 512:
        return [], 0.0
    kws = _load_kws()
    x = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
    tail = np.zeros(int(0.66 * 16000), dtype=np.float32)
    s = kws.create_stream()
    s.accept_waveform(16000, x)
    s.accept_waveform(16000, tail)
    s.input_finished()
    hits = []
    while kws.is_ready(s):
        kws.decode_stream(s)
        r = kws.get_result(s)
        if r != "":
            hits.append(r)
            kws.reset_stream(s)
    return hits, len(x) / 16000.0


def transcribe(wav_bytes):
    """整段 WAV → (text, rtf, duration)。输入须为 16k/单声道/16bit。"""
    rec = _load_rec()
    wf = wave.open(io.BytesIO(wav_bytes), "rb")
    try:
        sr, ch, sw, nf = wf.getframerate(), wf.getnchannels(), wf.getsampwidth(), wf.getnframes()
        if sr != 16000:
            raise ValueError("采样率须为 16000Hz（客户端请先转 16k 再上传）")
        if ch != 1:
            raise ValueError("须单声道")
        if sw != 2:
            raise ValueError("须 16bit PCM")
        raw = wf.readframes(nf) if nf else b""
    finally:
        wf.close()
    if not raw:
        return "", 0.0, 0.0
    import numpy as np

    x = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    s = rec.create_stream()
    s.accept_waveform(16000, x)
    t0 = time.time()
    with _decode_lock:  # onnxruntime 解码串行
        rec.decode_stream(s)
    dt = time.time() - t0
    print(f"[sherpa] decode {dt:.3f}s frames={len(x)} threads={NUM_THREADS}", flush=True)
    dur = nf / sr
    return _strip_tags(s.result.text), (dt / dur if dur else 0.0), dur


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # 静默访问日志
        pass

    def _authorized(self):
        return (not TOKEN) or self.headers.get("Authorization") == f"Bearer {TOKEN}"

    def _send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self._authorized():
            return self._send_json(401, {"ok": False, "error": "unauthorized"})
        u = urlparse(self.path)
        if u.path == "/health":
            try:
                _load_rec()
                self._send_json(200, {"ok": True, "model": MODEL_DIRNAME, "loaded": True, "error": None})
            except Exception as e:  # noqa: BLE001
                self._send_json(200, {"ok": False, "model": MODEL_DIRNAME, "loaded": False, "error": str(e)})
        else:
            self._send_json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if not self._authorized():
            return self._send_json(401, {"ok": False, "error": "unauthorized"})
        u = urlparse(self.path)
        if u.path == "/wake":
            length = int(self.headers.get("Content-Length", "0") or 0)
            if length <= 0 or length > MAX_BODY:
                return self._send_json(400, {"ok": False, "error": "bad body"})
            body = self.rfile.read(length)
            try:
                hits, sec = wake_detect(body)
                self._send_json(200, {"ok": True, "hits": hits, "seconds": round(sec, 3)})
            except Exception as e:  # noqa: BLE001
                self._send_json(500, {"ok": False, "error": f"wake error: {e}"})
            return
        if u.path != "/transcribe":
            return self._send_json(404, {"ok": False, "error": "not found"})
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length <= 0:
            return self._send_json(400, {"ok": False, "error": "empty body"})
        if length > MAX_BODY:
            return self._send_json(413, {"ok": False, "error": "body too large"})
        body = self.rfile.read(length)
        try:
            text, rtf, dur = transcribe(body)
            self._send_json(200, {"ok": True, "text": text, "rtf": round(rtf, 4), "duration": round(dur, 3), "model": MODEL_DIRNAME})
        except ValueError as e:
            self._send_json(400, {"ok": False, "error": str(e)})
        except Exception as e:  # noqa: BLE001
            self._send_json(500, {"ok": False, "error": f"transcribe error: {e}"})


def main():
    print(f"[sherpa] listening on 127.0.0.1:{PORT} (model {MODEL_DIRNAME}, token {'on' if TOKEN else 'off'})", flush=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
