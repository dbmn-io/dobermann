/**
 * <dbmn-run-heading> and <dbmn-guard-line> (design system, the Console / Run Batch epic #464, #470), in a real browser
 * from the real files.
 *
 *   npm run test:e2e:webview      (no backend needed)
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = rel => readFileSync(join(ROOT, 'src/webviews', rel), 'utf8');
const STYLES = ['shared/atomic.css', 'shared/core.css', 'shared/tables.css', 'shared/console.css', 'shared/search.css', 'shared/modals.css', 'shared/column-head.css', 'shared/column-drag.css', 'shared/dbmn-table.css'];
const SCRIPTS0 = ['shared/icons.js', 'shared/search-matcher.js', 'shared/value-formatter.js', 'shared/dbmn-modal.js', 'shared/dbmn-clipboard.js', 'shared/cell-detail.js',
    'shared/virtual-window.js', 'shared/dbmn-context-menu.js', 'shared/column-drag.js', 'shared/column-head.js', 'shared/dbmn-table.js'];

const MORE = ['shared/dbmn-name.js', 'shared/dbmn-run-heading.js', 'shared/dbmn-guard-line.js'];
const page = () => `<!doctype html><html><head>
<style>:root{--dbmn-foreground:#ccc;--dbmn-editor-background:#1e1e1e;--dbmn-panel-border:#444}
${STYLES.concat(['shared/tabs.css', 'shared/dbmn-name.css']).map(read).join('\n')}
body{margin:0;padding:16px;width:1100px;background:#1e1e1e;color:#ccc;font:13px sans-serif}</style>
${['shared/icons.js'].concat(MORE).map(rel => `<script>${read(rel)}</script>`).join('\n')}</head><body>
<dbmn-run-heading id="h"></dbmn-run-heading>
<dbmn-guard-line id="g"></dbmn-guard-line>
<script>
  window.heard = [];
  ['dbmn-run-heading-tab', 'dbmn-run-heading-info', 'dbmn-run-heading-environment', 'dbmn-name-change', 'dbmn-run-heading-issues'].forEach(type =>
      document.addEventListener(type, e => window.heard.push([type, e.detail || null])));
  const h = document.getElementById('h');
  h.environment = { name: 'DBMN Local' };
  h.name = 'Inventory-Errors 20 Nov 20:14';
  window.tabs = (c = 1) => [{ id: 'input', label: 'Input', count: 1000 }, { id: 'requests', label: 'Requests', count: 5 },
      { id: 'success', label: 'Completed', count: c, tone: 'ok' }, { id: 'errors', label: 'Error', count: 1, tone: 'error' }];
  h.tabs = tabs();
  h.active = 'requests';
</script></body></html>`;
const heard = p => p.evaluate(() => window.heard.splice(0));

test('the run heading: the environment link, the name, ⓘ and the tabs say what was clicked; only the tone counts are coloured', async ({ page: p }) => {
    await p.setContent(page());
    await expect(p.locator('#h .dbmn-run-env')).toHaveText('DBMN Local');
    await expect(p.locator('#h .dbmn-run-tab')).toHaveText(['Input1000', 'Requests5', 'Completed1', 'Error1']);
    await expect(p.locator('#h .dbmn-run-tab.active')).toHaveText('Requests5');
    await p.locator('#h .dbmn-run-env').click();
    await p.locator('#h .dbmn-run-info').click();
    await p.locator('#h .dbmn-run-tab', { hasText: 'Completed' }).click();
    expect(await heard(p)).toEqual([['dbmn-run-heading-environment', null], ['dbmn-run-heading-info', null], ['dbmn-run-heading-tab', { id: 'success' }]]);
    // Colour: Completed and Error tinted; Input and Requests neutral
    const bg = sel => p.locator(sel).evaluate(e => getComputedStyle(e).backgroundColor);
    expect(await bg('#h .dbmn-run-tab[data-tab="success"] .dbmn-run-count')).not.toBe(await bg('#h .dbmn-run-tab[data-tab="input"] .dbmn-run-count'));
    expect(await bg('#h .dbmn-run-tab[data-tab="input"] .dbmn-run-count')).toBe(await bg('#h .dbmn-run-tab[data-tab="requests"] .dbmn-run-count'));
});

test('the run heading: a count that changes pulses once; the name renames in place (dbmn-name)', async ({ page: p }) => {
    await p.setContent(page());
    await p.evaluate(() => { h.tabs = tabs(2); });
    await expect(p.locator('#h .dbmn-run-tab[data-tab="success"] .dbmn-run-count')).toHaveClass(/is-changed/);
    await expect(p.locator('#h .dbmn-run-tab[data-tab="input"] .dbmn-run-count')).not.toHaveClass(/is-changed/);
    // Rename: the name is a dbmn-name
    await p.locator('#h dbmn-name').click();
    await p.keyboard.press('ControlOrMeta+a');
    await p.keyboard.type('Inventory fix-up');
    await p.keyboard.press('Enter');
    expect((await heard(p)).filter(x => x[0] === 'dbmn-name-change').map(x => x[1].name)).toEqual(['Inventory fix-up']);
});

test('the guard line: nothing for no guard; the line and Warning frequency when it asks; the line alone when it does not', async ({ page: p }) => {
    await p.setContent(page());
    await expect(p.locator('#g')).toBeHidden();
    expect(await p.evaluate(() => document.getElementById('g').minutes)).toBe(null);
    const freq = { label: 'Warning frequency', value: '0', options: [{ value: '0', label: 'Warn me every time' }, { value: '15', label: "Don't warn again for 15 minutes" }] };
    await p.evaluate(f => { document.getElementById('g').guard = { environment: 'Acme Prod', line: 'Acme Prod is a production environment.', ask: true, frequency: f }; }, freq);
    await expect(p.locator('#g .dbmn-guard-warning')).toHaveText(/Acme Prod is a production environment\./);
    await p.locator('#g select').selectOption('15');
    expect(await p.evaluate(() => document.getElementById('g').minutes)).toBe(15);
    await p.evaluate(f => { document.getElementById('g').guard = { environment: 'Acme Prod', line: 'Acme Prod is a production environment.', ask: false, frequency: f }; }, freq);
    await expect(p.locator('#g select')).toHaveCount(0);
    expect(await p.evaluate(() => document.getElementById('g').minutes)).toBe(null);
});

test('the run heading: setCount and setHidden change one tab as the run goes, the others kept; has() says what shows', async ({ page: p }) => {
    await p.setContent(page());
    await p.evaluate(() => { h.setHidden('errors', true); });
    await expect(p.locator('#h .dbmn-run-tab:not([hidden])')).toHaveCount(3);
    await expect(p.locator('#h .dbmn-run-tab[data-tab="errors"] .tab-count')).toHaveText('1');   // (kept unseen, its count right)
    expect(await p.evaluate(() => h.has('errors'))).toBe(false);
    await p.evaluate(() => { h.setCount('success', 3); h.setHidden('errors', false); h.setCount('errors', 2); });
    await expect(p.locator('#h .dbmn-run-tab')).toHaveText(['Input1000', 'Requests5', 'Completed3', 'Error2']);
    await expect(p.locator('#h .dbmn-run-tab.active')).toHaveText('Requests5');
    expect(await p.evaluate(() => h.has('errors'))).toBe(true);
});

test('the run heading: a live count keeps the same tab button (a click never lands on one being replaced); an amber issues count asks on its own', async ({ page: p }) => {
    await p.setContent(page());
    await p.evaluate(() => { window.before = document.querySelector('#h .dbmn-run-tab[data-tab="success"]'); h.setCount('success', 7); h.setIssues('input', 3); });
    expect(await p.evaluate(() => window.before === document.querySelector('#h .dbmn-run-tab[data-tab="success"]'))).toBe(true);
    await expect(p.locator('#h .dbmn-run-tab[data-tab="input"] .dbmn-run-issues')).toHaveText('3');
    await p.locator('#h .dbmn-run-tab[data-tab="input"] .dbmn-run-issues').click();
    await p.locator('#h .dbmn-run-tab[data-tab="input"] .dbmn-run-tab-label').click();
    expect((await heard(p)).map(x => x[0] + ':' + (x[1] && x[1].id))).toEqual(['dbmn-run-heading-issues:input', 'dbmn-run-heading-tab:input']);
    await p.evaluate(() => h.setIssues('input', 0));
    await expect(p.locator('#h .dbmn-run-issues')).toHaveCount(0);
});
