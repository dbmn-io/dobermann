/**
 * @vscode/test-cli config — runs the compiled `out/test/integration` mocha
 * suite INSIDE a real VS Code Extension Host (`npx vscode-test`).
 *
 * Native Linux: this launches a VS Code window directly. Headless:
 *   xvfb-run -a npx vscode-test
 *
 * Note: `npm run test:integration` runs the same files under plain mocha
 * against the vscode mock, which is the wired-in path today. The UI
 * regression suites live elsewhere — see playwright.config.ts
 * (`npm run test:ui`, `npm run test:e2e`).
 */
const { defineConfig } = require('@vscode/test-cli');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A throwaway folder per run so the suite never opens the developer's
// real projects and there is nothing to `.gitignore`.
const workspaceFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'dbmn-vscode-test-'));

module.exports = defineConfig({
    files: 'out/test/integration/**/*.test.js',
    version: 'stable',
    workspaceFolder,
    extensionDevelopmentPath: __dirname,
    mocha: {
        ui: 'bdd',
        timeout: 30000,
        reporter: 'spec'
    },
    env: {
        NODE_ENV: 'test'
    },
    launchArgs: [
        '--disable-extensions',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-updates',
        '--password-store=basic',
        '--no-sandbox',
        '--disable-gpu'
    ]
});
