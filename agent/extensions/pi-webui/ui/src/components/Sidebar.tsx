/**
 * 侧边栏 — 设备列表 + 聊天会话
 */

import type { ChatSession, DeviceStatus } from '../lib/types'

interface SidebarProps {
  sessions: ChatSession[]
  devices: DeviceStatus[]
  activeSession: string
  connected: boolean
  onSelect: (sessionId: string) => void
}

export function Sidebar({ sessions, devices, activeSession, connected, onSelect }: SidebarProps) {
  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <h1>pi-webui</h1>
        <div className={`connection-dot ${connected ? '' : 'disconnected'}`} />
      </div>
      <div className="session-list">
        {sessions.map(session => (
          <div
            key={session.id}
            className={`session-item ${session.id === activeSession ? 'active' : ''}`}
            onClick={() => onSelect(session.id)}
          >
            <div className="session-item-header">
              <span className="session-name">
                {session.type === 'group' ? '💬 ' : ''}
                {session.name}
                {session.id !== 'group' && (
                  <DeviceDot
                    online={devices.some(d => d.name === session.id && d.online)}
                  />
                )}
              </span>
              {session.unread > 0 && (
                <span className="session-badge">{session.unread}</span>
              )}
            </div>
            {session.lastMessage && (
              <div className="session-preview">
                {session.lastMessage.sender}: {session.lastMessage.content.slice(0, 40)}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function DeviceDot({ online }: { online: boolean }) {
  return <span className={`device-status-dot ${online ? 'online' : 'offline'}`} />
}
