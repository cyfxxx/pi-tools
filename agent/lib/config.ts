/**
 * config.ts — 配置分层合并（dsh 借鉴：profile/bundle 分层 + patch 覆盖）
 *
 * 背景（2026-08-14 dsh 深度分析）：扩展配置多为"默认值 + 用户覆盖"，
 * 但各扩展实现不一（有的直接读文件、有的读写 settings.json），且无
 * 分层合并能力。本模块提供：
 *   - mergeLayers(...)：多层深合并（后层覆盖前层，数组整体替换非合并，
 *     与 dsh patch"整行替换"语义一致）
 *   - loadUserConfig(path, defaults)：读用户配置文件，缺失字段回落默认
 *
 * 渐进式接入约定（不强制一次性迁移全部扩展）：
 *   新扩展直接使用；存量扩展（pi-voice/pi-link/pi-tmux）择机迁移。
 */

import { readFileSync, existsSync } from "node:fs";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 深拷贝（防合并结果与源层共享引用） */
function cloneDeep<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => cloneDeep(x)) as unknown as T;
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = cloneDeep(val);
    return out as T;
  }
  return v;
}

/**
 * 多层深合并：后层覆盖前层。对象递归合并，数组/标量整体替换。
 * 例：mergeLayers({a:1,b:{x:1}}, {b:{y:2}}) → {a:1,b:{x:1,y:2}}
 * 层可来自不同形状来源；返回类型由调用方断言（默认 Record）。
 * 合并结果全新建（深拷贝），不污染任何源层对象。
 */
export function mergeLayers<T extends object = Record<string, unknown>>(
  ...layers: Array<object | undefined | null>
): T {
  const out: Record<string, unknown> = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      const cur = out[k];
      if (isPlainObject(cur) && isPlainObject(v)) {
        out[k] = mergeLayers(cur, v);
      } else {
        out[k] = cloneDeep(v);
      }
    }
  }
  return out as T;
}

/**
 * 读用户配置：文件存在则与 defaults 深合并；不存在返回 defaults 副本。
 * 不抛错（文件损坏时回退默认 + 返回错误信息），保持扩展启动不因配置崩溃。
 */
export function loadUserConfig<T extends object>(
  path: string,
  defaults: T,
): { config: T; loaded: boolean; error?: string } {
  if (!existsSync(path)) {
    return { config: mergeLayers(defaults), loaded: false };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<T>;
    return { config: mergeLayers(defaults, raw), loaded: true };
  } catch (e) {
    return { config: mergeLayers(defaults), loaded: false, error: String(e) };
  }
}
