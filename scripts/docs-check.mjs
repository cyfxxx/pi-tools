#!/usr/bin/env node

/**
 * 文档质量检查脚本
 * 
 * 自动检测：
 * - 缺少元信息表格的文件
 * - 缺少目录导航的文件
 * - 断裂的相对链接
 * - 格式不一致
 * 
 * 用法：
 *   node scripts/docs-check.mjs          # 检查所有文档
 *   node scripts/docs-check.mjs --json   # JSON 输出
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname, resolve, relative } from 'path';
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

function getLinks(content) {
  const links = [];
  const re = /\[([^\]]*)\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(content))) {
    links.push({ text: m[1], href: m[2], index: m.index });
  }
  return links;
}

function resolveLink(fromFile, href) {
  if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('#')) {
    return null;
  }
  const [filePart, anchor] = href.split('#');
  if (!filePart) return null;
  const dir = dirname(fromFile);
  const target = resolve(dir, filePart);
  
  // 检查多种可能的路径
  return {
    target,
    anchor,
    exists: existsSync(target) || 
             existsSync(target + '.md') || 
             existsSync(target + '/README.md') ||
             existsSync(target + '.json')
  };
}

// ============================================================
// 检查规则
// ============================================================

function checkFile(filePath) {
  const issues = [];
  const content = readMd(filePath);
  if (!content) return issues;

  const rel = relative(ROOT, filePath);

  // 1. 检查元信息表格
  const hasMeta = /^## 元信息$/m.test(content) || /\| 版本 \|/.test(content);
  if (!hasMeta && !filePath.includes('TEMPLATE') && !filePath.includes('PROGRESS')) {
    issues.push({ file: rel, type: 'missing-meta', message: '缺少元信息表格' });
  }

  // 2. 检查目录导航
  const hasToc = /^## 目录$/m.test(content) || /^## 目录导航$/m.test(content);
  if (!hasToc && !filePath.includes('TEMPLATE') && !filePath.includes('PROGRESS') && !filePath.includes('COMPLETE')) {
    issues.push({ file: rel, type: 'missing-toc', message: '缺少目录导航' });
  }

  // 3. 检查断裂链接
  const links = getLinks(content);
  for (const link of links) {
    if (link.href.startsWith('http') || link.href.startsWith('#')) continue;
    const resolved = resolveLink(filePath, link.href);
    if (resolved && !resolved.exists) {
      issues.push({ file: rel, type: 'broken-link', message: `断裂链接: ${link.href}`, href: link.href });
    }
  }

  // 4. 检查标题格式
  const h1Count = (content.match(/^# /gm) || []).length;
  if (h1Count > 1) {
    issues.push({ file: rel, type: 'multiple-h1', message: `多个 H1 标题 (${h1Count})` });
  }

  return issues;
}

// ============================================================
// 主流程
// ============================================================

function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');

  // 收集所有 .md 文件
  const files = findMdFiles(ROOT);

  // 过滤出相关文件
  const relevantFiles = files.filter(f => {
    const rel = relative(ROOT, f);
    return rel.startsWith('docs/') ||
           rel.match(/^agent\/extensions\/[^/]+\/README\.md$/) ||
           rel.match(/^agent\/skills\/[^/]+\/SKILL\.md$/) ||
           rel.includes('agent/recovery/README.md') ||
           rel.includes('agent/AGENTS.md') ||
           rel === 'README.md';
  });

  // 检查每个文件
  const allIssues = [];
  for (const file of relevantFiles) {
    const issues = checkFile(file);
    allIssues.push(...issues);
  }

  // 输出结果
  if (jsonMode) {
    console.log(JSON.stringify(allIssues, null, 2));
  } else {
    if (allIssues.length === 0) {
      console.log('✅ 所有文档检查通过');
    } else {
      console.log(`\n发现 ${allIssues.length} 个问题：\n`);
      
      // 按类型分组
      const byType = {};
      for (const issue of allIssues) {
        byType[issue.type] = byType[issue.type] || [];
        byType[issue.type].push(issue);
      }

      for (const [type, issues] of Object.entries(byType)) {
        const icon = {
          'missing-meta': '📋',
          'missing-toc': '📑',
          'broken-link': '🔗',
          'multiple-h1': '📝',
        }[type] || '⚠️';

        console.log(`${icon} ${issues[0].message}`);
        for (const issue of issues) {
          console.log(`   - ${issue.file}${issue.href ? ` (${issue.href})` : ''}`);
        }
        console.log();
      }

      console.log(`总计: ${allIssues.length} 个问题`);
    }
  }

  // 退出码
  process.exit(allIssues.length > 0 ? 1 : 0);
}

main();