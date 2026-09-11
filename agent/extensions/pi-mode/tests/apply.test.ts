import { describe, it, expect } from 'vitest'
import { applyModeRuntime, needsRestart } from '../apply'
import type { ModeConfig } from '../types'

describe('apply', () => {
  describe('applyModeRuntime', () => {
    it('should detect thinking level change', () => {
      const config: ModeConfig = {
        description: 'test',
        extensions: [],
        skills: [],
        systemPrompt: null,
        appendSystemPrompt: null,
        thinking: 'low',
      }
      
      const result = applyModeRuntime(config, 'high')
      expect(result.thinkingChanged).toBe(true)
      expect(result.changes).toContain('思考级别: low')
    })

    it('should not detect thinking change when same level', () => {
      const config: ModeConfig = {
        description: 'test',
        extensions: [],
        skills: [],
        systemPrompt: null,
        appendSystemPrompt: null,
        thinking: 'low',
      }
      
      const result = applyModeRuntime(config, 'low')
      expect(result.thinkingChanged).toBe(false)
    })

    it('should detect extensions require restart', () => {
      const config: ModeConfig = {
        description: 'test',
        extensions: ['pi-web-search'],
        skills: [],
        systemPrompt: null,
        appendSystemPrompt: null,
        thinking: null,
      }
      
      const result = applyModeRuntime(config, undefined)
      expect(result.needsRestart).toBe(true)
      expect(result.changes).toContain('扩展将在重启后生效')
    })

    it('should detect skills require restart', () => {
      const config: ModeConfig = {
        description: 'test',
        extensions: [],
        skills: ['pi-backup'],
        systemPrompt: null,
        appendSystemPrompt: null,
        thinking: null,
      }
      
      const result = applyModeRuntime(config, undefined)
      expect(result.needsRestart).toBe(true)
      expect(result.changes).toContain('技能将在重启后生效')
    })

    it('should detect system prompt requires restart', () => {
      const config: ModeConfig = {
        description: 'test',
        extensions: [],
        skills: [],
        systemPrompt: 'Custom prompt',
        appendSystemPrompt: null,
        thinking: null,
      }
      
      const result = applyModeRuntime(config, undefined)
      expect(result.needsRestart).toBe(true)
      expect(result.changes).toContain('系统提示词将在重启后生效')
    })

    it('should detect append system prompt requires restart', () => {
      const config: ModeConfig = {
        description: 'test',
        extensions: [],
        skills: [],
        systemPrompt: null,
        appendSystemPrompt: 'Custom append',
        thinking: null,
      }
      
      const result = applyModeRuntime(config, undefined)
      expect(result.needsRestart).toBe(true)
      expect(result.changes).toContain('系统提示词将在重启后生效')
    })

    it('should not require restart for thinking only changes', () => {
      const config: ModeConfig = {
        description: 'test',
        extensions: [],
        skills: [],
        systemPrompt: null,
        appendSystemPrompt: null,
        thinking: 'low',
      }
      
      const result = applyModeRuntime(config, 'high')
      expect(result.needsRestart).toBe(false)
      expect(result.thinkingChanged).toBe(true)
    })
  })

  describe('needsRestart', () => {
    it('should return true for config with extensions', () => {
      const config: ModeConfig = {
        description: 'test',
        extensions: ['pi-web-search'],
        skills: [],
        systemPrompt: null,
        appendSystemPrompt: null,
        thinking: null,
      }
      
      expect(needsRestart(config)).toBe(true)
    })

    it('should return true for config with skills', () => {
      const config: ModeConfig = {
        description: 'test',
        extensions: [],
        skills: ['pi-backup'],
        systemPrompt: null,
        appendSystemPrompt: null,
        thinking: null,
      }
      
      expect(needsRestart(config)).toBe(true)
    })

    it('should return true for config with system prompt', () => {
      const config: ModeConfig = {
        description: 'test',
        extensions: [],
        skills: [],
        systemPrompt: 'Custom prompt',
        appendSystemPrompt: null,
        thinking: null,
      }
      
      expect(needsRestart(config)).toBe(true)
    })

    it('should return true for config with append system prompt', () => {
      const config: ModeConfig = {
        description: 'test',
        extensions: [],
        skills: [],
        systemPrompt: null,
        appendSystemPrompt: 'Custom append',
        thinking: null,
      }
      
      expect(needsRestart(config)).toBe(true)
    })

    it('should return false for config with only thinking change', () => {
      const config: ModeConfig = {
        description: 'test',
        extensions: [],
        skills: [],
        systemPrompt: null,
        appendSystemPrompt: null,
        thinking: 'low',
      }
      
      expect(needsRestart(config)).toBe(false)
    })

    it('should return false for empty config', () => {
      const config: ModeConfig = {
        description: 'test',
        extensions: [],
        skills: [],
        systemPrompt: null,
        appendSystemPrompt: null,
        thinking: null,
      }
      
      expect(needsRestart(config)).toBe(false)
    })
  })
})