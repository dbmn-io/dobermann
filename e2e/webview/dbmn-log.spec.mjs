/**
 * <dbmn-log> and <dbmn-level> (Dobermann issue 7) in a real browser from the real files: log lines
 * as a <dbmn-table>, the newest kept in view, searched with the table's own terms.
 *
 *   npm run test:e2e:webview      (no backend needed)
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = rel => readFileSync(join(ROOT, 'src/webviews', rel), 'utf8');
const STYLES = ['shared/atomic.css', 'shared/core.css', 'shared/tables.css', 'shared/console.css', 'shared/search.css', 'shared/modals.css', 'shared/column-head.css', 'shared/column-drag.css', 'shared/dbmn-table.css', 'shared/dbmn-log.css'];
const SCRIPTS = ['shared/icons.js', 'shared/search-matcher.js', 'shared/value-formatter.js', 'shared/dbmn-modal.js', 'shared/dbmn-clipboard.js', 'shared/cell-detail.js',
    'shared/virtual-window.js', 'shared/dbmn-context-menu.js', 'shared/column-drag.js', 'shared/column-head.js', 'shared/dbmn-saved-searches.js', 'shared/dbmn-table.js', 'shared/dbmn-level.js', 'shared/dbmn-log.js'];

// Local times, so the expected text is the computer's own whatever the time zone the test runs in
const AT = new Date(2026, 10, 19, 14, 3, 22, 120).getTime();
const logPage = (attrs = '') => `<!doctype html><html><head>
<style>:root{--vscode-foreground:#ccc;--vscode-editor-background:#1e1e1e;--vscode-panel-border:#444;--vscode-input-background:#2a2a2a}
${STYLES.map(read).join('\n')}
body{margin:0;padding:16px;width:1000px;height:420px;display:flex;flex-direction:column;box-sizing:border-box;background:#1e1e1e;color:#ccc;font:13px sans-serif}
dbmn-log{flex:1}</style>
${SCRIPTS.map(rel => `<script>${read(rel)}</script>`).join('\n')}</head><body>
<dbmn-log id="log" label="Logs" ${attrs}></dbmn-log>
<script>
  const log = document.getElementById('log');
  window.told = [];
  log.addEventListener('dbmn-log-shown', e => window.told.push(e.detail));
  window.AT = ${AT};
  const run = { id: '7c1e40aa-5d1f-4c55-9f0e-2b8e1d0c3a11', name: 'Create Item' };
  let seq = 0;
  window.line = (over) => Object.assign({ seq: ++seq, time: ${AT} + seq * 1000, level: 'info', source: 'run', message: 'row ' + seq + ' sent' }, over);
  const lines = [
    line({ source: 'start-up', message: 'Hub ready' }),
    line({ level: 'error', source: 'sign-in', environment: 'Test', message: 'Token request refused: invalid_client', detail: 'Error: invalid_client\\n    at exchange (oauth.ts:120)' }),
  ];
  for (let i = 0; i < 200; i++) lines.push(line({ environment: 'Test', run, level: i % 50 === 7 ? 'warn' : 'info' }));
  log.lines = lines;
</script></body></html>`;

const first = page => page.locator('#log .dbmn-table-body tr').first();
const scroller = page => page.locator('#log .dbmn-table-scroll');
const atTop = page => scroller(page).evaluate(s => s.scrollTop <= 30);

test('the lines as a table: local time, the level as an icon and a word, the newest at the top', async ({ page }) => {
    await page.setContent(logPage());
    await expect(page.locator('#log thead .column-name')).toHaveText(['Time', 'Level', 'Source', 'Environment', 'Run', 'Message']);
    await expect(page.locator('#log .dbmn-table-count')).toHaveText('202 rows');
    await expect(first(page)).toContainText('row 202 sent');
    expect(await atTop(page)).toBe(true);
    await page.locator('#log .search-input').fill('@source=sign-in');
    const row = first(page);
    await expect(row.locator('td').nth(0)).toHaveText('2026-11-19 14:03:24.120');
    await expect(row.locator('dbmn-level')).toHaveText('Error');
    expect(await row.locator('dbmn-level svg').count()).toBe(1);
    await expect(row.locator('td').nth(3)).toHaveText('Test');
});

test('new lines come in at the top; scrolled down, the view stays put and they are counted; Follow goes back up', async ({ page }) => {
    await page.setContent(logPage());
    await page.evaluate(() => log.append([line({ message: 'fresh one' })]));
    await expect(first(page)).toContainText('fresh one');
    expect(await atTop(page)).toBe(true);

    await scroller(page).evaluate(s => { s.scrollTop = 1200; });
    await expect.poll(() => page.evaluate(() => log.following)).toBe(false);
    const before = await scroller(page).evaluate(s => s.scrollTop);
    const onScreen = await page.locator('#log .dbmn-table-body tr').nth(30).textContent();
    await page.evaluate(() => log.append([line({ message: 'while away 1' }), line({ message: 'while away 2' })]));
    await page.waitForTimeout(100);
    // What was on screen has not moved: the view went down by the two new rows
    expect(await scroller(page).evaluate(s => s.scrollTop)).toBeGreaterThan(before);
    expect(await page.locator('#log .dbmn-table-body tr', { hasText: onScreen.slice(0, 23) }).count()).toBeGreaterThan(0);
    const told = await page.evaluate(() => window.told[window.told.length - 1]);
    expect(told).toMatchObject({ following: false, unseen: 2, total: 205 });

    await page.evaluate(() => { log.following = true; });
    await expect(first(page)).toContainText('while away 2');
    expect(await atTop(page)).toBe(true);
    expect(await page.evaluate(() => window.told[window.told.length - 1].unseen)).toBe(0);
});

test('searched with the table\'s terms: a level, a run by its name or its id', async ({ page }) => {
    await page.setContent(logPage());
    const box = page.locator('#log .search-input');
    const count = page.locator('#log .dbmn-table-count');
    await box.fill('@level=error|warn');
    await expect(count).toHaveText('5 of 202 rows');
    await box.fill('@run="Create Item"');
    await expect(count).toHaveText('200 of 202 rows');
    await box.fill('@run=7c1e40aa-5d1f-4c55-9f0e-2b8e1d0c3a11');
    await expect(count).toHaveText('200 of 202 rows');
    await expect(page.locator('#log .dbmn-table-body tr').first().locator('td').nth(4)).toHaveText('Create Item');
});

test('Copy\'s text is the lines shown, with a line\'s detail under it', async ({ page }) => {
    await page.setContent(logPage());
    await page.locator('#log .search-input').fill('@level=error');
    const text = await page.evaluate(() => log.text());
    expect(text).toBe([
        '2026-11-19 14:03:24.120  ERROR  sign-in  [Test]  Token request refused: invalid_client',
        '    Error: invalid_client',
        '        at exchange (oauth.ts:120)'
    ].join('\n'));
});

test('a line with more to it opens in full when its message is clicked', async ({ page }) => {
    await page.setContent(logPage());
    await page.locator('#log .search-input').fill('@level=error');
    await page.locator('#log .dbmn-log-message.has-detail').click();
    await expect(page.locator('.dbmn-modal, .cell-detail-modal, [role="dialog"]').first()).toContainText('at exchange (oauth.ts:120)');
});

test('scrolled down to the oldest line, older ones are asked for and go in below; a line given twice shows once', async ({ page }) => {
    await page.setContent(logPage());
    await page.evaluate(() => { window.ends = 0; log.addEventListener('dbmn-log-end', () => window.ends++); });
    // Scroll to the bottom: the screen is told, once, that it is time for older lines
    await scroller(page).evaluate(s => { s.scrollTop = s.scrollHeight; });
    await expect.poll(() => page.evaluate(() => window.ends)).toBe(1);
    await scroller(page).evaluate(s => { s.scrollTop = s.scrollHeight - s.clientHeight - 1; s.scrollTop = s.scrollHeight; });
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => window.ends)).toBe(1);

    const top = await scroller(page).evaluate(s => s.scrollTop);
    await page.evaluate(() => log.older(Array.from({ length: 50 }, (_, i) => ({ key: 'old' + String(i).padStart(3, '0'), time: AT - 60000 + i, level: 'info', source: 'sync', message: 'older ' + i }))));
    await expect(page.locator('#log .dbmn-table-count')).toHaveText('252 rows');
    // Nothing on screen moved; the older lines are below it
    await page.waitForTimeout(100);
    expect(await scroller(page).evaluate(s => s.scrollTop)).toBe(top);
    await scroller(page).evaluate(s => { s.scrollTop = s.scrollHeight; });
    await expect(page.locator('#log .dbmn-table-body tr').last()).toContainText('older 0');
    // Asked again once older lines came
    await expect.poll(() => page.evaluate(() => window.ends)).toBe(2);

    // The same line again (a live line the first page also had) shows once; a late one goes in its place by time
    await page.evaluate(() => log.append([{ key: 'old000', time: AT - 60000, level: 'info', source: 'sync', message: 'older 0' }]));
    await page.evaluate(() => log.append([{ key: 'late', time: AT - 30000, level: 'warn', source: 'run', message: 'finished late' }]));
    await expect(page.locator('#log .dbmn-table-count')).toHaveText('253 rows');
    await page.locator('#log .search-input').fill('@source=sync|run @level=warn|info -sent');
    await expect(first(page)).toContainText('finished late');
});

test('a line that opens (a request) asks the screen to open it', async ({ page }) => {
    await page.setContent(logPage());
    await page.evaluate(() => log.append([{ key: 'r-m3', time: AT + 500000, level: 'error', source: 'run', message: 'Row 3: POST /items → 400', open: 'm3' }]));
    const asked = page.evaluate(() => new Promise(resolve => log.addEventListener('dbmn-log-open', e => resolve(e.detail.open), { once: true })));
    await page.locator('#log .search-input').fill('@level=error @source=run');
    await page.locator('#log .dbmn-log-message.has-detail', { hasText: 'Row 3' }).click();
    expect(await asked).toBe('m3');
});

test('without saved-searches, the log has no ★', async ({ page }) => {
    await page.setContent(logPage());
    await expect(page.locator('#log dbmn-saved-searches')).toHaveCount(0);
});

test('saved-searches: the ★ in the log\'s own search box; picked, it searches; a save is told to the screen', async ({ page }) => {
    // James, 2026-11-23: "that saved search should be everywhere where we have a search box"
    // (one page per test: a second setContent keeps the window, and its script's `const log` can't be declared again)
    await page.setContent(logPage('saved-searches'));
    const star = page.locator('#log dbmn-saved-searches');
    await expect(star).toHaveCount(1);
    await page.evaluate(() => {
        window.changes = [];
        log.addEventListener('dbmn-saved-change', e => { window.changes.push(e.detail.searches); log.savedSearches = e.detail.searches; });
        log.savedSearches = [{ name: 'Errors', text: '@level=error' }];
    });
    // In the box at its right end, star only, the text kept clear of it (as in Query: James, 2026-11-23)
    const box = await page.locator('#log .search-input').boundingBox(), btn = await star.locator('.dbmn-saved-btn').boundingBox();
    expect(btn.x + btn.width).toBeLessThanOrEqual(box.x + box.width);
    expect(btn.x).toBeGreaterThan(box.x + box.width - 46);
    expect(Math.abs((btn.y + btn.height / 2) - (box.y + box.height / 2))).toBeLessThan(2);
    await expect(star.locator('.dbmn-saved-label')).toBeHidden();
    // Picked: the box holds it and the lines are searched
    await star.locator('.dbmn-saved-btn').click();
    await star.locator('.dbmn-saved-pick', { hasText: 'Errors' }).click();
    await expect(page.locator('#log .search-input')).toHaveValue('@level=error');
    await expect(page.locator('#log .dbmn-table-count')).toHaveText('1 of 202 rows');
    await expect(star.locator('.dbmn-saved-btn')).toHaveAttribute('title', 'Saved search: Errors');
    // A new one saved: told to the screen
    await page.locator('#log .search-input').fill('@source=sign-in');
    await star.locator('.dbmn-saved-btn').click();
    await star.locator('.dbmn-saved-add').click();
    await star.locator('.dbmn-saved-name-input').fill('Sign-in');
    await star.locator('.dbmn-saved-name-input').press('Enter');
    expect(await page.evaluate(() => window.changes.at(-1))).toEqual([{ name: 'Errors', text: '@level=error' }, { name: 'Sign-in', text: '@source=sign-in' }]);
});

test('a run\'s line: its name is a link that asks for the run in the Console; a line with no run has none', async ({ page }) => {
    // James, 2026-11-23 (via the manager): "log link. think so. yes"
    await page.setContent(logPage());
    await page.evaluate(() => {
        window.asked = [];
        window.opened = [];
        log.addEventListener('dbmn-log-run', e => window.asked.push(e.detail));
        log.addEventListener('dbmn-log-open', e => window.opened.push(e.detail.open));
        log.lines = [
            line({ source: 'start-up', message: 'Hub ready' }),
            line({ run: { id: 'r-77', name: 'Create Item', batch: true }, message: 'row 1 sent', open: 'req-1' })
        ];
    });
    const runRow = page.locator('#log .dbmn-table-body tr', { hasText: 'row 1 sent' });
    const plainRow = page.locator('#log .dbmn-table-body tr', { hasText: 'Hub ready' });
    await expect(plainRow.locator('.dbmn-log-run')).toHaveCount(0);
    const link = runRow.locator('.dbmn-log-run');
    await expect(link).toHaveText('Create Item');
    await expect(link).toHaveAttribute('title', 'Open this run in the Console: Create Item');
    // Clicked: the run is asked for, and nothing else (not the line's request)
    await link.click();
    expect((await page.evaluate(() => window.asked))[0].run).toEqual({ id: 'r-77', name: 'Create Item', batch: true });
    expect((await page.evaluate(() => window.asked))[0].open).toBe('req-1');
    expect(await page.evaluate(() => window.opened)).toEqual([]);
    // By keyboard: focused, Enter asks again
    await link.focus();
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => window.asked.length)).toBe(2);
    // The message's own click still opens the request
    await runRow.locator('.dbmn-log-message').click();
    expect(await page.evaluate(() => window.opened)).toEqual(['req-1']);
    // Searched by the run's name, as before
    await page.locator('#log .search-input').fill('@run=r-77');
    await expect(page.locator('#log .dbmn-table-count')).toHaveText('1 of 2 rows');
});

