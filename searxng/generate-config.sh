#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$DIR/settings.yml"

if [ -f "$CONFIG" ] && [ "$1" != "--force" ]; then
  echo "settings.yml 已存在，跳过（使用 --force 覆盖）"
  exit 0
fi

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
  request_timeout: 5.0
  max_request_timeout: 10.0
  useragent_suffix: ""
  extra_proxy_timeout: 5
  max_redirects: 5

engines:
  # 国内网络下仅 bing 和 baidu 稳定可达
  - name: bing
    disabled: false
  - name: baidu
    disabled: false
  # 以下引擎在国内网络环境下可能因 DNS/GFW 不可达，需按需启用
  - name: duckduckgo
    disabled: true
  - name: google
    disabled: true
  - name: wikipedia
    disabled: true
  - name: stackoverflow
    disabled: true
  - name: github
    disabled: true
  - name: yahoo
    disabled: true
  - name: brave
    disabled: true
CONFIGEOF

chmod 644 "$CONFIG"
echo "已生成 $CONFIG"
echo "secret_key: ${SECRET_KEY}"
