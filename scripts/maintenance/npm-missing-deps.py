#!/usr/bin/env python3
"""npm-missing-deps.py — 检测 node_modules 中缺失/损坏/版本不匹配的依赖包。

用法: python3 npm-missing-deps.py <pkg_dir>
输出: 空格分隔的缺失包名列表（空=齐备，PKGERR=package.json 解析失败）

判据:
  - 目录缺失 → 缺失
  - 包损坏（无/坏 package.json）→ 缺失
  - 版本 major.minor 与声明范围不匹配 → 缺失
  - 范围语义：^ 同 major 且 ≥锚点 / ~ 与 >= 按锚点比较 / 精确按 major.minor
  - 无法解析的范围（*/x/git/url）退回仅按目录存在判定
"""
import json, os, re, sys


def ver_pair(s):
    m = re.match(r'^v?(\d+)\.(\d+)', s or '')
    return (int(m.group(1)), int(m.group(2))) if m else None


def spec_ok(inst, spec):
    for part in spec.split('||'):
        m = re.match(r'^\s*([\^~>=]*)\s*v?(\d+)(?:\.(\d+))?', part)
        if not m:
            return True  # */x/git/url 等无法解析 → 目录存在即视为满足
        op = m.group(1)
        anchor = (int(m.group(2)), int(m.group(3) or 0))
        if op.startswith('^'):
            if inst[0] == anchor[0] and inst >= anchor:
                return True
        elif op.startswith('~') or not op:
            if inst == anchor:
                return True
        elif op.startswith('>='):
            if inst >= anchor:
                return True
    return False


def main():
    pkg_dir = sys.argv[1]
    try:
        d = json.load(open(os.path.join(pkg_dir, 'package.json')))
    except Exception:
        print('PKGERR')
        sys.exit(0)

    deps = {**d.get('dependencies', {}), **d.get('devDependencies', {})}
    nm = os.path.join(pkg_dir, 'node_modules')

    missing = []
    for k, spec in deps.items():
        d_dir = os.path.join(nm, k)
        if not os.path.isdir(d_dir):
            missing.append(k)
            continue
        try:
            inst = ver_pair(json.load(open(os.path.join(d_dir, 'package.json'))).get('version', ''))
        except Exception:
            missing.append(k)  # 残留/损坏的包目录
            continue
        if inst is None or not spec_ok(inst, spec):
            missing.append(k)
    print(' '.join(missing))


if __name__ == '__main__':
    main()