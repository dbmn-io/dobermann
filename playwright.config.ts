import { defineConfig, devices } from '@playwright/test';

/**
 * Two Playwright projects:
 *
 *   ui      Webview regression tests (src/test/ui). The real webview HTML/JS
 *           renders in headless Chromium against a fake VS Code host
 *           (src/test/ui/harness/fake-host.js). Pixel-asserted screenshots;
 *           baselines are Linux-only and live under src/test/ui/__snapshots__.
 *
 *   vscode  End-to-end smoke tests in a real VS Code (src/test/e2e). VS Code
 *           is downloaded by @vscode/test-electron and driven over CDP
 *           (src/test/e2e/harness/vscode.ts). Needs `npm run build` first.
 *
 *   npm run test:ui            npm run test:ui:update      npm run test:ui:headed
 *   npm run test:e2e           xvfb-run -a npm run test:e2e   (headless)
 */
/**
 * One harness server per checkout. Playwright reuses whatever answers on the port, so with one
 * fixed port a worktree's UI tests quietly ran against another checkout's src/webviews (found
 * 2026-10-07: two days of a worktree testing main's screens). The port is derived from this
 * checkout's path; DBMN_UI_PORT still overrides.
 */
function checkoutPort(base: number, span: number): number {
    let hash = 0;
    for (const c of __dirname) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
    return base + (hash % span);
}
const PORT = Number(process.env.DBMN_UI_PORT || checkoutPort(4200, 700));

/** Screenshot baselines are tied to the machine's font rendering. `local`
 *  is whatever the developer box produces; CI can keep its own set (e.g.
 *  `DBMN_SNAPSHOT_SET=ci` generated inside the Playwright Docker image). */
const SNAPSHOT_SET = process.env.DBMN_SNAPSHOT_SET || 'local';

export default defineConfig({
    testDir: 'src/test',
    // {testDir} is the *project* testDir (src/test/ui for the ui project).
    snapshotPathTemplate: `{testDir}/__snapshots__/${SNAPSHOT_SET}/{testFileName}/{arg}{ext}`,
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI
        ? [['list'], ['html', { open: 'never', outputFolder: 'test-results/ui-report' }]]
        : [['list'], ['html', { open: 'on-failure', outputFolder: 'test-results/ui-report' }]],
    use: {
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure'
    },
    expect: {
        toHaveScreenshot: {
            // Absolute budget, not a ratio: a recoloured nav item is ~11k px on a
            // 1400x900 page (<1%) and must fail. Same-machine runs are pixel-identical.
            maxDiffPixels: 100,
            animations: 'disabled',
            caret: 'hide',
            scale: 'css'
        }
    },
    projects: [
        {
            name: 'ui',
            testDir: 'src/test/ui',
            testMatch: '**/*.spec.ts',
            // #364: more parallel headless Chromes than this crash pages ("Target crashed") and
            // time out on a busy machine (measured 2026-10-10: 8 workers failed 6 runs in 7, 2
            // failed 1 in 6). --workers on the command line still overrides it.
            workers: 2,
            outputDir: 'test-results/ui',
            use: {
                ...devices['Desktop Chrome'],
                baseURL: `http://127.0.0.1:${PORT}`,
                viewport: { width: 1400, height: 900 },
                deviceScaleFactor: 1,
                colorScheme: 'dark'
            }
        },
        {
            name: 'vscode',
            testDir: 'src/test/e2e',
            testMatch: '**/*.e2e.spec.ts',
            // Separate from the ui project: Playwright clears a project's
            // outputDir at the start of a run.
            outputDir: 'test-results/e2e',
            // One VS Code per worker; keep it to a single window.
            workers: 1,
            fullyParallel: false,
            timeout: 120_000
        }
    ],
    webServer: {
        command: `node src/test/ui/harness/static-server.js --port ${PORT}`,
        url: `http://127.0.0.1:${PORT}/healthz`,
        reuseExistingServer: !process.env.CI,
        timeout: 10_000
    }
});
