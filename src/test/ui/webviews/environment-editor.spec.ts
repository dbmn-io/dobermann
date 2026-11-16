// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { test, expect } from '../harness/fixtures';

test.describe('Environment editor (standalone)', () => {
    test('populates the form for an existing environment', async ({ dbmn, page }) => {
        await dbmn.openEnvironmentEditor('env-dev-001');
        await dbmn.waitForReceived('environmentLoaded');

        await expect(page.locator('#envName')).toHaveValue('Development');
        await expect(page.locator('#envBaseUrl')).toHaveValue('https://dev-api.example.com');
        await expect(page.locator('#envType')).toHaveValue('development');
        await expect(page.locator('#envDescription')).toHaveValue('Development environment');

        // systemsList must precede environmentLoaded so the System dropdown
        // can be preselected (environment-manager.handleLoadEnvironment).
        const received = await page.evaluate(() =>
            (window as unknown as { __dbmnFakeHost: { received: { message: { type: string } }[] } })
                .__dbmnFakeHost.received.map(r => r.message.type));
        expect(received.indexOf('systemsList')).toBeGreaterThanOrEqual(0);
        expect(received.indexOf('systemsList')).toBeLessThan(received.indexOf('environmentLoaded'));

        await expect(page).toHaveScreenshot('existing-environment.png');
    });

    test('starts empty for a new environment', async ({ dbmn, page }) => {
        await dbmn.openEnvironmentEditor();
        await dbmn.waitForReceived('systemsList');

        await expect(page.locator('#envName')).toHaveValue('');
        await expect(page.locator('#envBaseUrl')).toHaveValue('');
        await expect(page).toHaveScreenshot('new-environment.png');
    });

    // #344: "Run in" is only the web app's for now (VS Code sends every request itself), but it's
    // saved with the environment: shown, saying so. "Store results in" is hidden: VS Code keeps it all here
    test('VS Code shows Run in as the web app\'s, and a save keeps what the web app set', async ({ dbmn, page }) => {
        await dbmn.openEnvironmentEditor('env-dev-001');
        await dbmn.waitForReceived('environmentLoaded');
        await expect(page.locator('#runOnRow')).toBeVisible();
        await expect(page.locator('#runOnHostNote')).toHaveText('DBMN for VS Code is a local agent: it sends every request itself.');
        await expect(page.locator('#storeResultsInRow')).toBeHidden();

        // As if the web app had set it
        await page.locator('#runOn').selectOption('local-agent');
        await page.locator('#envDescription').fill('Changed in VS Code');
        const after = await dbmn.sentCount();
        await page.locator('#saveEnvBtn').click();
        const save = await dbmn.waitForSent('saveEnvironment', { after });
        expect((save.message as { environment: { runOn?: string } }).environment.runOn).toBe('local-agent');
    });

    // #424: a variable with Options takes its Value from them; one without (org included) is typed
    test('a variable with Options picks its Value from them, and a value not in the list asks for one', async ({ dbmn, page }) => {
        const env = dbmn.seed.environments.find(e => e.id === 'env-dev-001')!;
        Object.assign(env, {
            variables: { region: 'boo', format: 'json', org: 'acme', key: 'abc123' },
            variableSettings: {
                region: { options: ['aus', 'nz', 'uk'], showInHeader: true },
                format: { options: ['json', 'xml'] },
                org: { showInHeader: true }
            }
        });
        await dbmn.openEnvironmentEditor('env-dev-001');
        await dbmn.waitForReceived('environmentLoaded');
        await page.locator('.tab-item[data-tab="configuration"]').click();
        const row = (name: string) => page.locator('#variablesTableBody tr').filter({ has: page.locator(`.variable-name[value="${name}"]`) });

        // Not one of its options: the dropdown asks, in the warning colour, and the text box is gone
        await expect(row('region').locator('.variable-value')).toBeHidden();
        await expect(row('region').locator('.variable-value-pick')).toHaveValue('');
        await expect(row('region').locator('.variable-value-pick option')).toHaveText(['Pick one…', 'aus', 'nz', 'uk']);
        await expect(row('region')).toHaveClass(/variable-value-unpicked/);
        // One of them: picked, with nothing else to choose
        await expect(row('format').locator('.variable-value-pick')).toHaveValue('json');
        await expect(row('format').locator('.variable-value-pick option')).toHaveText(['json', 'xml']);
        // org with no Options: typed, like any other variable (nothing comes from the token)
        await expect(row('org').locator('.variable-value')).toBeEditable();
        await expect(row('org').locator('.variable-value')).toHaveValue('acme');
        await expect(row('org').locator('.variable-value-pick')).toBeHidden();
        // No options: typed as before
        await expect(row('key').locator('.variable-value')).toBeEditable();
        await expect(row('key').locator('.variable-value-pick')).toBeHidden();

        await row('region').locator('.variable-value-pick').selectOption('nz');
        await expect(row('region')).not.toHaveClass(/variable-value-unpicked/);
        await expect(row('region').locator('.variable-value-pick option')).toHaveText(['aus', 'nz', 'uk']);
        // Options typed in: the Value turns into the dropdown as you type
        await row('key').locator('.variable-options').fill('abc123, def456');
        await expect(row('key').locator('.variable-value-pick')).toHaveValue('abc123');

        const after = await dbmn.sentCount();
        await page.locator('#saveEnvBtn').click();
        const save = await dbmn.waitForSent('saveEnvironment', { after });
        expect((save.message as { environment: { variables?: Record<string, string> } }).environment.variables)
            .toEqual({ region: 'nz', format: 'json', org: 'acme', key: 'abc123' });
    });

    test('parallel is one setting: how many at once, Sequential is 1, and a save keeps enabled true', async ({ dbmn, page }) => {
        await dbmn.openEnvironmentEditor('env-dev-001');
        await dbmn.waitForReceived('environmentLoaded');
        await expect(page.locator('#maxConcurrency')).toBeVisible();
        await expect(page.locator('#maxConcurrency')).toHaveValue('1');
        await page.locator('#maxConcurrency').selectOption('8');
        const after = await dbmn.sentCount();
        await page.locator('#saveEnvBtn').click();
        const save = await dbmn.waitForSent('saveEnvironment', { after });
        expect((save.message as { environment: { parallelProcessing?: unknown } }).environment.parallelProcessing).toEqual({ enabled: true, maxConcurrency: 8 });
    });

    test('a production environment is the user\'s to change: no lock', async ({ dbmn, page }) => {
        await dbmn.openEnvironmentEditor('env-prod-001');
        await dbmn.waitForReceived('environmentLoaded');

        await expect(page.locator('#envName')).toHaveValue('Production');
        await expect(page.locator('#envType')).toHaveValue('production');
        await expect(page.locator('#envType')).toBeEnabled();
        await expect(page.locator('#runOn')).toBeEnabled();
        await expect(page.locator('body')).not.toContainText(/licen[cs]e|Prod Protection/i);
        await expect(page).toHaveScreenshot('production-environment.png');
    });

    test('saves edits through the host and reflects them in the store', async ({ dbmn, page }) => {
        await dbmn.openEnvironmentEditor('env-test-001');
        await dbmn.waitForReceived('environmentLoaded');

        await page.locator('#envName').fill('Testing (renamed)');
        await page.locator('#envDescription').fill('Renamed by the UI test');

        const before = await dbmn.sentCount();
        await page.locator('#saveEnvBtn').click();
        const save = await dbmn.waitForSent('saveEnvironment', { after: before });
        expect(save.message.environment).toMatchObject({
            id: 'env-test-001',
            name: 'Testing (renamed)',
            description: 'Renamed by the UI test',
            systemId: 'sys-acmewms'
        });

        await dbmn.waitForReceived('environmentSaved');
        const state = await dbmn.state();
        expect(state.environments.find(e => e.id === 'env-test-001')).toMatchObject({
            name: 'Testing (renamed)',
            description: 'Renamed by the UI test'
        });
    });

    test('OAuth URLs are suggested from the whole base URL, and a URL you type loses the badge (#361)', async ({ dbmn, page }) => {
        await dbmn.openEnvironmentEditor();
        await dbmn.waitForReceived('systemsList');
        const base = 'http://127.0.0.1:54321/functions/v1/sample-store';
        await page.locator('#envBaseUrl').fill(base);
        await page.locator('.tab-item[data-tab="authentication"]').click();
        await page.locator('#authMethod').selectOption('oauth');

        // The base URL's path is kept: '/oauth/authorize' alone resolves against the host and lost it
        await expect(page.locator('#authorizationUrl')).toHaveValue(`${base}/oauth/authorize`);
        await expect(page.locator('#tokenUrl')).toHaveValue(`${base}/oauth/token`);
        await expect(page.locator('#authUrlIndicator')).toHaveText('(suggested)');

        // A changed base URL moves a suggestion along with it...
        await page.locator('.tab-item[data-tab="environment"]').click();
        await page.locator('#envBaseUrl').fill('http://127.0.0.1:54421/functions/v1/sample-store');
        await page.locator('.tab-item[data-tab="authentication"]').click();
        await expect(page.locator('#tokenUrl')).toHaveValue('http://127.0.0.1:54421/functions/v1/sample-store/oauth/token');

        // ...but what you type is yours: no badge, and never overwritten
        await page.locator('#authorizationUrl').fill('https://login.example.com/authorize');
        await expect(page.locator('#authUrlIndicator')).toHaveText('');
        await expect(page.locator('#tokenUrlIndicator')).toHaveText('(suggested)');
        await page.locator('.tab-item[data-tab="environment"]').click();
        await page.locator('#envBaseUrl').fill('https://api.example.com/v2');
        await page.locator('.tab-item[data-tab="authentication"]').click();
        await expect(page.locator('#authorizationUrl')).toHaveValue('https://login.example.com/authorize');
        await expect(page.locator('#tokenUrl')).toHaveValue('https://api.example.com/v2/oauth/token');
    });
});
