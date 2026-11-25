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
<style>:root{--vscode-foreground:#ccc;--vscode-textLink-foreground:#3794ff}
body{margin:0;padding-top:300px;font:13px sans-serif;width:${width}px;background:#1e1e1e;color:#ccc}
.btn{padding:7px 16px;font-size:13px;line-height:18px;min-width:88px}
${read('shared/atomic.css')}
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
  // The fold's marks as they are this moment (the classes, how many steps show, each step's fold values)
  window.foldState = () => ({
    cls: steps.className,
    visible: [...steps.querySelectorAll('.dbmn-step')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; }).length,
    steps: [...steps.querySelectorAll('.dbmn-step')].map(e => ({ wait: e.style.getPropertyValue('--fold-wait'), time: e.style.getPropertyValue('--fold-time'), x: parseFloat(e.style.getPropertyValue('--fold-x')), foldFrom: e.hasAttribute('data-fold-from') }))
  });
</script></body></html>`;

const at = current => STEPS.map((label, i) => ({
    status: i + 1 === current ? 'current' : i + 1 < current ? 'done' : i + 1 === current + 1 ? 'available' : 'pending',
    summary: `${label} summary`
}));

test('components take their colours from DBMN\'s names, which are the theme\'s', async ({ page }) => {
    const sheets = ['shared/dbmn-footer.css', 'shared/dbmn-table.css', 'design-system/design-system.css'];
    // No component names a --vscode- colour directly
    for (const file of sheets) expect(read(file).match(/--vscode-[A-Za-z0-9-]+/g) || [], file).toEqual([]);
    // Every name is the theme's colour of the same name and nothing else, defined once in the sheet every screen loads
    const aliases = [...read('shared/atomic.css').matchAll(/^\s+--dbmn-([A-Za-z0-9-]+):\s*([^;]+);/gm)];
    expect(aliases.length).toBeGreaterThan(100);
    for (const [, name, value] of aliases) expect(value, name).toBe(`var(--vscode-${name})`);
    const defined = new Set(aliases.map(m => `--dbmn-${m[1]}`));
    // (buttons.css has DBMN's older names for sizes and tints; components set a few of their own)
    const own = new Set(['shared/buttons.css', 'shared/core.css', ...sheets].flatMap(f => [...read(f).matchAll(/(--dbmn-[A-Za-z0-9-]+)\s*:/g)].map(m => m[1])));
    const used = new Set(sheets.flatMap(f => [...read(f).matchAll(/var\((--dbmn-[A-Za-z0-9-]+)/g)].map(m => m[1])));
    expect([...used].filter(name => !defined.has(name) && !own.has(name))).toEqual([]);

    // A theme change (the theme's colours set again on the page's root, as every host does it) reaches a component at once
    await page.setContent(footerPage());
    await page.evaluate(states => window.show(states, 2), at(2));
    const colours = () => page.evaluate(() => ({
        text: getComputedStyle(document.querySelector('.dbmn-step.is-available')).color,
        accent: getComputedStyle(document.querySelector('.dbmn-steps-indicator')).backgroundColor,
        name: getComputedStyle(document.documentElement).getPropertyValue('--dbmn-foreground').trim()
    }));
    const dark = await colours();
    expect(dark.name).toBe('#ccc');
    await page.evaluate(() => {
        document.documentElement.style.setProperty('--vscode-foreground', '#222222');
        document.documentElement.style.setProperty('--vscode-textLink-foreground', '#cc0000');
    });
    const light = await colours();
    expect(light.name).toBe('#222222');
    expect(light.text).toBe('rgb(34, 34, 34)');
    expect(light.accent).not.toBe(dark.accent);
});

test('the steps are one width whichever step is current: they never shift as the wizard walks', async ({ page }) => {
    await page.setContent(footerPage());
    const box = async () => { const b = await page.locator('#steps').boundingBox(); return [b.x, b.width]; };
    const seen = [];
    for (const current of [1, 2, 3, 4]) {
        await page.evaluate(([states, n]) => window.show(states, n), [at(current), current]);
        await page.waitForTimeout(350);   // (the highlight has slid)
        seen.push(await box());
    }
    expect(seen.slice(1)).toEqual([seen[0], seen[0], seen[0]]);
    // ...and a step that is working (a spinner for its number) is no wider either
    await page.evaluate(states => window.show(states.map((s, i) => (i === 1 ? Object.assign({}, s, { checking: true }) : s)), 2), at(2));
    expect(await box()).toEqual(seen[0]);
});

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

test('a summary part can be shortened on screen and whole on hover', async ({ page }) => {
    await page.setContent(footerPage());
    await page.evaluate(states => {
        window.show(states, 4);
        const steps = document.getElementById('steps');
        steps.summary = ['3 views', { text: '1.2M rows', title: '1,234,567 rows' }];
        steps.folded = true;
    }, at(4));
    const parts = page.locator('.dbmn-steps-summary .dbmn-steps-part');
    await expect(parts).toHaveText(['3 views', '1.2M rows']);
    await expect(parts.nth(1)).toHaveAttribute('title', '1,234,567 rows');
    await expect(parts.nth(0)).not.toHaveAttribute('title', /./);
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

    // On to step 3: a slide, not a cut (the browser starts a transition on it), then it sits behind step 3.
    // (Proved by the transition starting, not by catching it part-way: on a busy machine the slide can
    // finish before the test looks, which failed this check under parallel workers on 2026-11-25.)
    await page.evaluate(states => {
        window.slides = [];
        document.querySelector('.dbmn-steps-indicator').addEventListener('transitionrun', e => window.slides.push(e.propertyName));
        window.show(states, 3);
    }, at(3));
    const target = await left('.dbmn-step[data-step="3"]');
    await expect.poll(() => page.evaluate(() => window.slides)).toContain('transform');
    await expect.poll(() => left('.dbmn-steps-indicator')).toBe(target);

    // Folding: the steps are still there as the box narrows, then only the summary is
    const wide = await width('dbmn-steps');
    // The fold lasts about half a second, then its marks are cleared. They are read in the same call that
    // starts it, so nothing can end it first, however busy the machine.
    const folding = await page.evaluate(states => {
        window.show(states, 4);
        const steps = document.getElementById('steps');
        steps.summary = ['3 views', '20 rows'];
        steps.folded = true;
        return window.foldState();
    }, at(4));
    expect(folding.cls).toContain('is-folding');
    expect(folding.visible).toBe(4);
    // A cascade: the first step sets off at once, the third waits its turn, the last never moves,
    // and each is headed for the last one's place
    const moved = n => folding.steps[n - 1];
    expect(moved(1)).toMatchObject({ wait: '0ms', time: '450ms' });
    expect(moved(3)).toMatchObject({ wait: '300ms', time: '150ms' });
    expect(moved(4)).toMatchObject({ time: '0ms' });
    expect(Math.abs(moved(4).x)).toBeLessThan(0.5);
    expect(moved(1).x).toBeGreaterThan(moved(2).x);
    expect(moved(2).x).toBeGreaterThan(moved(3).x);
    await expect(page.locator('dbmn-steps')).not.toHaveClass(/is-folding/);
    await expect(page.locator('.dbmn-step:visible')).toHaveCount(0);
    await expect(page.locator('.dbmn-steps-summary')).toBeVisible();
    expect(await width('dbmn-steps')).toBeLessThan(wide);

    // And back: the steps return, the highlight behind the one asked for (read as it starts, as above)
    const unfolding = await page.evaluate(states => {
        // (where the highlight sets off from, noted as its slide begins)
        const indicator = document.querySelector('.dbmn-steps-indicator');
        indicator.addEventListener('transitionrun', () => { window.slidFrom = window.slidFrom ?? Math.round(indicator.getBoundingClientRect().left); });
        document.getElementById('steps').folded = false;
        window.show(states, 1);
        return window.foldState();
    }, at(1));
    expect(unfolding.visible).toBe(4);
    // The fold backwards: every card starts at the last one's place and deals out, the first step travelling longest
    expect(unfolding.cls).toContain('is-unfolding');
    expect(unfolding.steps[0]).toMatchObject({ time: '450ms' });
    expect(unfolding.steps[2]).toMatchObject({ time: '150ms' });
    expect(unfolding.steps[0].x).toBeGreaterThan(unfolding.steps[2].x);
    // In order: while they deal out, the step they were on (the last) is the tinted one...
    expect(unfolding.steps[3].foldFrom).toBe(true);
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
    await bar.evaluate(e => { window.asked = []; e.stats = [{ id: 'stopOnError', label: 'Stop on next error', value: false }]; });
    const stop = page.locator('.dbmn-progress-switch[aria-label="Stop on next error"]');
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

test('progress: the fill glides from figure to figure, still moving while the page is busy; going back is at once', async ({ page }) => {
    await page.setContent(footerPage(1000, '<dbmn-steps id="steps" hidden></dbmn-steps><dbmn-progress id="bar" phase="Loading" value="0"></dbmn-progress>'));
    // First it sits empty a while (a view waiting its turn): that wait must not slow the glide once figures come
    await page.waitForTimeout(1500);
    // As Query reads a view in the web app: the page's own thread busy 250ms, then a figure, again and again.
    // After each figure the fill must be gliding (an animation of its scale, which the graphics side runs
    // while the thread is busy), and for longer than the wait, so it never stops before the next figure.
    const seen = await page.evaluate(() => {
        const bar = document.getElementById('bar');
        const fill = bar.querySelector('.dbmn-progress-fill');
        const busy = ms => { const end = performance.now() + ms; while (performance.now() < end) { /* reading */ } };
        const out = [];
        for (let value = 10; value <= 60; value += 10) {
            busy(250);
            bar.setAttribute('value', String(value));
            const glides = fill.getAnimations();
            out.push({ value, glides: glides.length, ms: glides.length ? glides[0].effect.getTiming().duration : 0, from: glides.length ? parseFloat(glides[0].effect.getKeyframes()[0].transform.replace('scaleX(', '')) : 0, to: getComputedStyle(fill).getPropertyValue('--progress-x') || bar.style.getPropertyValue('--progress-x') });
        }
        return out;
    });
    for (const s of seen) expect(s.to).toBe(String(s.value / 100));
    // (the first figure has no pace yet; from the second, each glide outlasts the 250ms wait)
    for (const s of seen.slice(1)) {
        expect(s.glides).toBe(1);
        expect(s.ms).toBeGreaterThan(250);
    }
    // Each glide starts where the fill is, never back behind where the one before it started (no jump back)
    seen.slice(1).forEach((s, i) => expect(s.from).toBeGreaterThan(seen[i].from));
    // Every glide keeps pace with the figures (250ms apart), the first included: it never falls behind,
    // so it is not still at half when the last figure comes (James: smooth to 50%, then it just finishes)
    for (const s of seen) expect(s.ms).toBeLessThanOrEqual(500);
    // It settles on the last figure: the fill spans 60% of the track
    await expect.poll(() => page.locator('.dbmn-progress-fill').evaluate(e => Math.round(100 * e.getBoundingClientRect().width / e.parentNode.getBoundingClientRect().width))).toBe(60);
    // A figure going back (a new run) is there at once, no glide
    const back = await page.locator('#bar').evaluate(e => {
        e.setAttribute('value', '5');
        const fill = e.querySelector('.dbmn-progress-fill');
        return { glides: fill.getAnimations().length, width: Math.round(100 * fill.getBoundingClientRect().width / fill.parentNode.getBoundingClientRect().width) };
    });
    expect(back).toEqual({ glides: 0, width: 5 });
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
    await expect(page.locator('#dsOrders .col-sort-btn')).toHaveCount(10);
    // Its search box says what each column is, offers what fits, and says how the search is read
    await page.locator('#dsOrders .search-input').fill('@');
    await expect(page.locator('#dsOrders .column-suggest-option', { hasText: '@placed' }).locator('.column-suggest-label')).toHaveText('date');
    await expect(page.locator('#dsOrders .column-suggest-option', { hasText: '@urgent' }).locator('.column-suggest-label')).toHaveText('yes/no');
    await page.locator('#dsOrders .search-input').fill('@urgent=true @placed>7d');
    await expect(page.locator('#dsOrders .dbmn-table-reads')).toContainText('Reading this as: urgent (yes/no) is yes and placed (date) after ');
    await expect(page.locator('#dsOrders .dbmn-table-count')).toContainText(' of 5,000 rows');
    await page.locator('#dsOrders .search-input').fill('');
    await expect(page.locator('#dsOrders .dbmn-table-reads')).toBeHidden();
    await expect(page.locator('#dsOrders .dbmn-table-count')).toHaveText('5,000 rows');
    expect(await page.locator('#dsOrders .dbmn-table-body tr').count()).toBeLessThan(120);
    // Lists of records open inside their cells, two side by side in one row
    const order = page.locator('#dsNested .dbmn-table-body > tr').nth(1);
    await order.locator('td[data-col="lines"] .dbmn-nest-toggle').click();
    await order.locator('td[data-col="packages"] .dbmn-nest-toggle').click();
    await expect(order.locator('td[data-col="lines"] .dbmn-nest-table tbody tr')).toHaveCount(4);
    await expect(order.locator('td[data-col="packages"] .dbmn-nest-table tbody tr')).toHaveCount(2);
    // The same table over rows that stay with the screen: 100,000 of them, only the first 200 asked for
    await expect(page.locator('#dsPaged .dbmn-table-body tr').first()).toContainText('SO-200000');
    await expect(page.locator('#dsPagedNote')).toHaveText('100,000 rows · asked for 1 page so far');
    // A column of numbers, or of true and false, sorts 0 to 1; text sorts A to Z (told by the values, no type on show)
    expect(await page.locator('#dsPaged thead th .col-sort-icon').evaluateAll(icons => icons.map(i => i.dataset.icon))).toEqual(['arrow-down-a-z', 'arrow-down-a-z', 'arrow-down-0-1', 'arrow-down-0-1', 'arrow-down-a-z']);
    await page.locator('#dsPagedFind').fill('kettle');
    await expect(page.locator('#dsPagedNote')).toContainText('16,666 rows');
    await expect(page.locator('#dsPaged .dbmn-table-body tr').first()).toContainText('Kettle and Co');
    await page.locator('#dsPagedFind').fill('');
    // The log is the component too: its levels as icon and word, the newest line at the top and followed, more on request
    await expect(page.locator('#dsLevels dbmn-level .dbmn-level-word')).toHaveText(['Error', 'Warn', 'Info', 'Debug']);
    await expect(page.locator('#dsLevels dbmn-level svg')).toHaveCount(4);
    await expect(page.locator('#dsLogNote')).toHaveText('60 lines · following the newest');
    await page.locator('#dsLogAdd').click();
    await expect(page.locator('#dsLogNote')).toHaveText('65 lines · following the newest');
    expect(await page.locator('#dsLog .dbmn-table-scroll').evaluate(s => s.scrollTop)).toBeLessThan(30);
    // The list of pieces is the same component: every piece with its state, and searchable
    expect(await page.locator('#dsInventory .dbmn-table-body tr').count()).toBeGreaterThan(20);
    await expect(page.locator('#dsInventory .dbmn-table-body tr').first().locator('.ds-chip')).toHaveText('Component');
    await page.locator('#dsInventory .search-input').fill('@state=planned');
    await expect(page.locator('#dsInventory .dbmn-table-body .ds-chip')).toHaveText(['Planned', 'Planned']);
    await page.locator('#dsInventory .search-input').fill('');
    // Which screen is on which component, in the same table
    await expect(page.locator('#dsMoving .dbmn-table-count')).toHaveText('12 rows');
    await page.locator('#dsMoving .search-input').fill('@screen=query');
    await expect(page.locator('#dsMoving .dbmn-table-body .ds-chip')).toHaveText(['On it', 'On it']);

    // The wizard on show walks to its last step and folds into the summary, and back
    await page.locator('#dsNext').click();
    await expect(page.locator('#dsNext')).toHaveText('Next: Results');
    await page.locator('#dsNext').click();
    await expect(page.locator('#dsSteps .dbmn-steps-summary')).toBeVisible();
    await page.locator('#dsSteps .dbmn-steps-summary').click();
    await page.locator('#dsSteps .dbmn-steps-item').nth(0).click();
    await expect(page.locator('#dsSteps .dbmn-step[data-step="1"]')).toHaveAttribute('aria-current', 'step');

    // A working line in a page: Stop stops it, Again starts it again; too large has no bar
    const working = page.locator('#dsWorkingLine');
    await working.getByRole('button', { name: 'Stop' }).click();
    await expect(working).toHaveAttribute('phase', 'Stopped');
    await working.getByRole('button', { name: 'Compare again' }).click();
    await expect(working).toHaveAttribute('stop', '');
    await page.locator('[data-click="ds:workingLine"][data-arg="refused"]').click();
    await expect(working.locator('.dbmn-progress-fill')).toBeHidden();
    // Figures from the first 1,000 records: marked, then the true ones in the same cells
    const sampled = page.locator('#dsLanesSampled');
    await expect(sampled.locator('.is-sample')).toHaveCount(5);   // the gutter and four runs; the 640-record view has no sample
    await expect(sampled.locator('dbmn-status')).toContainText('The full counts come with Results.');
    await page.locator('#dsLanesAll').click();
    await expect(sampled.locator('.is-sample')).toHaveCount(0);
    await expect(sampled.locator('.dbmn-lanes-gutter').nth(1)).toHaveText('All 418,720 records');
    await page.locator('#dsLanesWarn').click();
    await expect(sampled.locator('dbmn-status')).toHaveAttribute('tone', 'warn');
    if (process.env.DBMN_E2E_SHOTS) {
        for (const width of [1500, 1100, 900]) {
            await page.setViewportSize({ width, height: 900 });
            await page.locator('#dsLanesSample').click();
            await page.locator('[data-click="ds:workingLine"][data-arg="large"]').click();
            await working.scrollIntoViewIfNeeded();
            await page.locator('#footer').screenshot({ path: `${process.env.DBMN_E2E_SHOTS}/gallery-progress-${width}.png` });
            await page.locator('#lanes').screenshot({ path: `${process.env.DBMN_E2E_SHOTS}/gallery-lanes-${width}.png` });
        }
    }

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

test('a status in a page (inline): its tone\'s colour outside any footer, edged in it, no fixed height, and a long sentence wraps', async ({ page }) => {
    await page.setContent(`<!doctype html><html><head>
<style>:root{--vscode-foreground:#cccccc;--vscode-editorWarning-foreground:#cca700;--vscode-testing-iconPassed:#3fa35c}
body{margin:0;padding:16px;font:13px sans-serif;width:400px;background:#1e1e1e;color:#ccc}
${read('shared/atomic.css')}
${read('shared/dbmn-footer.css')}</style>
<script>${read('shared/dbmn-footer.js')}</script></head><body>
<div><dbmn-status id="plain" inline>Nothing to say yet</dbmn-status></div>
<div><dbmn-status id="warn" inline tone="warn">36 values repeat in C3: BL's record is compared with each of them, so Results shows extra rows and differences that are not real.</dbmn-status></div>
</body></html>`);
    const s = await page.evaluate(() => {
        const of = id => getComputedStyle(document.getElementById(id));
        const warn = document.getElementById('warn');
        return {
            plainColour: of('plain').color, warnColour: of('warn').color, border: of('warn').borderTopStyle,
            wraps: of('warn').whiteSpace, tall: warn.getBoundingClientRect().height, margin: of('warn').marginLeft
        };
    });
    expect(s.warnColour).not.toBe(s.plainColour);
    expect(s.border).toBe('solid');
    expect(s.wraps).toBe('normal');
    expect(s.tall).toBeGreaterThan(40);   // two lines or more, not the footer's 32px row
    expect(s.margin).toBe('0px');
});

/** A working line in a page (Query's Results and Join step), at a width. */
const workingPage = (width, attrs) => `<!doctype html><html><head>
<style>:root{--vscode-foreground:#cccccc;--vscode-textLink-foreground:#3794ff;--vscode-errorForeground:#f14c4c;--vscode-editorWarning-foreground:#cca700}
body{margin:0;padding:16px;font:13px sans-serif;width:${width}px;box-sizing:border-box;background:#1e1e1e;color:#ccc}
${read('shared/atomic.css')}
${read('shared/dbmn-footer.css')}</style>
<script>${read('shared/icons.js')}</script><script>${read('shared/dbmn-footer.js')}</script></head><body>
<dbmn-progress inline id="line" ${attrs}></dbmn-progress>
<div id="table" style="height:40px;border:1px solid #444">table</div>
<script>window.heard = []; ['stop', 'again'].forEach(n => document.getElementById('line').addEventListener('dbmn-progress-' + n, () => window.heard.push(n)));</script>
</body></html>`;

test('a working line in a page (inline): Stop and Again are heard, never open the figures, and the bar is still a progressbar inside', async ({ page }) => {
    await page.setContent(workingPage(1100, 'phase="Comparing the records" count="420,000 records" value="29" note="About 40 s left" stop'));
    const line = page.locator('#line');
    await expect(line).toHaveAttribute('role', 'group');
    await expect(line).toHaveAttribute('aria-label', 'Comparing the records');
    await expect(page.locator('.dbmn-progress-track')).toHaveAttribute('role', 'progressbar');
    await expect(page.locator('.dbmn-progress-track')).toHaveAttribute('aria-valuenow', '29');
    await expect(page.locator('.dbmn-progress-count')).toHaveText('420,000 records · About 40 s left');
    await expect(page.locator('.dbmn-progress-act.is-again')).toBeHidden();
    await line.evaluate(e => { e.stats = [{ label: 'Started', value: '23:40' }]; });
    await page.getByRole('button', { name: 'Stop' }).click();
    expect(await page.evaluate(() => window.heard)).toEqual(['stop']);
    await expect(page.locator('.dbmn-progress-stats')).toHaveCount(0);
    // Stopped: the screen says so and offers to start again
    await line.evaluate(e => { e.stats = []; e.removeAttribute('stop'); e.removeAttribute('value'); e.removeAttribute('note'); e.setAttribute('phase', 'Stopped'); e.setAttribute('again', 'Compare again'); });
    await expect(page.locator('.dbmn-progress-act.is-stop')).toBeHidden();
    await page.getByRole('button', { name: 'Compare again' }).click();
    expect(await page.evaluate(() => window.heard)).toEqual(['stop', 'again']);
    // No links: the element is the bar again, as in the footer
    await line.evaluate(e => e.removeAttribute('again'));
    await expect(line).toHaveAttribute('role', 'progressbar');
    await expect(page.locator('.dbmn-progress-track')).not.toHaveAttribute('role', /./);
});

test('a working line with no total yet: it sweeps and counts the seconds itself; a note of its own replaces them', async ({ page }) => {
    await page.setContent(workingPage(1100, `phase="Comparing the records" busy stop since="${Date.now() - 5000}"`));
    const count = page.locator('.dbmn-progress-count');
    await expect(count).toHaveText(/^[56] s$/);
    await expect(count).toHaveText(/^[78] s$/, { timeout: 4000 });
    expect(await page.locator('.dbmn-progress-fill').evaluate(e => getComputedStyle(e).animationName)).toBe('dbmn-progress-sweep');
    await page.locator('#line').evaluate(e => e.setAttribute('note', 'About 30 s left'));
    await expect(count).toHaveText('About 30 s left');
});

test('a working line at 1500, 1100 and 900px and a phone: never wider than its place, the words wrap rather than cut; a refusal has no bar', async ({ page }) => {
    const REFUSED = 'Too large to compare here: 4 views of 2.1 million records would need more memory than this window has. Leave a view out, or search to fewer records.';
    const cases = [
        ['running', 'phase="A large compare: 4 views, 420,000 records" count="120,000 of 420,000 records" value="29" note="About 40 s left" stop tone="warn"'],
        ['refused', `phase="${REFUSED}" tone="error"`]
    ];
    for (const width of [1500, 1100, 900, 380]) {
        for (const [name, attrs] of cases) {
            await page.setContent(workingPage(width, attrs));
            const m = await page.evaluate(() => {
                const line = document.getElementById('line');
                const r = line.getBoundingClientRect();
                const inside = [...line.querySelectorAll('.dbmn-progress-phase, .dbmn-progress-count, .dbmn-progress-act:not([hidden])')]
                    .filter(e => e.getBoundingClientRect().width > 0)
                    .every(e => { const b = e.getBoundingClientRect(); return b.left >= r.left - 0.5 && b.right <= r.right + 0.5; });
                const table = document.getElementById('table').getBoundingClientRect();
                return {
                    width: r.width, room: document.body.clientWidth - 32, height: r.height, inside, below: table.top >= r.bottom,
                    fill: getComputedStyle(line.querySelector('.dbmn-progress-fill')).display,
                    phaseColour: getComputedStyle(line.querySelector('.dbmn-progress-phase')).color, text: getComputedStyle(line).color
                };
            });
            expect(m.width, `${name} at ${width}`).toBeLessThanOrEqual(m.room + 0.5);
            expect(m.inside, `${name} at ${width}: every part inside the line`).toBe(true);
            expect(m.below, `${name} at ${width}: pushes the table down, never over it`).toBe(true);
            expect(m.height).toBeGreaterThanOrEqual(30);
            if (name === 'refused') {
                expect(m.fill).toBe('none');
                expect(m.phaseColour).not.toBe(m.text);
                if (width < 900) expect(m.height, `the refusal wraps at ${width}`).toBeGreaterThan(40);
            } else if (width >= 1100) expect(m.height, `one line at ${width}`).toBeLessThan(40);
            if (process.env.DBMN_E2E_SHOTS) await page.screenshot({ path: `${process.env.DBMN_E2E_SHOTS}/working-line-${name}-${width}.png` });
        }
    }
});

test('the endpoint editor\'s Run API and Run Batch stay on one line, side by side, at a narrow width', async ({ page }) => {
    // James, 2026-11-23 evening test: they wrapped onto two lines beside Save Endpoint and Copy to Share
    const html = `<!doctype html><html><head><style>body{margin:0;padding-top:200px;font:13px sans-serif;width:560px}
.btn{padding:7px 16px;font-size:13px;line-height:18px;min-width:88px}
${read('shared/atomic.css')}${read('shared/core.css')}${read('shared/dbmn-footer.css')}</style>
<script>${read('shared/icons.js')}</script><script>${read('shared/dbmn-footer.js')}</script></head><body>
<dbmn-footer>
  <dbmn-actions class="footer-button-container-overflow">
    <button class="btn" id="copy">Copy to Share</button>
    <button class="btn btn-primary" id="save">Save Endpoint</button>
    <div class="execution-button-group"><button class="btn btn-primary" id="runApi">Run API</button><button class="btn btn-secondary" id="runBatch">Run Batch</button></div>
  </dbmn-actions>
  <dbmn-status>Saved</dbmn-status>
</dbmn-footer></body></html>`;
    await page.setContent(html);
    const api = await page.locator('#runApi').boundingBox();
    const batch = await page.locator('#runBatch').boundingBox();
    // Side by side: one line, Run Batch to the right of Run API
    expect(Math.abs(api.y - batch.y)).toBeLessThan(2);
    expect(batch.x).toBeGreaterThan(api.x + api.width - 1);
    // ...and each label on one line (no button grown to two lines' height)
    expect(api.height).toBeLessThan(40);
    expect(batch.height).toBeLessThan(40);
});

