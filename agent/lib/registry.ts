/**
 * registry.ts — 轻量注册表（dsh 借鉴：注册即 effect，卸载即逆序回滚）
 *
 * 背景（2026-08-14 dsh 深度分析）：pi 扩展钩子/工具注册无注销 API，扩展
 * 重载或测试场景无法清理。本模块提供统一登记 + dispose 语义：
 *   - register() 返回精确 disposer，多次 register 的 disposer 按逆序执行
 *   - 测试可 clear() 全量清理，杜绝跨用例状态泄漏
 *   - 不做类型魔法，只解决"登记→清理"这个最小的生命周期问题
 */

export interface RegistryEntry<T> {
  key: string;
  value: T;
  /** 注册序号（dispose 按逆序 = 后注册先清理） */
  seq: number;
}

export interface Registry<T> {
  /** 登记一个条目，返回 dispose 函数（幂等） */
  register(key: string, value: T): () => void;
  /** 按 key 取条目（同 key 后注册覆盖先注册） */
  get(key: string): T | undefined;
  has(key: string): boolean;
  /** 全部条目（按注册序） */
  entries(): RegistryEntry<T>[];
  /** 清理指定 key */
  remove(key: string): boolean;
  /** 全量清理（逆序 dispose 语义由调用方自行编排 dispose 列表） */
  clear(): void;
  readonly size: number;
}

export function createRegistry<T>(initial?: Record<string, T>): Registry<T> {
  const map = new Map<string, { value: T; seq: number }>();
  let seq = 0;

  if (initial) {
    for (const [k, v] of Object.entries(initial)) {
      map.set(k, { value: v, seq: seq++ });
    }
  }

  return {
    register(key, value) {
      map.set(key, { value, seq: seq++ });
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        // 仅当当前条目仍是本次注册的 value 才删除（防后注册的同 key 被误删）
        const cur = map.get(key);
        if (cur && cur.value === value) map.delete(key);
      };
    },
    get(key) {
      return map.get(key)?.value;
    },
    has(key) {
      return map.has(key);
    },
    entries() {
      return [...map.entries()]
        .map(([key, v]) => ({ key, value: v.value, seq: v.seq }))
        .sort((a, b) => a.seq - b.seq);
    },
    remove(key) {
      return map.delete(key);
    },
    clear() {
      map.clear();
    },
    get size() {
      return map.size;
    },
  };
}

/**
 * 组合式 disposer：把多个 dispose 函数收拢成一个（逆序执行 = 后注册先清理，
 * 与 dsh effect unwind 语义一致；任一抛错不影响其余执行）。
 */
export function composeDisposers(...disposers: Array<() => void>): () => void {
  return () => {
    for (let i = disposers.length - 1; i >= 0; i--) {
      try {
        disposers[i]();
      } catch {
        // 单个 disposer 失败不阻断清理链
      }
    }
  };
}
