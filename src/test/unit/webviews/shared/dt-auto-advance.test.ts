// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { JSDOM } from 'jsdom';
import * as path from 'path';
import * as fs from 'fs';

// GitHub Issue #247: Run Batch walks past Map only when every mapping is certain, and past
// Validate only when every row is valid (Validate's own Next decides), landing on Review.
// Each passed step stays on screen for a moment so the step bar shows the walk.
// Any click hands control back.
describe('Run Batch skip-ahead (DTAutoAdvance, #247)', () => {
    let dom: JSDOM;
    let w: any;
    let next: number;
    let notices: Array<[string, string]>;
    const state: any = {};

    beforeEach(() => {
        dom = new JSDOM('<!doctype html><body><button id="csvNextBtn"></button></body>', { runScripts: 'outside-only' });
        w = dom.window;
        next = 0;
        notices = [];
        Object.keys(state).forEach(k => delete state[k]);
        Object.assign(state, { modalStep: 2, templateVariables: [], endpointConfig: {} });
        w.CSVHandler = {
            csvState: state,
            areAllRequiredVariablesMapped: () => state.templateVariables.filter((v: any) => !v.optional && !/^(A8|ENV):/i.test(v.name)).every((v: any) => v.mappedTo),
            goToNextStep: () => { next++; },
            showModalNotification: (type: string, msg: string) => notices.push([type, msg])
        };
        const src = fs.readFileSync(path.join(__dirname, '../../../../../src/webviews/shared/dt-auto-advance.js'), 'utf8');
        w.eval(src);
        w.DTAutoAdvance.setDwell(0);
    });

    const tick = () => new Promise(resolve => w.setTimeout(resolve, 5));

    it('exact, punctuation-blind and remembered mappings skip Step 2', async () => {
        state.templateVariables = [
            { name: 'gtin', mappedTo: 'GTIN' },
            { name: 'location_gln', mappedTo: 'location.gln' },
            { name: 'buyer', mappedTo: 'Buyer GLN' },
            { name: 'A8:sequence' }
        ];
        state.endpointConfig = { dataLoadingConfig: { columnMappings: { buyer: 'Buyer GLN' } } };
        w.DTAutoAdvance.begin();
        w.DTAutoAdvance.afterMapping();
        await tick();
        expect(next).to.equal(1);
    });

    it('a date column read by this computer\'s date order stops on Step 2, so Map\'s line is seen', async () => {
        state.templateVariables = [{ name: 'shipDate', mappedTo: 'shipDate' }];
        w.CSVHandler.dateReadBySystem = (name: string) => name === 'shipDate';
        w.DTAutoAdvance.begin();
        w.DTAutoAdvance.afterMapping();
        await tick();
        expect(next).to.equal(0);
    });

    it('a partial-name guess stops on Step 2', async () => {
        state.templateVariables = [{ name: 'qty', mappedTo: 'orderedQty' }];
        w.DTAutoAdvance.begin();
        w.DTAutoAdvance.afterMapping();
        await tick();
        expect(next).to.equal(0);
    });

    it('an unmapped required variable stops on Step 2', async () => {
        state.templateVariables = [{ name: 'gtin', mappedTo: 'gtin' }, { name: 'reason' }];
        w.DTAutoAdvance.begin();
        w.DTAutoAdvance.afterMapping();
        await tick();
        expect(next).to.equal(0);
    });

    it('Step 3 presses its own Next and the walk ends on Review, without a toast', async () => {
        state.templateVariables = [{ name: 'gtin', mappedTo: 'gtin' }];
        w.DTAutoAdvance.begin();
        w.DTAutoAdvance.afterMapping();
        await tick();
        state.modalStep = 3;
        w.DTAutoAdvance.onStep(3);
        await tick();
        expect(next).to.equal(2);
        state.modalStep = 4;
        w.DTAutoAdvance.onStep(4);
        await tick();
        expect(next).to.equal(2);
        expect(notices).to.have.length(0);
        expect(w.DTAutoAdvance.status().walking).to.equal(false);
    });

    it('passes through Map and Validate on screen, pausing on each so the step bar shows it', async () => {
        w.DTAutoAdvance.setDwell(30);
        state.templateVariables = [{ name: 'gtin', mappedTo: 'gtin' }];
        w.DTAutoAdvance.begin();
        w.DTAutoAdvance.onStep(2);
        w.DTAutoAdvance.afterMapping();
        expect(w.document.body.classList.contains('auto-advancing')).to.equal(false);
        expect(w.DTAutoAdvance.status()).to.deep.equal({ walking: true, checkingStep: 2 });
        expect(next).to.equal(0);
        await new Promise(resolve => w.setTimeout(resolve, 60));
        expect(next).to.equal(1);
    });

    it('walkTo goes forward through each step\'s own Next and stops on the target', async () => {
        state.modalStep = 2;
        w.DTAutoAdvance.walkTo(4);
        await tick();
        expect(next).to.equal(1);
        state.modalStep = 3;
        w.DTAutoAdvance.onStep(3);
        await tick();
        expect(next).to.equal(2);
        state.modalStep = 4;
        w.DTAutoAdvance.onStep(4);
        await tick();
        expect(next).to.equal(2);
        expect(w.DTAutoAdvance.status().walking).to.equal(false);
    });

    it('walkTo stops on a step that needs the user', async () => {
        state.modalStep = 2;
        w.DTAutoAdvance.walkTo(5);
        await tick();
        state.modalStep = 3;
        state.activeNotification = { type: 'warning', message: '3 rows need fixing' };
        w.DTAutoAdvance.onStep(3);
        await tick();
        expect(next).to.equal(1);
        expect(w.DTAutoAdvance.status().walking).to.equal(false);
    });

    it('anything that needs the user ends the walk at once', async () => {
        state.templateVariables = [{ name: 'qty', mappedTo: 'orderedQty' }];   // a guess
        w.DTAutoAdvance.begin();
        w.DTAutoAdvance.afterMapping();
        expect(w.DTAutoAdvance.status().walking).to.equal(false);

        w.DTAutoAdvance.begin();
        w.DTAutoAdvance.cancel();   // what a warning, an error or blank cells call
        expect(w.DTAutoAdvance.status().walking).to.equal(false);
    });

    it('a passing warning while Step 2 auto-maps does not stop the skip; a warning from Step 3\'s checks does', async () => {
        state.templateVariables = [{ name: 'gtin', mappedTo: 'gtin' }];
        w.DTAutoAdvance.begin();
        w.DTAutoAdvance.onWarning();            // "1 unmapped" for a moment, mid auto-map
        w.DTAutoAdvance.afterMapping();
        await tick();
        expect(next).to.equal(1);
        state.modalStep = 3;
        w.DTAutoAdvance.onStep(3);
        await tick();
        expect(next).to.equal(2);
        w.DTAutoAdvance.onWarning();            // Step 3 found invalid rows
        expect(w.DTAutoAdvance.status().walking).to.equal(false);
    });

    it('a warning showing on Step 3 (type issues) stops there', async () => {
        state.templateVariables = [{ name: 'gtin', mappedTo: 'gtin' }];
        w.DTAutoAdvance.begin();
        w.DTAutoAdvance.afterMapping();
        await tick();
        state.modalStep = 3;
        state.activeNotification = { type: 'warning', message: '3 rows have type issues' };
        w.DTAutoAdvance.onStep(3);
        await tick();
        expect(next).to.equal(1);
    });

    it('a click hands control back: no skip after it', async () => {
        state.templateVariables = [{ name: 'gtin', mappedTo: 'gtin' }];
        w.DTAutoAdvance.begin();
        w.document.getElementById('csvNextBtn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
        w.DTAutoAdvance.afterMapping();
        await tick();
        expect(next).to.equal(0);
    });

    it('nothing happens unless Import Data started it', async () => {
        state.templateVariables = [{ name: 'gtin', mappedTo: 'gtin' }];
        w.DTAutoAdvance.afterMapping();
        state.modalStep = 3;
        w.DTAutoAdvance.onStep(3);
        await tick();
        expect(next).to.equal(0);
    });
});
