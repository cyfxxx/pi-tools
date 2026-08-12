#!/usr/bin/env bash
# smoke-test.sh — 重建后端到端冒烟测试
# 覆盖：SearXNG / pi-web-search 配置 / whisper 转写 / 浏览器 / tmux / 记忆 / autopilot 调度 / TUI 补丁 / 状态循环
# 用法: bash scripts/smoke-test.sh
# 退出码: 0=全部通过或跳过，1=有失败
set -uo pipefail

PI_HOME="${PI_HOME:-$HOME/.pi}"
PASS=0; FAIL=0; SKIP=0
ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
skip() { SKIP=$((SKIP+1)); echo "  - $1 (跳过)"; }

echo "[1/8] SearXNG API"
if curl -s --max-time 30 "http://127.0.0.1:8889/search?q=smoke&format=json" 2>/dev/null \
   | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if len(d.get('results',[]))>0 else 1)" 2>/dev/null; then
  ok "SearXNG 返回结果"
else
  fail "SearXNG 不可达或无结果（启动: $PI_HOME/searxng/start.sh；聚合慢时 --max-time 放宽到 30s+）"
fi

echo "[2/8] pi-web-search 配置"
if python3 -c "import json,sys; d=json.load(open('$PI_HOME/agent/settings.json')); ws=d.get('pi-web-search',{}); sys.exit(0 if '127.0.0.1:8889' in ws.get('searxng_url','') else 1)" 2>/dev/null; then
  ok "settings.json 指向本地 SearXNG"
else
  fail "pi-web-search 未指向本地 SearXNG（重跑 rebuild.sh 或手动配置 settings.json）"
fi

echo "[3/8] whisper 转写服务"
TMPWAV=$(mktemp --suffix=.wav)
if command -v piper >/dev/null 2>&1 && [ -f /opt/pi-tts/models/zh_CN-huayan-medium.onnx ]; then
  echo "你好，这是语音转写功能测试。" | piper -m /opt/pi-tts/models/zh_CN-huayan-medium.onnx -f "$TMPWAV" >/dev/null 2>&1
  RESP=$(curl -s --max-time 90 --data-binary @"$TMPWAV" "http://127.0.0.1:18766/transcribe?lang=zh" 2>/dev/null)
  if echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); t=d.get('text',''); sys.exit(0 if len(t)>0 else 1)" 2>/dev/null; then
    ok "whisper 转写成功"
  else
    fail "whisper 转写失败（服务: $PI_HOME/scripts/pi-whisper.sh start）"
  fi
else
  skip "piper 未安装，转写测试跳过"
fi
rm -f "$TMPWAV"

echo "[4/8] 浏览器（CloakBrowser）"
if (cd "$PI_HOME/agent/extensions/pi-browser" && timeout 90 node --input-type=module -e "
import { launch } from 'cloakbrowser';
try {
  const b = await launch({ headless: true });
  const page = await b.newPage();
  await page.goto('https://example.com', { timeout: 30000 });
  const t = await page.title();
  await b.close();
  console.log(t === 'Example Domain' ? 'OK' : 'TITLE:' + t);
} catch (e) { console.log('FAIL:' + e.message); }
" 2>/dev/null | grep -q "^OK"); then
  ok "浏览器可打开页面"
else
  fail "浏览器不可用（安装: cd $PI_HOME && npx cloakbrowser install；缺库: apt-get install libnss3 libnspr4）"
fi

echo "[5/8] tmux"
if command -v tmux >/dev/null 2>&1 \
   && tmux new-session -d -s smoke-test 'bash -c "sleep 2"' 2>/dev/null; then
  sleep 0.5
  if tmux has-session -t smoke-test 2>/dev/null; then
    ok "tmux 会话可创建"
    tmux kill-session -t smoke-test 2>/dev/null
  else
    fail "tmux 会话创建后即退出"
  fi
else
  fail "tmux 不可用"
fi

echo "[6/8] 记忆数据"
if [ -f "$PI_HOME/memory/entries.json" ] && python3 -c "import json; json.load(open('$PI_HOME/memory/entries.json'))" 2>/dev/null; then
  ok "memory/entries.json 有效"
else
  fail "memory/entries.json 缺失或无效"
fi

echo "[7/8] autopilot 离线调度"
if command -v crontab >/dev/null 2>&1 && crontab -l 2>/dev/null | grep -q pi-cron; then
  ok "crontab 已安装 pi-cron"
else
  skip "未安装 crontab 调度（可选: $PI_HOME/scripts/install-cron.sh）"
fi

echo "[8/8] TUI 补丁 + 状态循环"
PI_ROOT=""
if [ -d "$HOME/.local/share/pi-node/current" ]; then
  PI_ROOT="$(readlink -f "$HOME/.local/share/pi-node/current" 2>/dev/null || echo "$HOME/.local/share/pi-node/current")"
fi
[ -z "$PI_ROOT" ] && PI_ROOT="$(ls -d "$HOME/.local/share/pi-node"/*/ 2>/dev/null | head -1 | sed 's|/$||')"
DIST="$PI_ROOT/lib/node_modules/@earendil-works/pi-coding-agent/dist"
PATCHED=0
for entry in "modes/interactive/components/footer.js:Patch (patch-footer-live-context.mjs)" \
             "modes/interactive/interactive-mode.js:Patch (patch-voice-enter.mjs)" \
             "core/agent-session.js:Patch (patch-plan-tools.mjs)"; do
  file="${entry%%:*}"; marker="${entry##*:}"
  if [ -f "$DIST/$file" ] && grep -qF "$marker" "$DIST/$file" 2>/dev/null; then
    PATCHED=$((PATCHED+1))
  fi
done
if [ "$PATCHED" = "3" ]; then
  ok "3 个 TUI 补丁已应用"
else
  fail "TUI 补丁未全应用（$PATCHED/3，重跑 rebuild.sh Phase 3）"
fi
if pgrep -f "status-loop.sh" >/dev/null 2>&1 && [ -f /tmp/tmux-status.txt ] && [ -s /tmp/tmux-status.txt ]; then
  ok "tmux 状态循环运行中"
else
  skip "tmux 状态循环未运行（tmux 启动后自动拉起；或手动: ~/.pi/tmux/status-loop.sh &）"
fi

echo
if [ "$FAIL" = "0" ]; then
  echo "✓ 全部通过（$PASS 通过 / $SKIP 跳过）"
  exit 0
else
  echo "✗ $FAIL 项失败（$PASS 通过 / $SKIP 跳过）"
  exit 1
fi
