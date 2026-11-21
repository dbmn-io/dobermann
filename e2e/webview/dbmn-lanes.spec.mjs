/**
 * The lanes grid (src/webviews/shared/dbmn-lanes.css + dbmn-lanes.js) in a real browser from the
 * real files: every line on the same tracks, so a slot sits over its lane and each run's cells
 * under its chip (within 3px) at 1100 and 1500px; both ways of heading a view's runs share the
 * tracks; narrower than the views need, the container scrolls sideways as one; no text leaves
 * its cell.
 *
 *   npm run test:e2e:webview      (no backend needed)
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = rel => readFileSync(join(ROOT, 'src/webviews', rel), 'utf8');

const LONG = 'a very long column name that would spill out of a narrow cell if it were let';
const page = mode => `<!doctype html><html><head>
<style>:root{--vscode-foreground:#ccc;--vscode-editor-background:#1e1e1e;--vscode-panel-border:#444;--vscode-focusBorder:#4daafc;--vscode-descriptionForeground:#999;
--vscode-charts-blue:#3794ff;--vscode-charts-green:#89d185;--vscode-charts-purple:#b180d7;--vscode-charts-orange:#d18616;--vscode-charts-yellow:#cca700;--vscode-charts-red:#f14c4c}
${read('shared/atomic.css')}\n${read('shared/dbmn-lanes.css')}
body{margin:0;padding:16px;background:#1e1e1e;color:#ccc;font:13px sans-serif}</style>
<script>${read('shared/dbmn-lanes.js')}</script></head><body>
<div class="dbmn-lanes" id="step">
  <div class="dbmn-lanes-row" id="slots">
    <div class="dbmn-lanes-gutter is-name">Stock check</div>
    ${mode === 'head'
        ? `<div class="dbmn-lane dbmn-view-0 dbmn-runs-4"><div class="dbmn-lane-head">inventory · GET /inventory</div>${[0, 1, 2, 3].map(i => `<div class="dbmn-lane-run dbmn-run-${i} slot">C${i}</div>`).join('')}</div>`
        : `<div class="dbmn-lane dbmn-view-0 dbmn-runs-4">${[0, 1, 2, 3].map(i => `<div class="dbmn-lane-run dbmn-run-${i} slot">C${i} inventory</div>`).join('')}</div>`}
    <div class="dbmn-lane dbmn-view-1 dbmn-runs-1"><div class="dbmn-lane-run dbmn-run-0 slot">counts</div></div>
    <div class="dbmn-lane dbmn-view-2 dbmn-runs-1"><div class="dbmn-lane-run dbmn-run-0 slot">Prices.csv</div></div>
    <div class="dbmn-lanes-end">+ Add</div>
  </div>
  <div class="dbmn-lanes-row" id="key">
    <div class="dbmn-lanes-gutter">${LONG}</div>
    <div class="dbmn-lane dbmn-view-0 dbmn-runs-4 dbmn-cells">${[0, 1, 2, 3].map(i => `<button class="dbmn-cell dbmn-run-${i}"><span class="dbmn-cell-value">${i ? 'gtin, the same' : LONG}</span><span class="dbmn-cell-fx">ƒ</span></button>`).join('')}</div>
    <div class="dbmn-lane dbmn-view-1 dbmn-runs-1 dbmn-cells"><button class="dbmn-cell dbmn-run-0"><span class="dbmn-cell-value">item_code</span></button></div>
    <div class="dbmn-lane dbmn-view-2 dbmn-runs-1 dbmn-cells"><div class="dbmn-cell is-empty">Not compared</div></div>
    <div class="dbmn-lanes-end">+ AND ×</div>
  </div>
  <div class="dbmn-lanes-row" id="sum">
    <div class="dbmn-lanes-gutter">After this join</div><div class="dbmn-lanes-span">4 of 4 in the compare</div><div class="dbmn-lanes-end"></div>
  </div>
</div>
<script>DbmnLanes.apply(document.getElementById('step'), [{ runs: 4 }, { runs: 1 }, { runs: 1 }]);</script>
</body></html>`;

/** Left and right edges of each run's slot, and of each run's cell on the key line. */
const edges = p => p.evaluate(() => {
    const box = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; };
    return {
        slots: [...document.querySelectorAll('#slots .slot')].map(box),
        cells: [...document.querySelectorAll('#key .dbmn-cell')].map(box),
        lanes: [...document.querySelectorAll('#slots .dbmn-lane')].map(box),
        keyLanes: [...document.querySelectorAll('#key .dbmn-lane')].map(box),
        gutters: [...document.querySelectorAll('.dbmn-lanes-gutter')].map(box),
        ends: [...document.querySelectorAll('.dbmn-lanes-end')].map(box)
    };
});
const near = (a, b) => a.forEach((edge, i) => { expect(Math.abs(edge[0] - b[i][0])).toBeLessThanOrEqual(3); expect(Math.abs(edge[1] - b[i][1])).toBeLessThanOrEqual(3); });

for (const mode of ['head', 'slots']) {
    for (const width of [1100, 1500]) {
        test(`${mode === 'head' ? 'one heading over the runs' : 'a slot per run'} at ${width}px: every slot over its cells, every lane over its lane, gutters and ends in line`, async ({ page: p }) => {
            await p.setViewportSize({ width, height: 600 });
            await p.setContent(page(mode));
            const e = await edges(p);
            expect(e.slots).toHaveLength(6);
            expect(e.cells).toHaveLength(6);
            near(e.slots, e.cells);
            near(e.lanes, e.keyLanes);
            e.gutters.forEach(g => near([g], [e.gutters[0]]));
            e.ends.forEach(g => near([g], [e.ends[0]]));
            // Four runs take four times a single run's room
            const one = e.lanes[1][1] - e.lanes[1][0];
            expect(Math.abs((e.lanes[0][1] - e.lanes[0][0]) - 4 * one)).toBeLessThanOrEqual(3);
            // Sideways scrolling only when the views need more room than there is (1,104px here)
            const room = await p.evaluate(() => { const s = document.getElementById('step'); return { over: s.scrollWidth - s.clientWidth, client: s.clientWidth }; });
            if (room.client >= 1104) expect(room.over).toBeLessThanOrEqual(1);
            else expect(room.over).toBeGreaterThan(0);
        });
    }
}

test('narrower than the views need: the step scrolls sideways as one, the lines still in line', async ({ page: p }) => {
    await p.setViewportSize({ width: 800, height: 600 });
    await p.setContent(page('head'));
    const need = await p.evaluate(() => DbmnLanes.minWidth([{ runs: 4 }, { runs: 1 }, { runs: 1 }]));
    expect(need).toBe(230 + 6 * 120 + 130 + 4 * 6);
    const step = await p.evaluate(() => { const s = document.getElementById('step'); return { scroll: s.scrollWidth, client: s.clientWidth }; });
    expect(step.scroll).toBeGreaterThan(step.client);
    const e = await edges(p);
    near(e.slots, e.cells);
    // Each run keeps its 120px
    e.cells.forEach(([l, r]) => expect(r - l).toBeGreaterThanOrEqual(118));
});

test('no text leaves its cell: a long name ends in an ellipsis inside the gutter and the cell, and says it whole on hover', async ({ page: p }) => {
    await p.setViewportSize({ width: 1100, height: 600 });
    await p.setContent(page('head'));
    const spill = await p.evaluate(() => [...document.querySelectorAll('.dbmn-lanes-gutter, .dbmn-cell-value, .dbmn-lane-head, .dbmn-lane-run')].map(el => {
        const box = el.getBoundingClientRect();
        const holder = (el.closest('.dbmn-cell') || el.parentElement).getBoundingClientRect();
        return { right: Math.round(box.right - holder.right), ellipsis: getComputedStyle(el).textOverflow };
    }));
    spill.forEach(s => { expect(s.right).toBeLessThanOrEqual(0); expect(s.ellipsis).toBe('ellipsis'); });
});

test('colours from the theme: a view\'s lane and its runs; the first run wears the view\'s colour', async ({ page: p }) => {
    await p.setContent(page('head'));
    const c = await p.evaluate(() => {
        const v = sel => getComputedStyle(document.querySelector(sel));
        return {
            view0: v('#key .dbmn-view-0').getPropertyValue('--lanes-view-c').trim(),
            run0: v('#key .dbmn-run-0').getPropertyValue('--lanes-run-c').trim(),
            run1: v('#key .dbmn-view-0 .dbmn-run-1').getPropertyValue('--lanes-run-c').trim(),
            view1run0: v('#key .dbmn-view-1 .dbmn-run-0').getPropertyValue('--lanes-run-c').trim()
        };
    });
    expect(c.run0).toBe(c.view0);
    expect(c.run1).not.toBe(c.view0);
    expect(c.view1run0).not.toBe(c.view0);
});

test('working (is-pending): quiet text and a turning ring at the edge; nothing moves when the value comes', async ({ page: p }) => {
    await p.setViewportSize({ width: 1500, height: 600 });
    await p.setContent(page('head'));
    const box = () => p.evaluate(() => { const r = document.querySelector('#key .dbmn-cell').getBoundingClientRect(); const s = document.querySelector('#sum .dbmn-lanes-span').getBoundingClientRect(); return [r.left, r.width, r.height, s.height].map(Math.round); });
    const before = await box();
    await p.evaluate(() => { document.querySelector('#key .dbmn-cell').classList.add('is-pending'); document.querySelector('#sum .dbmn-lanes-span').classList.add('is-pending'); });
    const ring = await p.evaluate(() => getComputedStyle(document.querySelector('#key .dbmn-cell'), '::after').animationName);
    expect(ring).toBe('dbmn-lanes-spin');
    expect(await box()).toEqual(before);
    await p.evaluate(() => document.querySelectorAll('.is-pending').forEach(e => e.classList.remove('is-pending')));
    expect(await box()).toEqual(before);
});

test('together: a slot row in its own container and a step\'s lines scroll sideways as one; the header has no bar of its own', async ({ page: p }) => {
    await p.setViewportSize({ width: 800, height: 600 });
    await p.setContent(page('head'));
    await p.evaluate(() => {
        const step = document.getElementById('step');
        const top = document.createElement('div');
        top.className = 'dbmn-lanes';
        top.id = 'top';
        top.append(document.getElementById('slots'));
        step.before(top);
        const views = [{ runs: 4 }, { runs: 1 }, { runs: 1 }];
        DbmnLanes.apply(top, views);
        DbmnLanes.together([top, step]);
    });
    expect(await p.evaluate(() => document.getElementById('top').classList.contains('is-following'))).toBe(true);
    await p.evaluate(() => { document.getElementById('step').scrollLeft = 200; });
    await expect.poll(() => p.evaluate(() => document.getElementById('top').scrollLeft)).toBe(200);
    // Still in line, scrolled
    const e = await edges(p);
    near(e.slots, e.cells);
});

test('--lanes-c: an element\'s own colour, the run\'s on a run, else its view\'s', async ({ page: p }) => {
    await p.setContent(page('head'));
    const c = await p.evaluate(() => {
        const v = sel => getComputedStyle(document.querySelector(sel)).getPropertyValue('--lanes-c').trim();
        return { lane: v('#key .dbmn-view-1'), run1: v('#key .dbmn-view-0 .dbmn-run-1'), laneOwn: getComputedStyle(document.querySelector('#key .dbmn-view-1')).getPropertyValue('--lanes-view-c').trim() };
    });
    expect(c.lane).toBe(c.laneOwn);
    expect(c.run1).not.toBe(c.lane);
});

test('.is-sample: a figure from the first records is quiet and dotted under; the true figure takes its place without anything moving', async ({ page: p }) => {
    await p.setContent(page('head'));
    await p.evaluate(() => {
        const row = document.createElement('div');
        row.className = 'dbmn-lanes-row';
        row.id = 'found';
        row.innerHTML = '<div class="dbmn-lanes-gutter is-sample">In the first 1,000 records</div>'
            + '<div class="dbmn-lane dbmn-view-0 dbmn-runs-4">' + [1000, 990, 998, 997].map((n, i) => `<div class="dbmn-lane-run dbmn-run-${i} is-sample">${n.toLocaleString()}</div>`).join('') + '</div>'
            + '<div class="dbmn-lane dbmn-view-1 dbmn-runs-1"><div class="dbmn-lane-run dbmn-run-0" id="whole">640</div></div>'
            + '<div class="dbmn-lane dbmn-view-2 dbmn-runs-1"></div><div class="dbmn-lanes-end"></div>';
        document.getElementById('step').append(row);
    });
    const look = () => p.evaluate(() => {
        const s = el => getComputedStyle(el);
        const run = document.querySelector('#found .dbmn-run-1');
        return {
            colour: s(run).color, line: s(run).textDecorationStyle, whole: s(document.getElementById('whole')).color,
            gutterLine: s(document.querySelector('#found .dbmn-lanes-gutter')).textDecorationStyle,
            boxes: [...document.querySelectorAll('#found .dbmn-lane-run, #found .dbmn-lanes-gutter')].map(e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round).join(','); })
        };
    });
    const sample = await look();
    expect(sample.line).toBe('dotted');
    expect(sample.gutterLine).toBe('dotted');
    expect(sample.colour, 'quiet: not the colour of a figure of all the records').not.toBe(sample.whole);
    // Results has counted them all: the true figures, same cells
    await p.evaluate(() => {
        document.querySelectorAll('#found .is-sample').forEach(e => e.classList.remove('is-sample'));
        document.querySelector('#found .dbmn-lanes-gutter').textContent = 'All 418,720 records';
        ['418,720', '412,904', '418,200', '418,100'].forEach((t, i) => { document.querySelector(`#found .dbmn-run-${i}`).textContent = t; });
    });
    const all = await look();
    expect(all.line).not.toBe('dotted');
    expect(all.colour).toBe(all.whole);
    expect(all.boxes, 'nothing moves').toEqual(sample.boxes);
});
