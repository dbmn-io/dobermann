// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Run Batch's steps (batch-stepper.js) in the design system's footer (<dbmn-steps>): Source, Map,
 * Validate, Review (#435: Execute is Review's button). Done steps go back; a later step is
 * clickable only when nothing before it needs the user. What a step decided is its hover text,
 * and how far a read or a check has got is said in the screen (#batchWorking), not in the steps.
 */
const SRC = path.resolve(__dirname, '../../../../../src/webviews/run-batch/batch-stepper.js');
const ICONS = path.resolve(__dirname, '../../../../../src/webviews/shared/icons.js');
const FOOTER = path.resolve(__dirname, '../../../../../src/webviews/shared/dbmn-footer.js');

function load(state: Record<string, unknown>, opts: { walking?: boolean; checkingStep?: number | null; chained?: boolean; unmapped?: number } = {}) {
    const dom = new JSDOM(`<!DOCTYPE html><body><p id="batchWorking" class="hidden"></p>
        <dbmn-footer inline><dbmn-steps id="batchStepper" label="Run Batch steps"></dbmn-steps></dbmn-footer>
        <span id="totalApiCallsDisplay">3</span></body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
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
    w.eval(fs.readFileSync(ICONS, 'utf8'));
    w.eval(fs.readFileSync(FOOTER, 'utf8'));
    w.eval(fs.readFileSync(SRC, 'utf8'));
    w.BatchStepper.refresh();
    const steps = () => Array.from(w.document.querySelectorAll('.dbmn-step')).map((b: any) => ({
        status: (b.className.match(/is-(current|done|needs|available|blocked|pending|locked|skipped)/) || [])[1],
        // (what the step decided: the words after its name in its hover text)
        summary: String(b.title || '').replace(/^[^:]*:\s*/, ''),
        title: b.title,
        disabled: b.disabled
    }));
    return { w, went, steps };
}

describe('Run Batch step bar', () => {
    it('landing on Review after the walk: earlier steps done, Review the last', () => {
        const { steps } = load({ modalStep: 4, maxStepReached: 4 });
        expect(steps().map(s => s.status)).to.deep.equal(['done', 'done', 'done', 'current']);
        expect(steps().map(s => s.title)).to.deep.equal(['Back to Source: replenishment.csv · 295 rows', 'Back to Map: 6 of 6 mapped', 'Back to Validate: 295 rows valid', 'Review: 3 API calls']);
    });

    it('reading a file turns its own step, and how far it has got is said in the screen, not in the steps', () => {
        const { w } = load({ modalStep: 1, maxStepReached: 1, stepProgress: { step: 1, percent: 40, text: 'Fetching file...', seconds: 0 } });
        const source = w.document.querySelector('.dbmn-step[data-step="1"]');
        const line = w.document.getElementById('batchWorking');
        expect(source.classList.contains('is-checking')).to.equal(true);
        expect(line.textContent).to.equal('Fetching file...');
        expect(line.classList.contains('hidden')).to.equal(false);
        // No fill and no count in the steps: a progress bar and steps never show together
        expect(w.document.querySelector('.batch-step-fill, .has-progress')).to.equal(null);
        // Moved on to Map with the check's "Complete" still showing: it stays on Source
        w.CSVHandler.csvState.modalStep = 2;
        w.CSVHandler.csvState.maxStepReached = 2;
        w.BatchStepper.refresh();
        expect(w.document.querySelector('.dbmn-step[data-step="2"]').classList.contains('is-checking')).to.equal(false);
        w.CSVHandler.csvState.stepProgress = null;
        w.BatchStepper.refresh();
        expect(source.classList.contains('is-checking')).to.equal(false);
        expect(line.classList.contains('hidden')).to.equal(true);
        expect(line.textContent).to.equal('');
    });

    it('a finished check ("Complete", 100%) shows nowhere: Review opens with no stray line and Validate not turning', () => {
        const { w } = load({ modalStep: 4, maxStepReached: 4, stepProgress: { step: 3, percent: 100, text: 'Complete', seconds: 0 } });
        const line = w.document.getElementById('batchWorking');
        expect(w.document.querySelector('.dbmn-step[data-step="3"]').classList.contains('is-checking')).to.equal(false);
        expect(line.classList.contains('hidden')).to.equal(true);
        expect(line.textContent).to.equal('');
    });

    it('Map with unmapped variables: every later step waits for Map', () => {
        const { steps } = load({ modalStep: 2, maxStepReached: 2 }, { unmapped: 2 });
        expect(steps().map(s => s.status)).to.deep.equal(['done', 'current', 'blocked', 'blocked']);
        expect(steps()[1].title).to.equal('Map: 2 not mapped');
        expect(steps()[3].title).to.equal('Map needs you first');
        expect(steps().slice(2).every(s => s.disabled)).to.equal(true);
    });

    it('Validate with bad rows: Review waits for Validate', () => {
        const { steps } = load({ modalStep: 3, maxStepReached: 3, gridErrorRows: new Set([12, 40, 77]) });
        expect(steps().map(s => s.status)).to.deep.equal(['done', 'done', 'current', 'blocked']);
        expect(steps()[2].title).to.equal('Validate: 3 rows need fixing');
        expect(steps()[3].title).to.equal('Validate needs you first');
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
        expect(steps()[0]).to.include({ status: 'locked', disabled: true, title: 'Set by the chain' });
    });

    it('the current step is marked for assistive tech', () => {
        const { w } = load({ modalStep: 3, maxStepReached: 3 });
        const current = w.document.querySelector('[aria-current="step"]');
        expect(current.getAttribute('data-step')).to.equal('3');
        expect(current.getAttribute('aria-label')).to.match(/^Step 3 of 4, Validate/);
    });

    it('no name and no heading in the footer: the batch is named on its tab', () => {
        const { w } = load({ modalStep: 1, maxStepReached: 1 });
        expect(w.document.querySelector('#batchNameInput, .batch-stepper-current, .report-name')).to.equal(null);
    });
});
