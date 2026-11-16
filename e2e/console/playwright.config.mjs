/**
 * The Console page in a real browser, loaded straight from src/ — no VS Code, no backend.
 *   npm run test:e2e:console
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: '.',
    testMatch: /.*\.spec\.mjs$/,
    timeout: 60 * 1000,
    expect: { timeout: 8000 },
    workers: 1,
    reporter: [['list']],
    outputDir: '../../.dev-local/playwright-console',
    use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
    projects: [{ name: 'chromium', use: { browserName: 'chromium' } }]
});
