/**
 * The footer components (shared/dbmn-footer.js) and the design system's page that shows them,
 * in a real browser from the real files.
 *
 *   npm run test:e2e:webview      (no backend needed; the page test needs `npm run build` first)
 */
import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WEBVIEWS = join(ROOT, 'src/webviews');
const read = rel => readFileSync(join(WEBVIEWS, rel), 'utf8');

const STEPS = ['Views', 'Join', 'Columns', 'Results'];
const STEPS_TAG = '<dbmn-steps id="steps" label="Query steps"></dbmn-steps>';
const footerPage = (width = 1000, right = STEPS_TAG) => `<!doctype html><html><head>
<style>body{margin:0;padding-top:300px;font:13px sans-serif;width:${width}px;--vscode-foreground:#ccc;--vscode-textLink-foreground:#3794ff;background:#1e1e1e;color:#ccc}
.btn{padding:7px 16px;font-size:13px;line-height:18px;min-width:88px}
${read('shared/dbmn-footer.css')}</style>
<script>${read('shared/icons.js')}</script><script>${read('shared/dbmn-footer.js')}</script></head><body>
<dbmn-footer inline>
  <dbmn-actions><button class="btn" id="back">Back</button><button class="btn" id="next">Next: Columns</button></dbmn-actions>
  ${right}
</dbmn-footer>
<script>
  const steps = document.getElementById('steps');
  window.went = [];
  steps.addEventListener('dbmn-step', e => window.went.push(e.detail.step));
  steps.steps = ${JSON.stringify(STEPS.map(label => ({ label })))};
  window.show = (states, current) => steps.render(states, current);
</script></body></html>`;

const at = current => STEPS.map((label, i) => ({
    status: i + 1 === current ? 'current' : i + 1 < current ? 'done' : i + 1 === current + 1 ? 'available' : 'pending',
    summary: `${label} summary`
}));

test('steps: one line, the current one marked, only open steps answer a click', async ({ page }) => {
    await page.setContent(footerPage());
    await page.evaluate(states => window.show(states, 2), at(2));
    const step = n => page.locator(`.dbmn-step[data-step="${n}"]`);

    await expect(page.locator('.dbmn-step')).toHaveCount(4);
    await expect(step(2)).toHaveAttribute('aria-current', 'step');
    await expect(step(1).locator('svg')).toHaveCount(1);          // done: a tick
    await expect(step(2).locator('.dbmn-step-mark')).toHaveText('2');
    await expect(step(4)).toBeDisabled();                         // not reached
    // One line: every step and the buttons share a row, at the buttons' height
    const tops = await page.locator('.dbmn-step').evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().top)));
    expect(new Set(tops).size).toBe(1);
    expect(await page.locator('dbmn-steps').evaluate(e => e.getBoundingClientRect().height)).toBe(32);

    await step(1).click();
    await step(3).click();
    await step(4).click({ force: true });
    expect(await page.evaluate(() => window.went)).toEqual([1, 3]);
});

test('a step that is working shows a spinner in place of its number', async ({ page }) => {
    await page.setContent(footerPage());
    await page.evaluate(states => window.show(states, 2), at(2).map((st, i) => (i === 1 ? { ...st, checking: true } : st)));
    const working = page.locator('.dbmn-step[data-step="2"]');
    await expect(working).toHaveClass(/is-checking/);
    await expect(working.locator('.dbmn-step-mark svg')).toHaveCount(1);
    await expect(working.locator('.dbmn-step-mark')).not.toHaveText('2');
});

test('folded: the steps become a summary button that lists them', async ({ page }) => {
    await page.setContent(footerPage());
    await page.evaluate(states => {
        window.show(states, 4);
        const steps = document.getElementById('steps');
        steps.summary = ['3 views', '19 columns', '412 of 5,310 rows'];
        steps.folded = true;
    }, at(4));

    await expect(page.locator('.dbmn-step:visible')).toHaveCount(0);
    const summary = page.locator('.dbmn-steps-summary');
    await expect(summary).toContainText('412 of 5,310 rows');
    await expect(page.locator('.dbmn-steps-list')).toHaveCount(0);

    await summary.click();
    await expect(summary).toHaveAttribute('aria-expanded', 'true');
    const items = page.locator('.dbmn-steps-item');
    await expect(items).toHaveCount(4);
    await expect(items.locator('.dbmn-steps-item-name')).toHaveText(['Views', 'Join', 'Columns', 'Results']);
    await expect(items.nth(1)).toHaveText('Join');   // a step by name, nothing more
    await expect(items.nth(3)).toHaveClass(/is-current/);
    // The list opens over the footer, inside the window
    const box = await page.locator('.dbmn-steps-list').boundingBox();
    const foot = await page.locator('dbmn-footer').boundingBox();
    expect(box.y + box.height).toBeLessThanOrEqual(foot.y + 8);

    await items.nth(1).click();
    expect(await page.evaluate(() => window.went)).toEqual([2]);
    await expect(page.locator('.dbmn-steps-list')).toHaveCount(0);

    // Escape and a click elsewhere close it too
    await summary.click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.dbmn-steps-list')).toHaveCount(0);
    await summary.click();
    await page.mouse.click(5, 5);
    await expect(page.locator('.dbmn-steps-list')).toHaveCount(0);
});

test('the highlight slides to the step that takes over, and folding is shown', async ({ page }) => {
    await page.setContent(footerPage());
    await page.evaluate(states => window.show(states, 2), at(2));
    const left = sel => page.locator(sel).evaluate(e => Math.round(e.getBoundingClientRect().left));
    const width = sel => page.locator(sel).evaluate(e => Math.round(e.getBoundingClientRect().width));
    // One highlight, behind the current step and as wide as it
    await expect(page.locator('dbmn-steps')).toHaveClass(/is-ready/);
    await expect.poll(() => left('.dbmn-steps-indicator')).toBe(await left('.dbmn-step[data-step="2"]'));
    await expect.poll(() => width('.dbmn-steps-indicator')).toBe(await width('.dbmn-step[data-step="2"]'));

    // On to step 3: it is on its way before it arrives (a slide, not a cut), then sits behind step 3
    await page.evaluate(states => window.show(states, 3), at(3));
    const target = await left('.dbmn-step[data-step="3"]');
    expect(await left('.dbmn-steps-indicator')).toBeLessThan(target);
    await expect.poll(() => left('.dbmn-steps-indicator')).toBe(target);

    // Folding: the steps are still there as the box narrows, then only the summary is
    const wide = await width('dbmn-steps');
    await page.evaluate(states => {
        window.show(states, 4);
        const steps = document.getElementById('steps');
        steps.summary = ['3 views', '20 rows'];
        steps.folded = true;
    }, at(4));
    await expect(page.locator('dbmn-steps')).toHaveClass(/is-folding/);
    await expect(page.locator('.dbmn-step:visible')).toHaveCount(4);
    // A cascade: the first step sets off at once, the third waits its turn, the last never moves,
    // and each is headed for the last one's place
    const moved = n => page.locator(`.dbmn-step[data-step="${n}"]`).evaluate(e => ({ wait: e.style.getPropertyValue('--fold-wait'), time: e.style.getPropertyValue('--fold-time'), x: parseFloat(e.style.getPropertyValue('--fold-x')) }));
    expect(await moved(1)).toMatchObject({ wait: '0ms', time: '450ms' });
    expect(await moved(3)).toMatchObject({ wait: '300ms', time: '150ms' });
    expect(await moved(4)).toMatchObject({ time: '0ms' });
    expect(Math.abs((await moved(4)).x)).toBeLessThan(0.5);
    expect((await moved(1)).x).toBeGreaterThan((await moved(2)).x);
    expect((await moved(2)).x).toBeGreaterThan((await moved(3)).x);
    await expect(page.locator('dbmn-steps')).not.toHaveClass(/is-folding/);
    await expect(page.locator('.dbmn-step:visible')).toHaveCount(0);
    await expect(page.locator('.dbmn-steps-summary')).toBeVisible();
    expect(await width('dbmn-steps')).toBeLessThan(wide);

    // And back: the steps return, the highlight behind the one asked for
    await page.evaluate(states => {
        // (where the highlight sets off from, noted as its slide begins)
        const indicator = document.querySelector('.dbmn-steps-indicator');
        indicator.addEventListener('transitionrun', () => { window.slidFrom = window.slidFrom ?? Math.round(indicator.getBoundingClientRect().left); });
        document.getElementById('steps').folded = false;
        window.show(states, 1);
    }, at(1));
    await expect(page.locator('.dbmn-step:visible')).toHaveCount(4);
    // The fold backwards: every card starts at the last one's place and deals out, the first step travelling longest
    await expect(page.locator('dbmn-steps')).toHaveClass(/is-unfolding/);
    expect(await moved(1)).toMatchObject({ time: '450ms' });
    expect(await moved(3)).toMatchObject({ time: '150ms' });
    expect((await moved(1)).x).toBeGreaterThan((await moved(3)).x);
    // In order: while they deal out, the step they were on (the last) is the tinted one...
    await expect(page.locator('.dbmn-step[data-step="4"]')).toHaveAttribute('data-fold-from', '');
    await expect(page.locator('dbmn-steps')).not.toHaveClass(/is-unfolding/);
    // ...then the highlight leaves from behind it (still right of the first step) and slides home
    await expect.poll(() => page.evaluate(() => window.slidFrom ?? 0)).toBeGreaterThan(await left('.dbmn-step[data-step="3"]'));
    await expect.poll(async () => (await left('.dbmn-steps-indicator')) - (await left('.dbmn-step[data-step="1"]'))).toBe(0);
    await expect(page.locator('.dbmn-step[data-fold-from]')).toHaveCount(0);
});

test('folded while something is still worked out: the tick is a spinner', async ({ page }) => {
    await page.setContent(footerPage());
    await page.evaluate(states => {
        const steps = document.getElementById('steps');
        steps.folded = true;
        window.show(states.map((st, i) => (i === 3 ? { ...st, checking: true } : st)), 4);
    }, at(4));
    await expect(page.locator('.dbmn-steps-summary .dbmn-step-mark')).toHaveClass(/is-working/);
});

test('too narrow for every name: the current step and "2 of 4", the buttons untouched', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 200 });
    await page.setContent(footerPage(420));
    await page.evaluate(states => window.show(states, 2), at(2));
    await expect(page.locator('dbmn-steps')).toHaveClass(/is-tight/);
    await expect(page.locator('.dbmn-step:visible')).toHaveCount(1);
    await expect(page.locator('.dbmn-steps-of')).toHaveText('2 of 4');
    await expect(page.locator('#next')).toBeVisible();
});

test('progress: the box is the bar, and says so to a screen reader', async ({ page }) => {
    await page.setContent(footerPage(1000, '<dbmn-steps id="steps" hidden></dbmn-steps><dbmn-progress id="bar" phase="Sending" count="7 of 10" value="70"></dbmn-progress>'));
    const bar = page.locator('#bar');
    await expect(bar).toHaveAttribute('aria-valuenow', '70');
    await expect(bar).toHaveAttribute('aria-valuetext', 'Sending, 7 of 10');
    const fill = async () => page.locator('.dbmn-progress-fill').evaluate(e => e.getBoundingClientRect().width / e.parentNode.getBoundingClientRect().width);
    expect(await fill()).toBeGreaterThan(0.65);
    expect(await bar.evaluate(e => e.getBoundingClientRect().height)).toBe(32);
    await bar.evaluate(e => { e.setAttribute('value', '100'); e.setAttribute('count', '10 of 10'); });
    await expect(bar).toHaveAttribute('aria-valuenow', '100');
    await expect(page.locator('.dbmn-progress-count')).toHaveText('10 of 10');

    // The one time that matters sits beside the count, on the same line
    await bar.evaluate(e => { e.setAttribute('count', '91 of 501'); e.setAttribute('note', '<1m left'); });
    await expect(page.locator('.dbmn-progress-count')).toHaveText('91 of 501 · <1m left');
    await expect(bar).toHaveAttribute('aria-valuetext', 'Sending, 91 of 501, <1m left');
    expect(await bar.evaluate(e => e.getBoundingClientRect().height)).toBe(32);

    // With figures behind it, a click lists them above the box; Escape or a click elsewhere closes
    await expect(bar).not.toHaveClass(/has-stats/);
    await bar.evaluate(e => { e.stats = [{ label: 'Started', value: '09:15:02' }, { label: 'Taken', value: '13s' }, { label: 'Failed', value: 3 }]; });
    await expect(bar).toHaveClass(/has-stats/);
    await bar.click();
    await expect(page.locator('.dbmn-progress-stat')).toHaveCount(3);
    await expect(page.locator('.dbmn-progress-stat').nth(1)).toHaveText('Taken13s');
    const list = await page.locator('.dbmn-progress-stats').boundingBox();
    expect(list.y + list.height).toBeLessThanOrEqual((await bar.boundingBox()).y);
    // They follow the run while open
    await bar.evaluate(e => { e.stats = [{ label: 'Taken', value: '14s' }]; });
    await expect(page.locator('.dbmn-progress-stat')).toHaveText(['Taken14s']);
    // A figure the user may change has less and more buttons: the box asks, the screen answers
    await bar.evaluate(e => {
        window.asked = [];
        e.addEventListener('dbmn-progress-change', event => {
            window.asked.push(event.detail);
            e.stats = e.stats.map(item => (item.id === event.detail.id ? { ...item, value: event.detail.value } : item));
        });
        e.stats = [{ id: 'threads', label: 'Threads', value: 15, min: 1, max: 16 }, { label: 'Rows per request', value: 100 }];
    });
    const more = page.locator('.dbmn-progress-step[aria-label="More threads"]');
    await more.click();
    await expect(page.locator('.dbmn-progress-step-value')).toHaveText('16');
    await expect(more).toBeDisabled();                       // at the limit it was given
    await page.locator('.dbmn-progress-step[aria-label="Fewer threads"]').click();
    expect(await page.evaluate(() => window.asked)).toEqual([{ id: 'threads', value: 16 }, { id: 'threads', value: 15 }]);
    await expect(page.locator('.dbmn-progress-stats')).toHaveCount(1);   // stepping never closes the list
    await expect(page.locator('.dbmn-progress-stat').nth(1)).toHaveText('Rows per request100');
    // A figure with set choices: a button each, the one in use pressed, one over the limit switched off
    await bar.evaluate(e => {
        window.asked = [];
        e.stats = [{ id: 'threads', label: 'Threads', value: 8, options: [1, 2, 4, 8, 16], max: 8, overTitle: 'This environment allows up to 8' }];
    });
    const choice = n => page.locator('.dbmn-progress-choice', { hasText: new RegExp(`^${n}$`) });
    await expect(page.locator('.dbmn-progress-choice')).toHaveText(['1', '2', '4', '8', '16']);
    await expect(choice(8)).toHaveAttribute('aria-pressed', 'true');
    await expect(choice(16)).toBeDisabled();
    await expect(choice(16)).toHaveAttribute('title', 'This environment allows up to 8');
    await choice(4).click();
    await expect(choice(4)).toHaveAttribute('aria-pressed', 'true');
    await choice(4).click();                                   // the one in use asks nothing
    expect(await page.evaluate(() => window.asked)).toEqual([{ id: 'threads', value: 4 }]);
    // A yes or no is a switch: it asks for the other answer
    await bar.evaluate(e => { window.asked = []; e.stats = [{ id: 'stopOnError', label: 'Stop on first error', value: false }]; });
    const stop = page.locator('.dbmn-progress-switch[aria-label="Stop on first error"]');
    await expect(stop).toHaveAttribute('aria-checked', 'false');
    await stop.click();
    await expect(stop).toHaveAttribute('aria-checked', 'true');
    await stop.press('Space');
    await expect(stop).toHaveAttribute('aria-checked', 'false');
    expect(await page.evaluate(() => window.asked)).toEqual([{ id: 'stopOnError', value: true }, { id: 'stopOnError', value: false }]);
    await expect(page.locator('.dbmn-progress-stats')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.dbmn-progress-stats')).toHaveCount(0);
    await bar.press('Enter');
    await expect(page.locator('.dbmn-progress-stats')).toHaveCount(1);
    await page.mouse.click(5, 5);
    await expect(page.locator('.dbmn-progress-stats')).toHaveCount(0);
});

// The page itself: built by the screen's own builder (compiled by `npm run build`), its files served from src/
const builder = join(ROOT, 'out/screens/design-system/design-system-page.js');
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
test('the design system page draws every section from the real files, with no errors', async ({ page }) => {
    test.skip(!existsSync(builder), 'run `npm run build` first');
    const { buildDesignSystemPage } = createRequire(import.meta.url)(builder);
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.route('http://dbmn.test/**', route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: buildDesignSystemPage(rel => `/webviews/${rel}`) });
        const file = join(ROOT, 'src', url.pathname);
        return existsSync(file) ? route.fulfill({ contentType: TYPES[extname(file)] || 'application/octet-stream', body: readFileSync(file) }) : route.fulfill({ status: 404, body: '' });
    });
    await page.goto('http://dbmn.test/');

    await expect(page.locator('#dsSteps .dbmn-step')).toHaveCount(4);
    await expect(page.locator('#dsWorking .dbmn-step.is-checking')).toHaveCount(1);
    expect(await page.locator('#dsIcons .ds-icon').count()).toBeGreaterThan(80);
    await expect(page.locator('#dsSwatches .ds-swatch')).toHaveCount(17);
    // The table on show is the component, over 5,000 rows with only the ones in view drawn
    await expect(page.locator('#dsOrders .col-sort-btn')).toHaveCount(8);
    await expect(page.locator('#dsOrders .dbmn-table-count')).toHaveText('5,000 rows');
    expect(await page.locator('#dsOrders .dbmn-table-body tr').count()).toBeLessThan(120);
    // The list of pieces is the same component: every piece with its state, and searchable
    expect(await page.locator('#dsInventory .dbmn-table-body tr').count()).toBeGreaterThan(20);
    await expect(page.locator('#dsInventory .dbmn-table-body tr').first().locator('.ds-chip')).toHaveText('Component');
    await page.locator('#dsInventory .search-input').fill('@state=planned');
    await expect(page.locator('#dsInventory .dbmn-table-body .ds-chip')).toHaveText(['Planned', 'Planned', 'Planned']);
    await page.locator('#dsInventory .search-input').fill('');
    // Which screen is on which component, in the same table
    await expect(page.locator('#dsMoving .dbmn-table-count')).toHaveText('11 rows');
    await page.locator('#dsMoving .search-input').fill('@screen=query');
    await expect(page.locator('#dsMoving .dbmn-table-body .ds-chip')).toHaveText(['On it', 'Waits']);

    // The wizard on show walks to its last step and folds into the summary, and back
    await page.locator('#dsNext').click();
    await expect(page.locator('#dsNext')).toHaveText('Next: Results');
    await page.locator('#dsNext').click();
    await expect(page.locator('#dsSteps .dbmn-steps-summary')).toBeVisible();
    await page.locator('#dsSteps .dbmn-steps-summary').click();
    await page.locator('#dsSteps .dbmn-steps-item').nth(0).click();
    await expect(page.locator('#dsSteps .dbmn-step[data-step="1"]')).toHaveAttribute('aria-current', 'step');

    // Find narrows the icon list
    await page.locator('#dsIconFind').fill('chevron');
    expect(await page.locator('#dsIcons .ds-icon:visible').count()).toBeLessThan(15);

    // The dialogs and messages on show are the real ones
    await page.locator('[data-click="ds:toast"][data-arg="success"]').click();
    await expect(page.locator('.dbmn-toast')).toContainText('Saved');
    await page.locator('[data-click="ds:confirm"]').click();
    await expect(page.locator('.dbmn-modal, .dbmn-modal-overlay').first()).toBeVisible();

    expect(errors).toEqual([]);
});
