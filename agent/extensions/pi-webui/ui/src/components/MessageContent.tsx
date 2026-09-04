/**
 * Markdown 消息内容渲染
 * 轻量级实现：支持基础 markdown，无外部依赖
 */

import React, { useMemo } from 'react'

interface MessageContentProps {
  content: string
}

/**
 * 简单的 markdown 解析器
 * 支持：粗体、斜体、行内代码、删除线、代码块、链接
 */
function parseMarkdown(content: string): React.ReactNode[] {
  // 先按代码块分割
  const blocks = content.split(/(\n```[\s\S]*?```\n?)/g)

  return blocks.flatMap((block, blockIndex) => {
    // 代码块
    if (block.startsWith('```')) {
      const lines = block.trim().split('\n')
      if (lines.length < 2) {
        return <pre key={`code-${blockIndex}`} className="code-block"><code>{block}</code></pre>
      }
      const lang = lines[0]?.slice(3).trim() || 'text'
      const code = lines.slice(1, -1).join('\n')
      return <CodeBlock key={`code-${blockIndex}`} lang={lang} code={code} />
    }

    // 行内内容：按段落分割
    const paragraphs = block.split(/\n\n+/)
    return paragraphs.flatMap((para, paraIndex) => {
      if (!para.trim()) return []
      const elements = parseInline(para.trim())
      return <p key={`p-${blockIndex}-${paraIndex}`}>{elements}</p>
    })
  })
}

function parseInline(text: string): React.ReactNode[] {
  // 匹配顺序重要：代码块 > 链接 > 粗体/斜体 > 删除线
  // 使用正则分割但保留分隔符
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~|\[[^\]]+\]\([^)]+\))/g)

  return parts.map((part, i) => {
    if (!part) return null

    // 行内代码
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={i} className="inline-code">{part.slice(1, -1)}</code>
    }

    // 粗体
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>
    }

    // 斜体
    if (part.startsWith('*') && part.endsWith('*')) {
      return <em key={i}>{part.slice(1, -1)}</em>
    }

    // 删除线
    if (part.startsWith('~~') && part.endsWith('~~')) {
      return <del key={i}>{part.slice(2, -2)}</del>
    }

    // 链接 [text](url)
    const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
    if (linkMatch) {
      return (
        <a
          key={i}
          href={linkMatch[2]}
          target="_blank"
          rel="noopener noreferrer"
          className="message-link"
        >
          {linkMatch[1]}
        </a>
      )
    }

    return <span key={i}>{part}</span>
  }).filter(Boolean)
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  return (
    <pre className="code-block">
      <code className={`language-${lang}`}>{code}</code>
    </pre>
  )
}

export function MessageContent({ content }: MessageContentProps) {
  const elements = useMemo(() => parseMarkdown(content), [content])
  return <div className="message-content">{elements}</div>
}