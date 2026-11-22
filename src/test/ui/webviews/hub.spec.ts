// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { test, expect, openList } from '../harness/fixtures';

test.describe('Hub', () => {
    test('renders the catalogue from seeded state', async ({ dbmn, page }) => {
        await dbmn.openHub();
        await openList(page, 'catalogue');

        const list = page.locator('#catalogueList');
        await expect(list).toContainText('Test API Endpoint');
        await expect(list).toContainText('Minimal Test Endpoint');
        await expect(list).toContainText('Validation Test Endpoint');
        await expect(page.locator('#hubEnvCurrent')).toContainText('Development');

        await dbmn.settle();
        // Home's tip changes daily (Issue #348).
        await expect(page).toHaveScreenshot('catalogue.png', { mask: [page.locator('#hubHomeTipText')] });
    });

    test('Reporting lists lookup tables beside the reports (the Hub\'s state carries them; the page kept only reports until 2026-11-23)', async ({ dbmn, page }) => {
        await dbmn.openHub();
        await page.locator('.hub-nav-item[data-section="compare"]').click();
        // The host's whole state (opening a list may send it again), with one lookup table
        const seeded = await page.evaluate(() => (window as unknown as { __HUB_INITIAL_STATE__?: Record<string, unknown> }).__HUB_INITIAL_STATE__ ?? {});
        await dbmn.push({
            ...seeded, type: 'hubState', compares: [], queries: [],
            lookupTables: [{ id: 'lkp-units', name: 'Units', columns: [{ id: 'c1', name: 'code', key: true }, { id: 'c2', name: 'value' }], rows: 2, updatedAt: '2026-11-23T00:00:00Z' }]
        });
        await expect(page.locator('#compareEmpty')).toBeHidden();
        await expect(page.locator('#compareSummary')).toHaveText('1 report');
        await expect(page.locator('#compareList')).toContainText('Units');
    });

    test('signed out of DBMN, the header offers Sign in beside the environment selector (#418: everything runs signed out)', async ({ dbmn, page }) => {
        await dbmn.openHub();

        await expect(page.locator('#hubEnvSelector')).toBeVisible();
        const signIn = page.locator('#hubSignInBtn');
        await expect(signIn).toBeVisible();
        await expect(signIn).toHaveText('Sign in to DBMN');
        await signIn.click();
        await dbmn.waitForSent('signIn');
    });

    // Issue #396: a DBMN session that can no longer refresh looked exactly like a healthy one
    // in the header, and the only warning was inside Account.
    test('an expired DBMN sign-in shows in the header, and the environment selector stays', async ({ dbmn, page }) => {
        dbmn.seed.isSignedIn = true;
        dbmn.seed.dbmnSessionExpired = true;
        await dbmn.openHub();

        await expect(page.locator('#hubEnvSelector')).toBeVisible();
        await expect(page.locator('#hubSignInBtn')).toBeHidden();
        const expired = page.locator('#hubSessionExpiredBtn');
        await expect(expired).toBeVisible();
        await expect(expired).toHaveText('DBMN sign-in expired');

        // The environment name is centred over the bar: the warning must not run into it,
        // nor into the activity chip on the right.
        const box = async (selector: string) => (await page.locator(selector).boundingBox())!;
        const overlaps = (a: { x: number; width: number }, b: { x: number; width: number }) => a.x < b.x + b.width && b.x < a.x + a.width;
        const warning = await box('#hubSessionExpiredBtn');
        const selector = await box('#hubEnvSelector');
        const activity = await box('#hubActivityChip');
        expect(overlaps(warning, selector), 'warning over the environment name').toBe(false);
        expect(overlaps(warning, activity), 'warning over the activity chip').toBe(false);
        // State lives on the right: environment name, then sign-in, then activity.
        expect(warning.x, 'warning is to the right of the environment name').toBeGreaterThanOrEqual(selector.x + selector.width);
        expect(warning.x + warning.width, 'warning is to the left of activity').toBeLessThanOrEqual(activity.x);

        await expired.click();
        await dbmn.waitForSent('signIn');
    });

    test('in a narrow Hub the expired warning shrinks to its icon and still clears the environment name', async ({ dbmn, page }) => {
        dbmn.seed.isSignedIn = true;
        dbmn.seed.dbmnSessionExpired = true;
        await page.setViewportSize({ width: 760, height: 700 });
        await dbmn.openHub();

        await expect(page.locator('#hubSessionExpiredBtn')).toBeVisible();
        await expect(page.locator('.hub-session-expired-label')).toBeHidden();
        const warning = (await page.locator('#hubSessionExpiredBtn').boundingBox())!;
        const selector = (await page.locator('#hubEnvSelector').boundingBox())!;
        expect(warning.x, 'warning starts after the environment name ends').toBeGreaterThanOrEqual(selector.x + selector.width);
    });

    test('a healthy DBMN sign-in shows no warning in the header', async ({ dbmn, page }) => {
        dbmn.seed.isSignedIn = true;
        await dbmn.openHub();
        await expect(page.locator('#hubEnvSelector')).toBeVisible();
        await expect(page.locator('#hubSessionExpiredBtn')).toBeHidden();
    });

        test('switches the active environment from the header selector', async ({ dbmn, page }) => {
        dbmn.seed.isSignedIn = true;   // signed out, Sign in takes the selector's place
        await dbmn.openHub();

        await page.locator('#hubEnvSelector').click();
        const popup = page.locator('#hubEnvPopup');
        await expect(popup).toBeVisible();
        await expect(popup.locator('.hub-env-popup-item.is-production')).toContainText('Production');
        await expect(popup).toHaveScreenshot('environment-popup.png');

        const before = await dbmn.sentCount();
        await popup.locator('[data-env-id="env-test-001"]:not([data-org])').first().click();
        const msg = await dbmn.waitForSent('setActiveEnvironment', { after: before });
        expect(msg.message.environmentId).toBe('env-test-001');

        await expect(page.locator('#hubEnvCurrent')).toContainText('Testing');
        const state = await dbmn.state();
        expect(state.environments.find(e => e.isActive)?.id).toBe('env-test-001');
    });

    // 2026-11-16, James on 0.4.0: changing environment was "annoyingly SLOW". The host now says
    // which environment was picked before it saves; the header draws it from that alone.
    test('a picked environment is drawn from the pick alone, before the full state arrives', async ({ dbmn, page }) => {
        dbmn.seed.isSignedIn = true;
        await dbmn.openHub();
        await expect(page.locator('#hubEnvCurrent')).toContainText('Development');
        await expect(page.locator('.hub-header')).not.toHaveClass(/is-production/);

        await dbmn.push({ type: 'activeEnvironmentPicked', environmentId: 'env-prod-001' });
        await expect(page.locator('#hubEnvCurrent')).toContainText('Production');
        await expect(page.locator('.hub-header')).toHaveClass(/is-production/);

        await dbmn.push({ type: 'activeEnvironmentPicked', environmentId: 'no-such-environment' });
        await expect(page.locator('#hubEnvCurrent'), 'an unknown one changes nothing').toContainText('Production');
    });

    test('each environment in the header list has its own Edit pencil, which does not switch to it', async ({ dbmn, page }) => {
        dbmn.seed.isSignedIn = true;
        await dbmn.openHub();
        await page.locator('#hubEnvSelector').click();
        const popup = page.locator('#hubEnvPopup');
        const rows = popup.locator('.hub-env-popup-item');
        await expect(popup.locator('.hub-env-popup-item .hub-env-popup-edit')).toHaveCount(await rows.count());
        await expect(popup.locator('.hub-env-popup-actions')).toHaveText('New environment…');

        const before = await dbmn.sentCount();
        await popup.locator('.hub-env-popup-edit[data-env-id="env-test-001"]').click();
        const msg = await dbmn.waitForSent('openEnvironmentAsTab', { after: before });
        expect(msg.message.environmentId).toBe('env-test-001');
        await expect(popup).toBeHidden();
        const state = await dbmn.state();
        expect(state.environments.find(e => e.isActive)?.id, 'still the same active environment').toBe('env-dev-001');
    });

    test('on a production header the activity pill keeps the standard background', async ({ dbmn, page }) => {
        dbmn.seed.isSignedIn = true;
        await dbmn.openHub();
        const background = (selector: string) => page.locator(selector).evaluate(el => getComputedStyle(el).backgroundColor);
        const standard = await background('.hub-header');

        await page.locator('#hubEnvSelector').click();
        await page.locator('#hubEnvPopup .hub-env-popup-item.is-production').first().click();
        await expect(page.locator('.hub-header')).toHaveClass(/is-production/);
        expect(await background('.hub-header'), 'the header is highlighted').not.toBe(standard);
        expect(await background('#hubActivityChip'), 'the pill is not').toBe(standard);

        // A header variable's segment reads in the banner's own foreground, as the name does: the
        // error red on the red banner was unreadable (James, 2026-11-02)
        const color = (selector: string) => page.locator(selector).first().evaluate(el => getComputedStyle(el).color);
        await expect(page.locator('#hubEnvVars .hub-env-seg').first()).toBeVisible();
        expect(await color('#hubEnvVars .hub-env-seg-value'), 'segment matches the name').toBe(await color('#hubEnvCurrent'));
    });

    test('persists a settings toggle through the host', async ({ dbmn, page }) => {
        await dbmn.openHub();

        await page.locator('.hub-nav-item[data-section="settings"]').click();
        await dbmn.settle();
        const toggle = page.locator('#autoOpenConsole');
        await expect(toggle).toBeChecked();

        const before = await dbmn.sentCount();
        // The native checkbox is visually hidden behind the styled switch.
        await page.locator('label.hub-toggle:has(#autoOpenConsole)').click();
        await expect(toggle).not.toBeChecked();
        const msg = await dbmn.waitForSent('setDbmnSetting', { after: before });
        expect(msg.message).toMatchObject({ key: 'execution.autoOpenConsoleOnCompletion', value: false });

        const state = await dbmn.state();
        expect(state.dbmnSettings.autoOpenConsoleOnCompletion).toBe(false);
        await expect(page.locator('#workspacePath')).toContainText('/home/tester/dbmn-workspace');
        await dbmn.settle();
        await expect(page).toHaveScreenshot('settings.png');
    });

    test('catalogue preferences round-trip through the host', async ({ dbmn, page }) => {
        // A fresh panel has empty webview state, so preferences must come
        // from the host (globalState) — this is what made "Group by: URL"
        // revert to System on every launch.
        dbmn.seed.hubPreferences = { catalogueGroupBy: 'method' };
        await dbmn.openHub();

        const labels = page.locator('#catalogueList .catalogue-group-label');
        await expect(labels.first()).toHaveText('GET');
        await expect(page.locator('#catalogueGroupBy')).toHaveValue('method');

        // Changing a setting mirrors the whole preference object to the host.
        await page.locator('.hub-nav-item[data-section="settings"]').click();
        const before = await dbmn.sentCount();
        await page.locator('#catalogueGroupBy').selectOption('url');
        const msg = await dbmn.waitForSent('setHubPreferences', { after: before });
        expect(msg.message.preferences).toMatchObject({ catalogueGroupBy: 'url' });
        const state = await dbmn.state();
        expect(state.hubPreferences).toMatchObject({ catalogueGroupBy: 'url' });
    });

    test('pins recently touched endpoints above the tree', async ({ dbmn, page }) => {
        // Two signals merge: an explicit MRU touch from the host, and a run
        // in the transaction history. Newest first, capped at five.
        dbmn.seed.recentEndpoints = [{ id: 'test-endpoint-001', touchedAt: Date.parse('2026-09-30T10:00:00Z') }];
        dbmn.seed.transactions = [{
            id: 'tx-1', endpointId: 'test-endpoint-002', endpointName: 'Minimal Test Endpoint',
            status: 'completed', createdAt: '2026-09-30T11:00:00Z', completedAt: '2026-09-30T11:00:05Z'
        }];
        await dbmn.openHub();
        await openList(page, 'catalogue');

        const recent = page.locator('#catalogueList .catalogue-recent');
        await expect(recent).toBeVisible();
        await expect(recent.locator('.catalogue-group-label')).toHaveText('Recent');
        const rows = recent.locator('.catalogue-row');
        await expect(rows).toHaveCount(2);
        await expect(rows.nth(0)).toHaveAttribute('data-endpoint-id', 'test-endpoint-002');
        await expect(rows.nth(1)).toHaveAttribute('data-endpoint-id', 'test-endpoint-001');
        await dbmn.settle();
        await expect(page).toHaveScreenshot('catalogue-recent.png', { mask: [page.locator('#hubHomeTipText')] });

        // #444: Recent stays while searching, with the recent endpoints that match; none, none shown
        await page.locator('#catalogueSearch').fill('minimal');
        await expect(rows).toHaveCount(1);
        await expect(rows.nth(0)).toHaveAttribute('data-endpoint-id', 'test-endpoint-002');
        await page.locator('#catalogueSearch').fill('Validation');
        await expect(recent).toHaveCount(0);
        await page.locator('#catalogueSearch').fill('');
        await expect(recent).toBeVisible();

        // The Settings toggle turns the section off.
        await page.locator('.hub-nav-item[data-section="settings"]').click();
        await page.locator('label.hub-toggle:has(#catalogueShowRecent)').click();
        await expect(page.locator('#catalogueShowRecent')).not.toBeChecked();
        await page.locator('.hub-nav-item[data-section="catalogue"]').click();
        await expect(recent).toHaveCount(0);
    });

    test('`@system=current` in the search (the current System): Recent stays, limited to that System', async ({ dbmn, page }) => {
        // The active env (dev) belongs to ACMEWMS; endpoint 003 lives in DBMN.
        dbmn.seed.recentEndpoints = [
            { id: 'test-endpoint-003', touchedAt: Date.parse('2026-09-30T12:00:00Z') },
            { id: 'test-endpoint-001', touchedAt: Date.parse('2026-09-30T10:00:00Z') }
        ];
        await dbmn.openHub();
        await openList(page, 'catalogue');
        await page.locator('#catalogueSearch').fill('@system=current');

        const rows = page.locator('#catalogueList .catalogue-recent .catalogue-row');
        await expect(rows).toHaveCount(1);
        await expect(rows.nth(0)).toHaveAttribute('data-endpoint-id', 'test-endpoint-001');
    });

    test('Select mode: Delete sends the ticked endpoints, and is off with nothing ticked', async ({ dbmn, page }) => {
        await dbmn.openHub();
        await openList(page, 'catalogue');

        await page.locator('#catalogueList label.hub-add-split-select').click();
        const del = page.locator('#catalogueBulkDelete');
        await expect(page.locator('#catalogueBulkBar')).toBeVisible();
        await expect(del).toBeDisabled();

        for (const id of ['test-endpoint-001', 'test-endpoint-002']) {
            await page.locator(`#catalogueList .catalogue-row[data-endpoint-id="${id}"] .catalogue-row-select`).first().check();
        }
        await expect(page.locator('#catalogueBulkCount')).toHaveText('2 selected');
        await expect(del).toBeEnabled();
        await expect(page.locator('#catalogueBulkBar')).toHaveScreenshot('catalogue-bulk-footer.png');

        // A narrow list drawer (~265px): the buttons stay on one line and the count drops
        // its "selected".
        await page.locator('section.hub-section[data-section="catalogue"]').evaluate(el => { (el as HTMLElement).style.width = '265px'; });
        const middles = await page.locator('#catalogueBulkBar .btn').evaluateAll(btns => btns.map(b => { const r = b.getBoundingClientRect(); return r.top + r.height / 2; }));
        expect(Math.max(...middles) - Math.min(...middles), `button middles ${middles.join(', ')}`).toBeLessThan(4);
        await expect(page.locator('#catalogueBulkCount .tx-bulk-count-word')).toBeHidden();
        await expect(page.locator('#catalogueBulkBar')).toHaveScreenshot('catalogue-bulk-footer-narrow.png');
        await page.locator('section.hub-section[data-section="catalogue"]').evaluate(el => { (el as HTMLElement).style.width = ''; });

        const before = await dbmn.sentCount();
        await del.click();
        const msg = await dbmn.waitForSent('bulkDeleteEndpoints', { after: before });
        expect([...msg.message.ids].sort()).toEqual(['test-endpoint-001', 'test-endpoint-002']);
    });

    test('Select mode: Update sets a System, adds tags and removes the selection\'s tags', async ({ dbmn, page }) => {
        await dbmn.openHub();
        await openList(page, 'catalogue');
        await page.locator('#catalogueList label.hub-add-split-select').click();
        for (const id of ['test-endpoint-001', 'test-endpoint-002']) {
            await page.locator(`#catalogueList .catalogue-row[data-endpoint-id="${id}"] .catalogue-row-select`).first().check();
        }
        await page.locator('#catalogueBulkUpdate').click();

        const modal = page.locator('.dbmn-filters-modal');
        await expect(modal).toBeVisible();
        // Remove tags lists only the selection's tags, with how many carry each.
        const rows = page.locator('#bulkUpdateRemoveTags .dbmn-filter-tags-row');
        await expect(rows).toHaveCount(2);
        await expect(rows.nth(0)).toContainText('smoke');
        await expect(rows.nth(0).locator('.dbmn-filter-tags-count')).toHaveText('2');
        await expect(rows.nth(1)).toContainText('orders');
        await expect(page.locator('.dbmn-modal')).toHaveScreenshot('catalogue-bulk-update.png');

        await modal.locator('label.dbmn-filter-radio', { hasText: 'No System' }).click();
        await page.locator('#bulkUpdateAddTags').fill('Puppy-School, training');
        await rows.nth(0).locator('input').check();
        const before = await dbmn.sentCount();
        await page.locator('.dbmn-modal-footer button', { hasText: 'Update' }).click();
        const msg = await dbmn.waitForSent('bulkUpdateEndpoints', { after: before });
        expect(msg.message).toMatchObject({ system: '', addTags: ['Puppy-School', 'training'], removeTags: ['smoke'] });
        expect([...msg.message.ids].sort()).toEqual(['test-endpoint-001', 'test-endpoint-002']);
    });

    test('an empty catalogue offers New Endpoint from Clipboard beside Add Endpoint', async ({ dbmn, page }) => {
        // A new user's first endpoint (Puppy School Lesson 1) comes from the clipboard.
        dbmn.seed.endpoints = [];
        await dbmn.openHub();
        await openList(page, 'catalogue');

        const empty = page.locator('#catalogueEmpty');
        await expect(empty).toBeVisible();
        await expect(page.locator('#catalogueAddEndpoint')).toBeVisible();
        const fromClipboard = page.locator('#catalogueAddFromClipboard');
        await expect(fromClipboard).toHaveText('New Endpoint from Clipboard');
        await expect(empty).toHaveScreenshot('catalogue-empty.png');

        const before = await dbmn.sentCount();
        await fromClipboard.click();
        const msg = await dbmn.waitForSent('addEndpoint', { after: before });
        expect(msg.message).toMatchObject({ type: 'addEndpoint', fromClipboard: true });
    });

    test('opens an endpoint as an embedded editor tab', async ({ dbmn, page }) => {
        await dbmn.openHub();
        await openList(page, 'catalogue');

        await page.locator('.catalogue-row[data-endpoint-id="test-endpoint-001"]').click();
        await dbmn.waitForSent('openEndpointAsTab');

        const tab = await dbmn.waitForTab('endpoint:test-endpoint-001');
        await expect(tab.locator('#endpointName')).toHaveValue('Test API Endpoint');
        await expect(tab.locator('#endpointPath')).toHaveValue('/api/test');
        await expect(tab.locator('#endpointMethod')).toHaveValue('POST');
        await expect(page.locator('#hubTabStrip')).toContainText('Test API Endpoint');

        // The tab asked the host for its data through the embedded envelope.
        const ready = await dbmn.sent('ready', 'endpoint:test-endpoint-001');
        expect(ready).toHaveLength(1);

        await dbmn.settle();
        await expect(page).toHaveScreenshot('endpoint-tab.png', {
            mask: [tab.locator('#monacoEditorContainer')]
        });
    });

    test('with no environments, the empty state offers Add Environment (#350)', async ({ dbmn, page }) => {
        dbmn.seed.environments = [];
        await dbmn.openHub();

        await page.locator('.hub-nav-item[data-section="environments"]').click();
        await expect(page.locator('#hubEnvironmentEmpty')).toBeVisible();
        await page.locator('#hubAddEnvironmentEmpty').click();
        await dbmn.waitForSent('addEnvironment');
    });

    test('opens an environment as an embedded editor tab', async ({ dbmn, page }) => {
        await dbmn.openHub();

        await page.locator('.hub-nav-item[data-section="environments"]').click();
        await page.locator('#hubEnvironmentList [data-env-id="env-prod-001"]').first().click();
        await dbmn.waitForSent('openEnvironmentAsTab');

        const tab = await dbmn.waitForTab('environment:env-prod-001');
        await expect(tab.locator('#envName')).toHaveValue('Production');
        await expect(tab.locator('#envBaseUrl')).toHaveValue('https://api.example.com');
        await dbmn.settle();
        await expect(page).toHaveScreenshot('environment-tab.png');
    });
});
