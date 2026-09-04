/**
 * 删除一条消息
 */

export function deleteMessage(id: string): Promise<boolean> {
  return fetch(`/api/messages/${encodeURIComponent(id)}`, { method: 'DELETE' })
    .then(res => res.json())
    .then((data: { ok: boolean }) => data.ok === true)
}