#!/usr/bin/env node
/**
 * repair-junctions.js — 修复 .pi\agent / .pi\memory 指向真身（agent/ memory/）的 junction。
 *
 * 背景：便携包压缩/解压时 junction 可能被压平成真实目录（.pi\agent 变成普通文件夹，
 * 只含运行期状态、缺 bin/ 等），导致 pi 按 PI_CODING_AGENT_DIR=.pi\agent\bin 找不到
 * fd.exe/rg.exe 而去下载（墙内失败）。此脚本检测并自愈：
 *
 *   1. 真身不存在            -> 跳过（setup 未完成）
 *   2. junction 正常         -> 跳过
 *   3. junction 缺失         -> mklink /J 重建
 *   4. 悬空 junction         -> 删除链接重建
 *   5. 真实目录（压平）      -> 合并 .pi\X 状态到 X（keep-newer，不覆盖更新的目标），
 *                              删旧目录，mklink /J 重建
 *
 * 幂等：可反复运行。文件被占用（如运行中 pi 的会话文件）导致合并不完整时，
 * 本次只做能做的部分并提示 defer，下次启动（pi 未运行）自动完成。
 */
"use strict";

const { existsSync, lstatSync, mkdirSync, copyFileSync, statSync, readdirSync, rmSync } = require("fs");
const { join } = require("path");
const { spawnSync } = require("child_process");

// 包根 = bin/ 的上一级
const root = join(__dirname, "..");

const TARGETS = [
  { pi: join(root, ".pi", "agent"), real: join(root, "agent"), probe: join("bin", "fd.exe"), label: "agent" },
  { pi: join(root, ".pi", "memory"), real: join(root, "memory"), probe: "entries.json", label: "memory" },
];

function log(msg) {
  console.log("[repair-junctions] " + msg);
}

function isReparsePoint(p) {
  const r = spawnSync("fsutil", ["reparsepoint", "query", p], { stdio: "pipe", windowsHide: true });
  return r.status === 0;
}

// junction 可用 = 存在 + 是重解析点 + 探测文件可达（排除悬空链接）
function isJunctionWorking(piPath, probe) {
  if (!existsSync(piPath)) return false;
  if (!isReparsePoint(piPath)) return false;
  return existsSync(join(piPath, probe));
}

/**
 * 合并 src（真实目录）到 dst：目录递归；文件仅当 dst 缺失或 src 更新时复制（keep-newer）。
 * 返回失败列表（被占用的文件无法复制时记录，调用方据此推迟删除）。
 */
function mergeDir(src, dst, failures) {
  if (!existsSync(src)) return;
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    const s = join(src, name);
    const d = join(dst, name);
    let st;
    try {
      st = lstatSync(s);
    } catch (e) {
      failures.push(s + " (lstat: " + e.code + ")");
      continue;
    }
    if (st.isSymbolicLink()) continue; // 不跟随链接（防环）
    if (st.isDirectory()) {
      mergeDir(s, d, failures);
      continue;
    }
    try {
      let needCopy = true;
      if (existsSync(d)) {
        try {
          needCopy = statSync(s).mtimeMs > statSync(d).mtimeMs;
        } catch {
          needCopy = false;
        }
      }
      if (needCopy) {
        copyFileSync(s, d);
        log("  合并 " + s + " -> " + d);
      }
    } catch (e) {
      failures.push(d + " (copy: " + e.code + ")");
    }
  }
}

function makeJunction(piPath, realPath) {
  const r = spawnSync("cmd", ["/c", "mklink", "/J", piPath, realPath], {
    stdio: "pipe",
    windowsHide: true,
    encoding: "utf8",
  });
  const out = (r.stdout || r.stderr || "").toString().trim();
  log("  mklink /J " + piPath + " -> " + realPath + (r.status === 0 ? " [OK]" : " [FAIL] " + out));
  return r.status === 0;
}

for (const t of TARGETS) {
  log("== " + t.label + " ==");
  if (!existsSync(t.real)) {
    log("  跳过：真身目录不存在（" + t.real + "，setup 未完成？）");
    continue;
  }
  if (isJunctionWorking(t.pi, t.probe)) {
    log("  正常（junction 可用）");
    continue;
  }
  if (!existsSync(t.pi)) {
    log("  缺失 -> 创建 junction");
    makeJunction(t.pi, t.real);
    continue;
  }
  if (isReparsePoint(t.pi)) {
    log("  悬空 junction -> 删除链接并重建");
    try {
      rmSync(t.pi, { recursive: true, force: true });
    } catch (e) {
      log("  删除失败：" + e.message + "（下次启动自动重试）");
      continue;
    }
    makeJunction(t.pi, t.real);
    continue;
  }
  log("  真实目录（junction 被压平）-> 合并状态 + 重建");
  const failures = [];
  mergeDir(t.pi, t.real, failures);
  if (failures.length > 0) {
    log("  以下文件被占用，合并不完整，推迟重建（下次启动自动重试）：");
    for (const f of failures) log("    - " + f);
    continue;
  }
  try {
    rmSync(t.pi, { recursive: true, force: true });
  } catch (e) {
    log("  删除旧目录失败（占用）：" + e.message + "（下次启动自动重试）");
    continue;
  }
  makeJunction(t.pi, t.real);
}

log("完成。");
