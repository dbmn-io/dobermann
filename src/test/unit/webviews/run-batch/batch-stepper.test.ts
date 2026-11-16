// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Run Batch step bar (batch-stepper.js): Source, Map, Validate, Review (#435: Execute is Review's button).
 * Done steps go back; a later step is clickable only when nothing before it needs the user.
 */
const SRC = path.resolve(__dirname, '../../../../../src/webviews/run-batch/batch-stepper.js');
const STEP_BAR = path.resolve(__dirname, '../../../../../src/webviews/shared/step-bar.js');

function load(state: Record<string, unknown>, opts: { walking?: boolean; checkingStep?: number | null; chained?: boolean; unmapped?: number } = {}) {
    const dom = new JSDOM(`<!DOCTYPE html><body><nav id="batchStepper"></nav>
        <span id="totalApiCallsDisplay">3</span></body>`, { runScripts: 'outside-only' });
    const w = dom.window as any;
    const went: number[] = [];
    const needMapping = Array.from({ length: 6 }, (_, i) => ({ name: `v${i}`, mappedTo: i < 6 - (opts.unmapped || 0) ? `c${i}` : null }));
    w.CSVHandler = {
        csvState: { currentHeaders: ['a'], currentParsedData: { rows: new Array(295).fill([]) }, sourceType: 'file', templateVariables: needMapping, ...state },
        getVariablesThatNeedMapping: () => needMapping,
        goToStep: (n: number) => went.push(n)
    };
    w.currentCSVFileName = 'replenishment.csv';
    w.DTAutoAdvance = { status: () => ({ walking: !!opts.walking, checkingStep: opts.checkingStep ?? null }) };
    if (opts.chained) w.ChainPreload = { isChained: () => true, sourceLabel: () => 'GET Inventory Report' };
    w.eval(fs.readFileSync(STEP_BAR, 'utf8'));
    w.eval(fs.readFileSync(SRC, 'utf8'));
    w.BatchStepper.refresh();
    const steps = () => Array.from(w.document.querySelectorAll('.batch-step')).map((b: any) => ({
        status: (b.className.match(/is-(current|done|needs|available|blocked|pending|locked|skipped)/) || [])[1],
        summary: b.querySelector('.batch-step-summary').textContent,
        disabled: b.disabled
    }));
    return { w, went, steps };
}

describe('Run Batch step bar', () => {
    it('landing on Review after the walk: earlier steps done, Review the last', () => {
        const { steps } = load({ modalStep: 4, maxStepReached: 4 });
        expect(steps().map(s => s.status)).to.deep.equal(['done', 'done', 'done', 'current']);
        expect(steps().map(s => s.summary)).to.deep.equal(['replenishment.csv · 295 rows', '6 of 6 mapped', '295 rows valid', '3 API calls']);
    });

    it('#435: reading a file shows in its own step, as a fill and the step\'s summary, not a footer panel', () => {
        const { w, steps } = load({ modalStep: 1, maxStepReached: 1, stepProgress: { step: 1, percent: 40, text: 'Fetching file...', seconds: 0 } });
        const source = w.document.querySelector('[data-step="1"]');
        expect(steps()[0].summary).to.equal('Fetching file...');
        expect(source.classList.contains('has-progress')).to.equal(true);
        expect(source.style.getPropertyValue('--step-progress')).to.equal('40%');
        expect(source.querySelector('.batch-step-fill')).to.not.equal(null);
        // Moved on to Map with the check's "Complete" still showing: it stays on Source
        w.CSVHandler.csvState.modalStep = 2;
        w.CSVHandler.csvState.maxStepReached = 2;
        w.BatchStepper.refresh();
        expect(w.document.querySelector('[data-step="2"]').classList.contains('has-progress')).to.equal(false);
        w.CSVHandler.csvState.stepProgress = null;
        w.BatchStepper.refresh();
        expect(source.classList.contains('has-progress')).to.equal(false);
        expect(source.style.getPropertyValue('--step-progress')).to.equal('');
    });

    it('Map with unmapped variables: every later step waits for Map', () => {
        const { steps } = load({ modalStep: 2, maxStepReached: 2 }, { unmapped: 2 });
        expect(steps().map(s => s.status)).to.deep.equal(['done', 'current', 'blocked', 'blocked']);
        expect(steps()[1].summary).to.equal('2 not mapped');
        expect(steps()[3].summary).to.equal('Waits for Map');
        expect(steps().slice(2).every(s => s.disabled)).to.equal(true);
    });

    it('Validate with bad rows: Review waits for Validate', () => {
        const { steps } = load({ modalStep: 3, maxStepReached: 3, gridErrorRows: new Set([12, 40, 77]) });
        expect(steps().map(s => s.status)).to.deep.equal(['done', 'done', 'current', 'blocked']);
        expect(steps()[2].summary).to.equal('3 rows need fixing');
        expect(steps()[3].summary).to.equal('Waits for Validate');
    });

    it('back on Map after reaching Review: Validate and Review stay clickable', () => {
        const { steps, w, went } = load({ modalStep: 2, maxStepReached: 4 });
        expect(steps().map(s => s.status)).to.deep.equal(['done', 'current', 'available', 'available']);
        (w.document.querySelector('[data-step="4"]') as any).click();
        (w.document.querySelector('[data-step="1"]') as any).click();
        expect(went).to.deep.equal([4, 1]);
    });

    it('while the walk runs, steps ahead are not clickable and the current one is checking', () => {
        const { w, steps } = load({ modalStep: 2, maxStepReached: 2 }, { walking: true, checkingStep: 2 });
        expect(steps().map(s => s.status)).to.deep.equal(['done', 'current', 'pending', 'pending']);
        expect(w.document.querySelector('[data-step="2"]').classList.contains('is-checking')).to.equal(true);
    });

    it('a chained run: Source is set by the chain and cannot be clicked', () => {
        const { steps } = load({ modalStep: 2, maxStepReached: 2 }, { chained: true });
        expect(steps()[0]).to.include({ status: 'locked', disabled: true, summary: 'GET Inventory Report · 295 rows' });
    });

    it('the current step is marked for assistive tech', () => {
        const { w } = load({ modalStep: 3, maxStepReached: 3 });
        const current = w.document.querySelector('[aria-current="step"]');
        expect(current.getAttribute('data-step')).to.equal('3');
        expect(current.getAttribute('aria-label')).to.match(/^Step 3 of 4, Validate/);
    });

    it('the narrow heading names the endpoint from the start, before Import Data loads its config', () => {
        const { w } = load({ modalStep: 1, maxStepReached: 1 });
        w.document.body.dataset.endpointName = 'My Replenishment Orders';
        w.BatchStepper.refresh();
        expect(w.document.querySelector('.batch-stepper-current').textContent).to.equal('Batch Prep: My Replenishment Orders');
    });
});
