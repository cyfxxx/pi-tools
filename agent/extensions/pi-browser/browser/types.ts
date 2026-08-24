export interface BrowserConfig {
  headless: boolean
  viewport_width: number
  viewport_height: number
  fingerprint_seed?: string
  proxy?: string
  data_dir?: string
}

export interface PageInfo {
  url: string
  title: string
  content: string
  textContent: string
  viewport: { width: number; height: number }
}

export interface NetworkEntry {
  url: string
  method: string
  type: string
  status?: number
  timestamp: number
}

export type DialogMode = 'accept' | 'dismiss' | 'input'

export interface DownloadFile {
  filename: string
  path: string
  url: string
  timestamp: number
}
