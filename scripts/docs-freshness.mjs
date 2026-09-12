#!/usr/bin/env node

/**
 * 文档新鲜度检查脚本
 * 
 * 检查文档是否过期，建议更新
 * 
 * 用法：
 *   node scripts/docs-freshness.mjs          # 检查所有文档
 *   node scripts/docs-freshness.mjs --days 30  # 检查超过 30 天未更新的文档
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ============================================================
// 工具函数
// ============================================================

function findMdFiles(dir, results = []) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'dist', 'packs/drafts'].includes(entry.name)) continue;
      findMdFiles(fullPath, results);
    } else if (entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }
  return results;
}

function readMd(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function extractDate(content) {
  // 尝试从元信息中提取日期
  const metaMatch = content.match(/\| 更新日期 \| (\d{4}-\d{2}-\d{2}) \|/);
  if (metaMatch) return metaMatch[1];
  
  // 尝试从 frontmatter 中提取日期
  const frontMatch = content.match(/更新日期:\s*(\d{4}-\d{2}-\d{2})/);
  if (frontMatch) return frontMatch[1];
  
  return null;
}

function daysSince(dateStr) {
  if (!dateStr) return Infinity;
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now - date;
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

// ============================================================
// 主流程
// ============================================================

function main() {
  const args = process.argv.slice(2);
  const daysIndex = args.indexOf('--days');
  const thresholdDays = daysIndex >= 0 ? parseInt(args[daysIndex + 1]) || 30 : 30;

  // 收集所有 .md 文件
  const files = findMdFiles(ROOT);

  // 过滤出相关文件
  const relevantFiles = files.filter(f => {
    const rel = relative(ROOT, f);
    return rel.startsWith('docs/') ||
           rel.match(/^agent\/extensions\/[^/]+\/README\.md$/) ||
           rel.match(/^agent\/skills\/[^/]+\/SKILL\.md$/) ||
           rel.includes('agent/recovery/README.md');
  });

  // 检查每个文件
  const outdated = [];
  const missing = [];

  for (const file of relevantFiles) {
    const content = readMd(file);
    if (!content) continue;

    const rel = relative(ROOT, file);
    const date = extractDate(content);
    const days = daysSince(date);

    if (!date) {
      missing.push({ file: rel, days: 0 });
    } else if (days > thresholdDays) {
      outdated.push({ file: rel, date, days });
    }
  }

  // 输出结果
  if (outdated.length === 0 && missing.length === 0) {
    console.log(`✅ 所有文档在 ${thresholdDays} 天内已更新`);
  } else {
    console.log(`\n文档新鲜度检查（阈值: ${thresholdDays} 天）:\n`);

    if (missing.length > 0) {
      console.log(`⚠️  缺少更新日期 (${missing.length}):`);
      for (const item of missing) {
        console.log(`   - ${item.file}`);
      }
      console.log();
    }

    if (outdated.length > 0) {
      console.log(`📅 过期文档 (${outdated.length}):`);
      for (const item of outdated) {
        console.log(`   - ${item.file} (最后更新: ${item.date}, ${item.days} 天前)`);
      }
      console.log();
    }

    console.log(`总计: ${missing.length + outdated.length} 个文档需要关注`);
  }

  // 输出 JSON
  if (args.includes('--json')) {
    console.log(JSON.stringify({ outdated, missing }, null, 2));
  }
}

main();