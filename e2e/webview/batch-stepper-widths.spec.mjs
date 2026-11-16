/**
 * The step bar (Run Batch and Compare), in a real browser with the real stylesheet: one small,
 * centred look at every width, and as steps tick off and their summaries change ("Waits for
 * Map" becoming "8 of 8 mapped"), no step moves or resizes (#397).
 *
 *   npm run test:e2e:webview      (no backend needed — the files are read from src/)
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const css = readFileSync(join(ROOT, 'src/webviews/shared/data-transformer.css'), 'utf8');

const LABELS = ['Source', 'Map', 'Validate', 'Review'];
/** The markup batch-stepper.js renders, with the given summaries. */
function bar(summaries, current) {
    const steps = LABELS.map((label, i) => `
        <button type="button" class="batch-step is-${i + 1 < current ? 'done' : i + 1 === current ? 'current' : 'pending'}" data-step="${i + 1}">
            <span class="batch-step-circle"><span class="batch-step-num">${i + 1}</span></span>
            <span class="batch-step-text"><span class="batch-step-label">${label}</span><span class="batch-step-summary">${summaries[i]}</span></span>
        </button>`);
    return `<nav class="batch-stepper" id="batchStepper"><span class="batch-stepper-row">${steps.join('<span class="batch-step-line"></span>')}</span></nav>`;
}
const page = summaries => `<!doctype html><html><head><style>body{margin:0;font:13px sans-serif;width:1400px}${css}</style></head><body>${bar(summaries, 2)}</body></html>`;

const SUMMARIES = [['inventory-errors.csv · 1,000 rows', 'Waits for Source', 'Waits for Map', ''], ['inventory-errors.csv · 1,000 rows', '8 of 8 mapped', '1,000 rows valid', '1,000 API calls']];

// One look at every width: each step's name over its circle, small, and no line of text under it
// (the user, 2026-11-13: "keep it like this"; it had turned into a wide layout with summaries
// whenever the footer was wider than 720px). What a step is doing shows on the screen itself.
for (const width of [500, 900, 1400, 2400]) {
    test(`${width}px: names over the circles, no summary line, nothing moves as summaries change`, async ({ page: p }) => {
        await p.setViewportSize({ width, height: 200 });
        const boxes = async () => p.locator('.batch-step').evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.width)]; }));
        const pageAt = summaries => page(summaries).replace('width:1400px', `width:${width}px`);

        await p.setContent(pageAt(SUMMARIES[0]));
        const before = await boxes();
        for (const s of await p.locator('.batch-step-summary').all()) await expect(s).toBeHidden();
        const step = p.locator('.batch-step').nth(1);
        const label = await step.locator('.batch-step-label').boundingBox();
        const circle = await step.locator('.batch-step-circle').boundingBox();
        expect(label.y + label.height, 'the name sits above its circle').toBeLessThanOrEqual(circle.y + 1);
        expect(Math.abs((label.x + label.width / 2) - (circle.x + circle.width / 2)), 'centred over it').toBeLessThanOrEqual(1);
        expect(await step.locator('.batch-step-label').evaluate(el => getComputedStyle(el).fontSize)).toBe('11px');

        await p.setContent(pageAt(SUMMARIES[1]));
        expect(await boxes()).toEqual(before);
    });
}
