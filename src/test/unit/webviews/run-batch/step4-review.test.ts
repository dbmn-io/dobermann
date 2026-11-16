// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';
import { planBatch } from '../../../../data-loading/batch-plan';

/**
 * Run Batch Step 4 (GitHub Issue #308), drawn from the batch plan: the real Step 4 markup
 * (from screens/run-batch/run-batch-page.ts) and the real Data Transformer scripts in JSDOM.
 */
const ROOT = path.resolve(__dirname, '../../../../..');
const SHARED = path.join(ROOT, 'src/webviews/shared');
const SCRIPTS = ['json-comment-stripper.js', 'template-rename.js', 'batch-explainer.js', 'request-preview.js', 'dt-data-entry-grid.js',
    'dt-type-coercion.js', 'dt-data-ingestion.js', 'dt-data-preview.js', 'dt-mismatch-repair.js', 'dt-batch-config.js', 'data-transformer.js'];

function step4Markup(): string {
    const source = fs.readFileSync(path.join(ROOT, 'src/screens/run-batch/run-batch-page.ts'), 'utf8');
    return source.slice(source.indexOf('<div id="csvJsonPreviewStep"'), source.indexOf('<!-- Execution Confirmation Section'));
}

function load() {
    const dom = new JSDOM(`<!DOCTYPE html><body>${step4Markup()}</body>`, { runScripts: 'outside-only' });
    const win = dom.window as any;
    const posted: any[] = [];
    const modals: any[] = [];
    win.vscode = { postMessage: (m: unknown) => posted.push(m) };
    win.DbmnModal = { show: (opts: unknown) => { modals.push(opts); return Promise.resolve({}); } };
    for (const file of SCRIPTS) { dom.window.eval(fs.readFileSync(path.join(SHARED, file), 'utf8')); }
    const $ = (id: string) => dom.window.document.getElementById(id) as HTMLElement;
    const shown = (id: string) => !$(id).classList.contains('hidden');
    return { win, dom, $, shown, posted, modals };
}

const map = (h: string[]) => h.map(x => ({ variable: x, column: x, dataType: 'string' }));
const LESSON5 = () => planBatch({
    endpoint: { method: 'POST', path: '/purchase-orders', body: JSON.stringify({ buyerGln: '{{location.gln:string}}', supplierGln: '{{supplier:string}}', lines: [{ gtin: '{{gtin}}' }] }) },
    headers: ['location.gln', 'supplier', 'gtin'], mappings: map(['location.gln', 'supplier', 'gtin']), reps: 1000,
    rows: Array.from({ length: 9 }, (_, i) => ['0614', ['A', 'B', 'C'][i % 3], `g${i}`])
});

describe('Run Batch Step 4 — drawn from the batch plan (#308)', () => {
    it('header + lines: Configure names the grouping columns, a card per request', async () => {
        const { win, $, shown, dom } = load();
        win.CSVHandler.setState({ currentHeaders: ['location.gln', 'supplier', 'gtin'] });
        win.CSVHandler.renderStep4(await LESSON5());
        expect($('totalApiCallsDisplay').textContent).to.equal('3');
        expect($('batchRowsDisplay').textContent).to.equal('9');
        expect($('requestFileSizeDisplay').textContent).to.match(/ B$/);
        // GitHub Issue #354: what starts a new request, with the ⓘ beside it rather than on API calls
        expect(shown('reviewConfigureSection'), 'Configure shows the grouping').to.equal(true);
        expect(shown('groupedByGroup')).to.equal(true);
        expect($('groupedByDisplay').textContent).to.equal('location.gln, supplier');
        expect($('explainRequestsBtn').parentElement?.id).to.equal('groupedByLabel');
        expect(shown('repsControlGroup'), 'nothing to set for header + lines').to.equal(false);
        expect(shown('repeatedArrayGroup')).to.equal(false);
        const cards = dom.window.document.querySelectorAll('#requestPreviewList .raw-card');
        expect(cards).to.have.length(3);
        expect(cards[0].classList.contains('expanded')).to.equal(true);
        expect(cards[1].classList.contains('collapsed')).to.equal(true);
        expect(cards[0].querySelector('.raw-card-title')?.textContent).to.equal('Request #1');
        expect(cards[0].querySelector('.raw-timestamp')?.textContent).to.equal('location.gln 0614 · supplier A');
        expect(cards[0].querySelector('.raw-csv-header')?.textContent).to.include('INPUT (3 rows)');
    });

    it('the heading: "Requests" when all are shown, "Request samples" when there are more', async () => {
        const { win, $ } = load();
        win.CSVHandler.setState({ currentHeaders: ['location.gln', 'supplier', 'gtin'] });
        win.CSVHandler.renderStep4(await LESSON5());
        expect($('requestPreviewTitle').textContent).to.equal('Requests');
        win.CSVHandler.renderStep4(await planBatch({
            endpoint: { method: 'POST', path: '/x', body: '{"v":"{{v}}"}' }, headers: ['v'], mappings: map(['v']), reps: 1,
            rows: Array.from({ length: 12 }, (_, i) => [String(i)])
        }));
        expect($('requestPreviewTitle').textContent).to.equal('Request samples');
    });

    it('Show Input / Request hides those parts of every card, as the Raw tab does', async () => {
        const { win, $, dom } = load();
        win.CSVHandler.setState({ currentHeaders: ['location.gln', 'supplier', 'gtin'] });
        win.CSVHandler.renderStep4(await LESSON5());
        const input = $('requestPreviewShow').querySelector('[data-show="input"]') as HTMLElement;
        input.click();
        expect(input.getAttribute('aria-pressed')).to.equal('false');
        const wrappers = [...dom.window.document.querySelectorAll('#requestPreviewList .raw-csv-data-wrapper')];
        expect(wrappers.length).to.equal(3);
        expect(wrappers.every(w => w.classList.contains('raw-section-hidden'))).to.equal(true);
        // Kept when the preview is rebuilt (Refresh)
        win.CSVHandler.renderStep4(await LESSON5());
        expect([...dom.window.document.querySelectorAll('#requestPreviewList .raw-csv-data-wrapper')].every(w => w.classList.contains('raw-section-hidden'))).to.equal(true);
        ($('requestPreviewShow').querySelector('[data-show="request"]') as HTMLElement).click();
        expect(dom.window.document.querySelector('#requestPreviewList .raw-panes-wrapper')?.classList.contains('raw-section-hidden')).to.equal(true);
    });

    it('a card opens and closes; Body ↔ Details switches what its editor shows', async () => {
        const { win, dom } = load();
        win.CSVHandler.setState({ currentHeaders: ['location.gln', 'supplier', 'gtin'] });
        win.CSVHandler.renderStep4(await LESSON5());
        const second = dom.window.document.querySelectorAll('#requestPreviewList .raw-card')[1] as HTMLElement;
        (second.querySelector('[data-action="toggle"]') as HTMLElement).click();
        expect(second.classList.contains('expanded')).to.equal(true);
        expect(second.querySelector('.raw-monaco-container pre')?.textContent).to.include('"supplierGln": "B"');
        (second.querySelector('[data-mode="details"]') as HTMLElement).click();
        expect(second.querySelector('.raw-monaco-container pre')?.textContent).to.include('// ENDPOINT\nPOST /purchase-orders');
    });

    it('a request goes full window and back, with its button or Esc (#352)', async () => {
        const { win, dom } = load();
        win.CSVHandler.setState({ currentHeaders: ['location.gln', 'supplier', 'gtin'] });
        win.CSVHandler.renderStep4(await LESSON5());
        const doc = dom.window.document;
        const pane = doc.querySelector('#requestPreviewList .raw-card .raw-request-pane') as HTMLElement;
        const btn = pane.querySelector('[data-action="fullscreen"]') as HTMLElement;
        btn.click();
        expect(pane.classList.contains('raw-pane-fullscreen')).to.equal(true);
        expect(doc.body.classList.contains('is-editor-fullscreen')).to.equal(true);
        expect(btn.getAttribute('aria-pressed')).to.equal('true');
        doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
        expect(pane.classList.contains('raw-pane-fullscreen')).to.equal(false);
        expect(doc.body.classList.contains('is-editor-fullscreen')).to.equal(false);
        btn.click();
        btn.click();
        expect(pane.classList.contains('raw-pane-fullscreen')).to.equal(false);
    });

    it('flat array: Configure shows Rows per request; changing Reps rebuilds the samples by itself, debounced', async () => {
        const { win, $, shown, posted, dom } = load();
        const plan = await planBatch({
            endpoint: { method: 'POST', path: '/inventory', body: '[{"gtin":"{{gtin}}"}]' }, headers: ['gtin'], mappings: map(['gtin']),
            reps: 10, rows: Array.from({ length: 25 }, (_, i) => [`g${i}`])
        });
        win.CSVHandler.setState({ currentHeaders: ['gtin'] });
        win.CSVHandler.renderStep4(plan);
        expect(shown('reviewConfigureSection')).to.equal(true);
        expect(shown('repsControlGroup')).to.equal(true);
        expect(shown('arraySelectGroup'), 'one array: nothing to choose').to.equal(false);
        expect($('repsLabel').textContent).to.equal('Rows per request');
        expect(($('elementsInput') as HTMLInputElement).value).to.equal('10');
        expect(dom.window.document.querySelector('#generatePreviewBtn'), 'no Refresh button any more').to.equal(null);
        win.CSVHandler.setState({ endpointId: 'ep1', rawCSVContent: 'gtin\n' + plan.requests.map((_, i) => `g${i}`).join('\n') });
        const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
        const list = $('requestPreviewList');

        // Typing: nothing until typing stops, then one rebuild with the final value
        win.CSVHandler.onElementsInputChange('2');
        win.CSVHandler.onElementsInputChange('20');
        expect(list.classList.contains('is-rebuilding'), 'still typing').to.equal(false);
        await wait(500);
        expect(list.classList.contains('is-rebuilding')).to.equal(true);
        expect(list.querySelector('.request-preview-rebuilding')?.textContent).to.equal('Rebuilding for 20 rows per request…');
        expect(list.querySelectorAll('.raw-card').length, 'the old cards stay while it rebuilds').to.be.greaterThan(0);
        expect(posted.filter(m => m.type === 'generateBulkJson' || m.type === 'generateJsonPreview')).to.have.length(1);

        // Back to what the samples were built with: no rebuild
        const before = posted.length;
        win.CSVHandler.renderStep4(plan);
        expect(list.classList.contains('is-rebuilding'), 'the new plan clears the strip').to.equal(false);
        win.CSVHandler.onElementsInputChange('20');
        win.CSVHandler.onElementsInputChange('10');
        await wait(500);
        expect(posted.length, 'no rebuild for an unchanged setting').to.equal(before);
    });

    it('#354: a wrapped array is named beside Rows per request, at any Rows per request; the ⓘ stays on API calls', async () => {
        const { win, $, shown } = load();
        const plan = (reps: number) => planBatch({
            endpoint: { method: 'POST', path: '/pix', body: JSON.stringify({ Payload: { ExportDocuments: [{ ItemId: '{{ItemId}}' }] } }) },
            headers: ['ItemId'], mappings: map(['ItemId']), reps, rows: Array.from({ length: 7 }, (_, i) => [`i${i}`])
        });
        win.CSVHandler.setState({ currentHeaders: ['ItemId'] });
        win.CSVHandler.renderStep4(await plan(1));
        expect(shown('repsControlGroup')).to.equal(true);
        // Shown from the start, not only once rows are packed: it popping in at 2 was jarring
        expect(shown('repeatedArrayGroup'), 'one row per request: the array is still named').to.equal(true);
        expect($('repeatedArrayDisplay').textContent).to.equal('Payload.ExportDocuments');
        expect(shown('groupedByGroup')).to.equal(false);
        expect($('explainRequestsBtn').parentElement?.id).to.equal('apiCallsLabel');
        win.CSVHandler.renderStep4(await plan(7));
        expect(shown('repeatedArrayGroup')).to.equal(true);
        expect($('repeatedArrayDisplay').textContent).to.equal('Payload.ExportDocuments');
        expect($('repeatedArrayGroup').nextElementSibling?.id, 'to the left of the settings').to.equal('arraySelectGroup');
    });

    it('a grouped template moves the ⓘ to Grouped by; a flat one brings it back to API calls', async () => {
        const { win, $ } = load();
        win.CSVHandler.setState({ currentHeaders: ['location.gln', 'supplier', 'gtin'] });
        win.CSVHandler.renderStep4(await LESSON5());
        expect($('explainRequestsBtn').parentElement?.id).to.equal('groupedByLabel');
        win.CSVHandler.renderStep4(await planBatch({ endpoint: { method: 'POST', path: '/x', body: '{"v":"{{v}}"}' },
            headers: ['v'], mappings: map(['v']), reps: 1, rows: [['a']] }));
        expect($('explainRequestsBtn').parentElement?.id).to.equal('apiCallsLabel');
    });

    it('URL parameters only: Values per URL in Configure, and requests show their Details — no body', async () => {
        const { win, shown, dom } = load();
        const plan = await planBatch({
            endpoint: { method: 'GET', path: '/items', body: '', queryParams: { query: 'id={{item}}[ or ]' } },
            headers: ['item'], rows: [['A'], ['B'], ['C']], mappings: map(['item']), reps: 1,
            queryParamRepetition: { enabled: true, paramKey: 'query', pattern: 'id={{item}}', separator: ' or ', maxUrlLength: 2048, maxPerRequest: 2 }
        });
        win.CSVHandler.setState({ currentHeaders: ['item'] });
        win.CSVHandler.renderStep4(plan);
        expect(shown('queryItemsGroup')).to.equal(true);
        expect(shown('repsControlGroup')).to.equal(false);
        const first = dom.window.document.querySelector('#requestPreviewList .raw-card') as HTMLElement;
        expect(first.querySelector('[data-mode="body"]'), 'no Body/Details toggle without a body').to.equal(null);
        expect(first.querySelector('.raw-monaco-container pre')?.textContent).to.include('GET /items?query=id=A or id=B');
    });

    it('two levels, Reps 1: Execute saves the setting, so it sends one order per request as shown', async () => {
        const { win, posted } = load();
        const plan = await planBatch({
            endpoint: { method: 'POST', path: '/orders', body: JSON.stringify({ orders: [{ orderId: '{{orderId}}', items: [{ sku: '{{sku}}' }] }] }) },
            headers: ['orderId', 'sku'], mappings: map(['orderId', 'sku']), reps: 1, rows: [['o1', 'a'], ['o2', 'b'], ['o3', 'c']]
        });
        expect(plan.totals.requests, 'one order per request').to.equal(3);
        win.CSVHandler.setState({ currentHeaders: ['orderId', 'sku'], endpointId: 'ep-1', endpointConfig: { id: 'ep-1', dataLoadingConfig: { repeatableArrays: [] } } });
        win.CSVHandler.renderStep4(plan);
        win.CSVHandler.updateEndpointConfiguration();
        const saved = posted.filter(m => m.type === 'saveEndpoint').pop();
        expect(saved.endpoint.dataLoadingConfig.repeatableArrays).to.deep.equal([{ arrayPath: 'orders', enabled: true, maxRepetitions: 1 }]);
    });

    it('ⓘ on API calls opens "How your rows become API requests"', async () => {
        const { win, modals } = load();
        win.CSVHandler.setState({ currentHeaders: ['location.gln', 'supplier', 'gtin'] });
        win.CSVHandler.renderStep4(await LESSON5());
        win.CSVHandler.explainRequests();
        expect(modals).to.have.length(1);
        expect(modals[0].title).to.equal('How your rows become API requests');
        expect(modals[0].body.innerHTML).to.include('Grouped by the header');
        expect(modals[0].size).to.equal('lg');
        expect(modals[0].actions, 'the standard footer, with Close').to.deep.equal([{ id: 'close', label: 'Close', variant: 'primary' }]);
    });
});
