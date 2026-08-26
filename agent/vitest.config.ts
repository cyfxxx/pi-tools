// agent 根 vitest 配置 = 纯守门，不放行任何测试。
// 各扩展套件必须经 scripts/test-all.sh（cd 到扩展目录，用各自的 vitest.config.ts +
// __mocks__ 别名隔离 getAgentDir）。
//
// 为什么用插件而不是 globalSetup：vitest 在「无匹配测试文件」时提前退出，
// globalSetup 不执行（2026-08-26 实测）；而插件 configResolved 在配置加载阶段必然运行，
// 任何从本目录发起的 vitest 调用都会被阻断并看到原因。
//
// 事故背景（2026-08-26 restart_hang 误报）：扩展测试的 __mocks__ 别名（隔离 getAgentDir）
// 只在 extensions/<ext>/vitest.config.ts 生效；agent 根直跑时别名失效，watchdog.test 的
// 注入时钟把 restart_hang 写进真实 .pi-admin-state.json，下次启动打出假的
// 「会话挂死自动重启恢复」横幅。
const rootGuard = {
  name: 'pi-agent-root-guard',
  configResolved(): void {
    throw new Error(
      [
        '[vitest-root-guard] 禁止在 agent/ 根目录运行 vitest。',
        '扩展测试的 __mocks__ 别名仅在各自扩展目录的 vitest.config.ts 下生效，',
        '根目录直跑会把测试数据写进真实配置（2026-08-26 restart_hang 误报事故根因）。',
        '正确用法：bash scripts/test-all.sh --only=<ext>',
        '或：cd extensions/<ext> && node ../../node_modules/vitest/vitest.mjs run',
      ].join('\n'),
    )
  },
}

export default {
  plugins: [rootGuard],
  test: {
    include: ['**/*.test.ts'],
    // 双保险：即使插件被绕过，扩展目录也不在收集范围
    exclude: ['**/node_modules/**', 'extensions/**'],
  },
}
