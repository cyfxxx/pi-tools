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
