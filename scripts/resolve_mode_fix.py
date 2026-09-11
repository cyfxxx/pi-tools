#!/usr/bin/env python3
"""Replace the resolve_mode function in pi-wrapper.sh with a corrected version."""

path = '/root/.pi/scripts/pi-wrapper.sh'

with open(path, 'r', encoding='utf-8', errors='replace') as f:
    s = f.read()

start = s.index('# pi-mode: 解析 --mode/-m 参数并翻译为 CLI 标志')
end_marker = '}\nwhile true; do'
end = s.index(end_marker)
before = s[:start]
after = s[end + len(end_marker):]

new_func = '''# pi-mode: 解析 --mode/-m 参数并翻译为 CLI 标志
# 用法: pi --mode light 或 pi -m light
resolve_mode() {
  local mode_name=""
  local new_args=()
  local skip_next=false

  for ((i=1; i<=$#; i++)); do
    local arg="${!i}"
    if [ "$skip_next" = true ]; then
      skip_next=false
      continue
    fi
    if [ "$arg" = "--mode" ] || [ "$arg" = "-m" ]; then
      local next_i=$((i+1))
      mode_name="${!next_i}"
      skip_next=true
      continue
    fi
    new_args+=("$arg")
  done

  # 没有 -m/--mode 参数时，fallback 到 modes.json 的 current 字段
  if [ -z "$mode_name" ]; then
    local current_mode
    current_mode=$(node -e "
      const fs = require('fs');
      try {
        const modes = JSON.parse(fs.readFileSync('$HOME/.pi/agent/modes.json', 'utf-8'));
        console.log(modes.current || modes.default || 'full');
      } catch(e) { console.log('full'); }
    " 2>/dev/null)
    if [ -n "$current_mode" ] && [ "$current_mode" != "full" ]; then
      mode_name="$current_mode"
      echo "[pi-wrapper] 无 -m 参数，fallback 到 modes.json current: $mode_name" >&2
    fi
  fi

  # 如果仍然没有 mode_name，说明没有指定模式，返回原始参数
  if [ -z "$mode_name" ]; then
    eval "set -- \"\$@\""
    return
  fi

  # 读取 modes.json 并翻译为 CLI 标志
  local modes_file="$HOME/.pi/agent/modes.json"
  if [ ! -f "$modes_file" ]; then
    echo "[pi-wrapper] 模式配置文件不存在: $modes_file" >&2
    eval "set -- \"\$@\""
    return
  fi

  local mode_config
  mode_config=$(node -e "
    const fs = require('fs');
    try {
      const modes = JSON.parse(fs.readFileSync('$modes_file', 'utf-8'));
      const mode = modes.modes['$mode_name'];
      if (!mode) { console.log('{}'); process.exit(0); }
      console.log(JSON.stringify(mode));
    } catch(e) { console.log('{}'); }
  " 2>/dev/null)

  local extra_args=()

  # 扩展处理：!ALL 禁用所有扩展
  local no_ext
  no_ext=$(echo "$mode_config" | node -e "
    const m=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
    console.log((m.extensions||[]).includes('!ALL')?'yes':'no');
  " 2>/dev/null)
  if [ "$no_ext" = "yes" ]; then
    extra_args+=("--no-extensions")
  fi

  # 技能处理：!ALL 禁用所有技能
  local no_skills
  no_skills=$(echo "$mode_config" | node -e "
    const m=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
    console.log((m.skills||[]).includes('!ALL')?'yes':'no');
  " 2>/dev/null)
  if [ "$no_skills" = "yes" ]; then
    extra_args+=("--no-skills")
  fi

  # 系统提示词处理
  local sys_prompt
  sys_prompt=$(echo "$mode_config" | node -e "
    const m=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
    console.log(m.systemPrompt||'');
  " 2>/dev/null)
  if [ -n "$sys_prompt" ] && [ "$sys_prompt" != "null" ]; then
    # 展开 ~ 为 $HOME
    sys_prompt="${sys_prompt/#\~\//$HOME/}"
    extra_args+=("--system-prompt" "$sys_prompt")
  fi

  # 追加系统提示词处理
  local append_prompt
  append_prompt=$(echo "$mode_config" | node -e "
    const m=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
    console.log(m.appendSystemPrompt||'');
  " 2>/dev/null)
  if [ -n "$append_prompt" ] && [ "$append_prompt" != "null" ]; then
    # 展开 ~ 为 $HOME
    append_prompt="${append_prompt/#\~\//$HOME/}"
    extra_args+=("--append-system-prompt" "$append_prompt")
  fi

  # 设置环境变量供扩展使用
  export PI_AGENT_MODE="$mode_name"
  echo "[pi-wrapper] 启用模式: $mode_name" >&2

  # 从原始参数中移除 -m/--mode 以避免传给 CLI（CLI 不识别短参数）
  local cli_args=()
  local skip_next_arg=false
  for arg in "${@:3}"; do
    if [ "$skip_next_arg" = true ]; then
      skip_next_arg=false
      continue
    fi
    if [ "$arg" = "--mode" ] || [ "$arg" = "-m" ]; then
      skip_next_arg=true
      continue
    fi
    cli_args+=("$arg")
  done

  # 合并参数：模式相关标志 + 过滤后的原始参数
  set -- "${extra_args[@]}" "${cli_args[@]}"
}
'''

new = before + new_func + after

with open(path, 'w', encoding='utf-8') as f:
    f.write(new)

print('Done')
