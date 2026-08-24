#!/usr/bin/env bash
# generate-config.sh — 生成 SearXNG settings.yml
# 用法:
#   ./generate-config.sh           已存在则跳过（幂等）
#   ./generate-config.sh --force   强制重新生成（默认引擎分组：国内可达启用/GFW 封锁禁用）
#   ./generate-config.sh --probe   连通性探测后生成（环境自适应：可达启用，不可达禁用）
#   ./generate-config.sh --force --probe  强制 + 探测
# 生成后若 SearXNG 正在运行则自动重启加载新配置。
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$DIR/settings.yml"

FORCE=0; PROBE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --probe) PROBE=1 ;;
    *) echo "未知参数: $arg（支持 --force / --probe）" >&2 ;;
  esac
done

if [ -f "$CONFIG" ] && [ "$FORCE" != "1" ]; then
  echo "settings.yml 已存在，跳过（使用 --force 覆盖 / --probe 探测后覆盖）"
  exit 0
fi

# 候选引擎: "名称|探测URL"（探测用 HEAD 请求看连通性；bing 保留 base_url 特写）
ENGINE_PROBES=(
  "baidu|https://www.baidu.com"
  "bing|https://cn.bing.com"
  "sogou|https://www.sogou.com"
  "360search|https://www.so.com"
  "bilibili|https://search.bilibili.com"
  "yandex|https://yandex.com"
  "stackoverflow|https://stackoverflow.com"
  "github|https://github.com"
  "google|https://www.google.com"
  "duckduckgo|https://duckduckgo.com"
  "wikipedia|https://zh.wikipedia.org"
  "brave|https://search.brave.com"
  "yahoo|https://search.yahoo.com"
  "startpage|https://www.startpage.com"
  "wikidata|https://www.wikidata.org"
)

probe_reachable() {
  # 两次探测（防单次抖动）；非 000（连接成功）即视为可达
  local url="$1" code
  code=$(curl -sI -o /dev/null -w '%{http_code}' --max-time 4 -A "Mozilla/5.0" "$url" 2>/dev/null)
  [ "$code" != "000" ] && [ -n "$code" ]
}

# 探测全部引擎，构建可达集合（空格分隔）
REACHABLE=""
if [ "$PROBE" = "1" ]; then
  echo "探测 ${#ENGINE_PROBES[@]} 个引擎连通性（每个最多 4s）..."
  for entry in "${ENGINE_PROBES[@]}"; do
    name="${entry%%|*}"; url="${entry##*|}"
    if probe_reachable "$url"; then
      REACHABLE="$REACHABLE $name"
      echo "  ✓ $name ($url)"
    else
      echo "  ✗ $name ($url)"
    fi
  done
fi

# 引擎 disabled 判定：--probe 时按探测结果；否则按国内可达默认分组
engine_disabled() {
  local name="$1"
  if [ "$PROBE" = "1" ]; then
    case " $REACHABLE " in
      *" $name "*) echo "false" ;;
      *) echo "true" ;;
    esac
  else
    case "$name" in
      baidu|bing|sogou|360search|bilibili|yandex|stackoverflow|github) echo "false" ;;
      *) echo "true" ;;
    esac
  fi
}

SECRET_KEY=$(openssl rand -hex 32)

cat > "$CONFIG" <<CONFIGEOF
use_default_settings: true

general:
  debug: false
  instance_name: ".pi SearXNG"

search:
  safe_search: 0
  autocomplete: 'duckduckgo'
  formats:
    - html
    - json

server:
  secret_key: "$SECRET_KEY"
  limiter: false
  image_proxy: true
  bind_address: "127.0.0.1"
  port: 8889

ui:
  static_use_hash: true
  default_theme: simple
  default_locale: zh-Hans-CN

enabled_plugins:
  - 'Basic Calculator'
  - 'Hash plugin'
  - 'Self Information'
  - 'Tracker URL scraper'
  - 'Search on category select'

outgoing:
  request_timeout: 10
  max_request_timeout: 30
  useragent_suffix: ""
  max_redirects: 5

engines:
$(for entry in "${ENGINE_PROBES[@]}"; do
  name="${entry%%|*}"
  echo "  - name: $name"
  if [ "$name" = "bing" ]; then
    echo "    engine: bing"
    echo "    base_url: https://cn.bing.com"
  fi
  echo "    disabled: $(engine_disabled "$name")"
done)
CONFIGEOF

# 含 secret_key，仅 owner 可读（防全局可读泄露）；不回显密钥
chmod 600 "$CONFIG"
echo "已生成 $CONFIG（secret_key 已写入文件，不回显）"

# 自动重启 SearXNG（如果正在运行）
PID_FILE="$DIR/searxng.pid"
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "检测到 SearXNG 正在运行，自动重启以加载新配置..."
  bash "$DIR/stop.sh" 2>/dev/null
  sleep 1
  bash "$DIR/start.sh" 2>/dev/null || echo "重启失败，请手动运行: $DIR/start.sh"
fi
