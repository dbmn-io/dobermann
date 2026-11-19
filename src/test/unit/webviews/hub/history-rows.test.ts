// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * History (transactions.js) with thousands of runs: a search or Show all reaches every run, but
 * the list draws the first rows and the next as it is scrolled to; and while a batch runs (the
 * Hub's state several times a second) it is drawn again only when what it shows has changed.
 */
import { expect } from 'chai';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../../../..');

function history(total: number, newest = 500) {
    const dom = new JSDOM(`<!DOCTYPE html><body>
        <section class="hub-section" data-section="transactions">
            <input id="transactionsSearch"><div id="transactionsSummary"></div>
            <div class="catalogue-list" id="transactionsList"></div><div id="transactionsEmpty" hidden></div>
        </section></body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window as unknown as Window & { eval(code: string): unknown; Transactions: { init(h: unknown): void; update(s: unknown): void; onHistoryAll(m: unknown): void } };
    for (const file of ['shared/icons.js', 'shared/search-words.js', 'hub/transactions.js']) w.eval(fs.readFileSync(path.join(ROOT, 'src/webviews', file), 'utf8'));
    const runs = Array.from({ length: total }, (_, i) => ({ id: `run-${i}`, executionType: 'individual', status: 'completed', endpointName: `Endpoint ${i}`, endpointMethod: 'GET', endpointPath: '/items', environment: 'Test', createdAt: new Date(Date.UTC(2026, 10, 19) - i * 60_000).toISOString() }));
    let state: Record<string, unknown> = { transactions: runs.slice(0, newest), transactionsTotal: total, endpoints: [], environments: [], systems: [] };
    const posted: Array<Record<string, unknown>> = [];
    w.Transactions.init({ getState: () => state, postMessage: (m: Record<string, unknown>) => posted.push(m), getInitialSettings: () => ({ transactionsGroupBy: 'none', transactionsQuery: '' }) });
    const list = dom.window.document.getElementById('transactionsList')!;
    return {
        w, list, posted, runs,
        rows: () => list.querySelectorAll('.tx-row').length,
        set: (next: Record<string, unknown>) => { state = { ...state, ...next }; w.Transactions.update(state); }
    };
}

describe('History with thousands of runs', () => {
    it('Show all reads every run; the list draws 200 rows, the next 200 when scrolled near its end', () => {
        const h = history(3_000);
        h.set({});
        expect(h.rows()).to.equal(200);
        (h.list.ownerDocument.querySelector('#transactionsSummary .transactions-show-all') as HTMLElement).click();
        expect(h.posted.map(m => m.type)).to.include('historyAll');
        h.w.Transactions.onHistoryAll({ transactions: h.runs });
        expect(h.rows()).to.equal(200);
        expect(h.list.querySelector('.tx-list-more')!.textContent).to.equal('200 of 3,000 shown · scroll for more');
        h.list.dispatchEvent(new h.list.ownerDocument.defaultView!.Event('scroll'));
        expect(h.rows()).to.equal(400);
    });

    it('the Hub\'s state again with nothing changed draws nothing; a run\'s new status does', () => {
        const h = history(800, 800);
        h.set({});
        const first = h.list.querySelector('.tx-row');
        h.set({ transactions: h.runs.map(r => ({ ...r })) });
        expect(h.list.querySelector('.tx-row'), 'the same rows').to.equal(first);
        h.set({ transactions: h.runs.map((r, i) => i === 0 ? { ...r, status: 'error' } : r) });
        expect(h.list.querySelector('.tx-row'), 'drawn again').to.not.equal(first);
    });
});
