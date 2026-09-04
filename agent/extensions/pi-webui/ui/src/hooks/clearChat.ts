/**
 * 清空一个聊天的所有消息
 */

export function clearChat(chatId: string): Promise<number> {
  return fetch(`/api/messages/clear?chatId=${encodeURIComponent(chatId)}`, { method: 'DELETE' })
    .then(res => res.json())
    .then((data: { deleted: number; ok?: boolean }) => data.deleted ?? 0)
}
