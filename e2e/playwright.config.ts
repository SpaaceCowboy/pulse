import { defineConfig } from '@playwright/test'
import { PORT } from './env'

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: 'chrome', // system Chrome: the Playwright CDN is not reachable from here
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chrome', use: { viewport: { width: 1280, height: 900 } } }],
})
