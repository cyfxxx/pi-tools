/**
 * pi-voice core — facade re-exporting all sub-modules.
 * Existing consumers import from './core'; this keeps backward compatibility.
 */

export { type CommandResult, nowStamp, runCommand, type TranscribeResult } from './types'

export {
  platformOf,
  gpuSwitchBlockReason,
  startRecording,
  detectAudioLevel,
  stopRecording,
  queryRecording,
  deleteAudioPair,
  fileExists,
  waitForFileStable,
  cleanupStaleAudio,
  convertToWav,
  ownerOrphaned,
} from './recording'

export {
  type EnsureWhisperDeps,
  defaultWhisperHealth,
  defaultSherpaHealth,
  ensureWhisperService,
  transcribe,
  ensureSherpaService,
  transcribeSherpa,
  transcribeByBackend,
  prewarmStt,
} from './transcription'

export {
  speak,
  cleanForSpeech,
  isSpeechWorthy,
  type TtsDispatcherOptions,
  type TtsDispatcher,
  createTtsDispatcher,
  extractAssistantText,
} from './tts'

export {
  type WakeSession,
  type WakeOptions,
  createWakeSession,
} from './wake'

export {
  doctor,
  voiceGuideError,
  type BenchResult,
  benchSuggestion,
  benchmark,
} from './diagnostics'
