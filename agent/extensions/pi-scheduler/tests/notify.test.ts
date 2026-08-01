import { describe, it, expect, afterAll, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const TEST_DIR = await mkdtemp(join(tmpdir(), 'pi-scheduler-notify-'))

const { __setAgentDir } = await import('./__mocks__/pi-coding-agent')
__setAgentDir(TEST_DIR)

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true })
})

const { sendWebhook, setSettings } = await import('../storage')

describe('sendWebhook', () => {
  it('sends payload when settings.webhookUrl is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    await setSettings({ webhookUrl: 'https://example.com/hook' })
    await sendWebhook({ name: 'task-a', type: 'cron', schedule: '0 9 * * *' }, 'success', 'all good')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://example.com/hook')
    const body = JSON.parse(init.body)
    expect(body.task).toBe('task-a')
    expect(body.result).toBe('success')
    expect(body.output).toContain('all good')
    vi.unstubAllGlobals()
  })

  it('uses PI_SCHEDULER_WEBHOOK env as fallback', async () => {
    await setSettings({ webhookUrl: '' })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    const prev = process.env.PI_SCHEDULER_WEBHOOK
    process.env.PI_SCHEDULER_WEBHOOK = 'https://env.example.com/hook'
    await sendWebhook({ name: 'task-b', type: 'once', schedule: '+30m' }, 'failed', 'err')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://env.example.com/hook')
    if (prev === undefined) delete process.env.PI_SCHEDULER_WEBHOOK
    else process.env.PI_SCHEDULER_WEBHOOK = prev
    vi.unstubAllGlobals()
  })

  it('does nothing without a webhook url', async () => {
    await setSettings({ webhookUrl: '' })
    delete process.env.PI_SCHEDULER_WEBHOOK
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await sendWebhook({ name: 'task-c', type: 'interval', schedule: '5m' }, 'success', '')
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
