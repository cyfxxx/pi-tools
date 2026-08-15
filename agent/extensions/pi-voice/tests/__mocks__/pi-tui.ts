export type TUI = Record<string, unknown>

export const Key = {
  ctrlAlt(k: string) { return { key: k, ctrl: true, alt: true } },
  return: { key: 'return' },
  shift(k: string) { return { key: k, shift: true } },
  enter: { key: 'enter' },
  escape: { key: 'escape' },
}

export class Container {
  private children: unknown[] = []
  constructor(options?: Record<string, unknown>) {}
  add(child: unknown, options?: Record<string, unknown>) { this.children.push(child) }
  addChild(child: unknown, options?: Record<string, unknown>) { this.children.push(child) }
}

export class Markdown {
  constructor(text: string, options?: Record<string, unknown>) {}
}

export class Spacer {
  constructor(options?: Record<string, unknown>) {}
}

export class Text {
  constructor(text: string, options?: Record<string, unknown>) {}
}
