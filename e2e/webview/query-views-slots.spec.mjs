/**
 * Query's slots row with no views and with one: Add a view and Add a file as two half-size buttons side by side
 * in the next empty slot, the slots still to come after them, and the slide when they move on (James,
 * 2026-11-23: "Create these two buttons where the first file is going to go… Animate them moving across").
 * The real shared styles (dbmn-lanes.css, query.css) and DbmnLanes; the row as query-page.js draws it.
 *
 *   npm run test:e2e:webview      (no backend needed)
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = rel => readFileSync(join(ROOT, 'src/webviews', rel), 'utf8');

const SLOT = 200, GAP = 8;
const adds = `<span id="queryAdds" class="query-adds">
  <button type="button" id="queryAddBtn"><span class="inline-icon" data-icon="sheet"></span><span class="query-adds-label">Add a view</span></button>
  <button type="button" id="queryAddFileBtn"><span class="inline-icon" data-icon="file-spreadsheet"></span><span class="query-adds-label">Add a file</span></button>
</span>`;
const empties = n => Array.from({ length: n }, () => '<div class="query-slot-empty"><span>then the next</span></div>').join('');
const page = views => `<!doctype html><html><head>
<style>${read('shared/atomic.css')}${read('shared/dbmn-lanes.css')}${read('shared/query.css')} body{margin:0;padding:16px;width:1100px;font:13px sans-serif}
.slot{height:41px;border:1px solid #888;border-radius:3px}</style>
<script>${read('shared/icons.js')}</script><script>${read('shared/dbmn-lanes.js')}</script></head><body class="query-page">
<div id="queryTop" class="dbmn-lanes query-top">
  <div id="queryViews" class="dbmn-lanes-row query-slots">
    <span class="dbmn-lanes-gutter query-lead">Name</span>
    ${Array.from({ length: views }, (_, i) => `<div class="dbmn-lane dbmn-view-${i} dbmn-runs-1"><div class="dbmn-lane-run"><div class="slot">View ${i + 1}</div></div></div>`).join('')}
    <div class="dbmn-lanes-end" data-adds="slots">${adds}${empties(Math.max(0, 2 - views))}</div>
  </div>
</div>
<script>
  // (as query-page.js applyLanes: the end cell holds the pair and the places still to come)
  const places = 1 + Math.max(0, 2 - ${views});
  DbmnLanes.apply(document.getElementById('queryTop'), Array.from({ length: ${views} }, () => ({ runs: 1 })), { gutter: 180, end: 6 + places * ${SLOT} + (places - 1) * ${GAP} });
  Icons.injectIcons(document.body);
</script></body></html>`;

const box = (p, sel) => p.locator(sel).boundingBox();

test('no views: the pair is two half-size buttons side by side, one slot wide, then two slots still to come', async ({ page: p }) => {
    await p.setContent(page(0));
    const view = await box(p, '#queryAddBtn'), file = await box(p, '#queryAddFileBtn'), pair = await box(p, '#queryAdds');
    // Side by side, Add a view on the left, the same size
    expect(Math.abs(view.y - file.y)).toBeLessThan(1);
    expect(file.x).toBeGreaterThan(view.x + view.width - 1);
    expect(Math.abs(view.width - file.width)).toBeLessThan(1);
    // The pair: one slot wide and a slot high
    expect(Math.round(pair.width)).toBe(SLOT);
    expect(Math.round(pair.height)).toBe(41);
    // Each with its icon and its label on one line
    await expect(p.locator('#queryAddBtn svg')).toHaveCount(1);
    await expect(p.locator('#queryAddFileBtn svg')).toHaveCount(1);
    for (const id of ['#queryAddBtn', '#queryAddFileBtn']) {
        const label = await box(p, `${id} .query-adds-label`);
        expect(label.height).toBeLessThan(20);
    }
    // Two places still to come, the same size, after the pair on its line
    const places = p.locator('.query-slot-empty');
    await expect(places).toHaveCount(2);
    for (let i = 0; i < 2; i++) {
        const b = await places.nth(i).boundingBox();
        expect(Math.round(b.width)).toBe(SLOT);
        expect(Math.round(b.height)).toBe(41);
        expect(Math.abs(b.y - pair.y)).toBeLessThan(1);
    }
    // Nothing spills out of the row
    const row = await box(p, '#queryViews');
    const last = await places.nth(1).boundingBox();
    expect(last.x + last.width).toBeLessThanOrEqual(row.x + row.width + 1);
});

test('one view: the pair keeps its shape in the next slot; with two, the pair alone', async ({ page: p }) => {
    await p.setContent(page(1));
    const pair = await box(p, '#queryAdds');
    expect(Math.round(pair.width)).toBe(SLOT);
    expect(Math.round(pair.height)).toBe(41);
    const slot = await box(p, '.dbmn-lane .slot');
    expect(pair.x).toBeGreaterThan(slot.x + slot.width);
    await expect(p.locator('.query-slot-empty')).toHaveCount(1);
    await p.setContent(page(2));
    await expect(p.locator('.query-slot-empty')).toHaveCount(0);
    expect(Math.round((await box(p, '#queryAdds')).width)).toBe(SLOT);
});

test('moved on to the next slot, the pair slides there from where it was', async ({ page: p }) => {
    await p.setContent(page(0));
    const moved = await p.evaluate(() => {
        const adds = document.getElementById('queryAdds');
        const was = adds.getBoundingClientRect();
        // (a view added: its lane before the end cell)
        const lane = document.createElement('div');
        lane.className = 'dbmn-lane dbmn-view-0 dbmn-runs-1';
        lane.innerHTML = '<div class="dbmn-lane-run"><div class="slot">View 1</div></div>';
        document.querySelector('#queryViews .dbmn-lanes-end').before(lane);
        DbmnLanes.apply(document.getElementById('queryTop'), [{ runs: 1 }], { gutter: 180, end: 6 + 2 * 200 + 8 });
        DbmnLanes.glide(adds, was);
        const running = adds.getAnimations();
        return { animations: running.length, from: running.length ? String(running[0].effect.getKeyframes()[0].transform) : '' };
    });
    expect(moved.animations).toBe(1);
    expect(moved.from).toMatch(/^translate\(-\d/);
});
