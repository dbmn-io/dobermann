// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * GitHub Issue #288 — "A8:sequence not incrementing".
 *
 * A drawn sequence is a spent sequence. The counter used to advance only when
 * `isBatchExecution` was set, and the Run Batch paths never set it, so every
 * run re-read `sequenceCounter + 1` and handed out the same number (the
 * reporter saw 22 forever). Gaps between runs are acceptable; reuse is not.
 */

import { expect } from 'chai';
import { JsonGenerator } from '../../../data-loading/json-generator';
import { TemplateParser, SequenceContext } from '../../../data-loading/template-parser';

const ENDPOINT_ID = 'ep-1';

/** An endpoint manager that persists, the way the real one does. */
function makeEndpointManager(startAt = 21) {
    const state = {
        sequenceCounter: startAt,
        arraySequenceCounters: {} as Record<string, number>
    };

    return {
        state,
        getEndpoint: async () => ({
            id: ENDPOINT_ID,
            sequenceCounter: state.sequenceCounter,
            arraySequenceCounters: { ...state.arraySequenceCounters }
        }),
        getNextSequence: async () => {
            state.sequenceCounter += 1;
            return state.sequenceCounter;
        },
        getNextArraySequence: async (_endpointId: string, arrayPath: string) => {
            state.arraySequenceCounters[arrayPath] = (state.arraySequenceCounters[arrayPath] || 0) + 1;
            return state.arraySequenceCounters[arrayPath];
        }
    };
}

function options(template: string, extra: Record<string, unknown> = {}) {
    return {
        template,
        headers: ['SKU'],
        mappings: [{ variable: 'SKU', column: 'SKU', dataType: 'string' }],
        endpointId: ENDPOINT_ID,
        ...extra
    };
}

async function runOnce(generator: JsonGenerator, template: string, extra: Record<string, unknown> = {}) {
    const result = await generator.generateSingleRowJson('ABC123', options(template, extra) as never);
    expect(result.success, `generation failed: ${result.error}`).to.equal(true);
    return typeof result.jsonData === 'string' ? JSON.parse(result.jsonData) : result.jsonData;
}

describe('A8:sequence always increments (#288)', () => {
    const template = JSON.stringify({ OriginalOrderId: '{{A8:sequence}}' });

    it('gives a different value when the same endpoint is run twice', async () => {
        const manager = makeEndpointManager();
        const generator = new JsonGenerator(manager as never);

        const first = await runOnce(generator, template);
        const second = await runOnce(generator, template);

        expect(Number(second.OriginalOrderId)).to.be.greaterThan(Number(first.OriginalOrderId));
    });

    it('advances the stored counter, not just the returned value', async () => {
        const manager = makeEndpointManager(21);
        const generator = new JsonGenerator(manager as never);

        await runOnce(generator, template);

        expect(manager.state.sequenceCounter).to.equal(22);

        await runOnce(generator, template);

        expect(manager.state.sequenceCounter).to.equal(23);
    });

    it('never repeats a value across many runs', async () => {
        const manager = makeEndpointManager();
        const generator = new JsonGenerator(manager as never);

        const seen: number[] = [];
        for (let run = 0; run < 5; run++) {
            const json = await runOnce(generator, template);
            seen.push(Number(json.OriginalOrderId));
        }

        expect(new Set(seen).size, `repeated a sequence value: ${seen.join(', ')}`).to.equal(seen.length);
    });

    it('consumes a number on a preview draw too, not only on execution', async () => {
        const manager = makeEndpointManager(21);
        const generator = new JsonGenerator(manager as never);

        // No isBatchExecution — this is the preview/batch-prepare shape that
        // used to read without writing.
        await runOnce(generator, template);

        expect(manager.state.sequenceCounter).to.equal(22);
    });

    it('advances identically whether or not isBatchExecution is set', async () => {
        const previewManager = makeEndpointManager(21);
        const executionManager = makeEndpointManager(21);

        await runOnce(new JsonGenerator(previewManager as never), template);
        await runOnce(new JsonGenerator(executionManager as never), template, { isBatchExecution: true });

        expect(previewManager.state.sequenceCounter).to.equal(executionManager.state.sequenceCounter);
    });

    it('advances the :global array counter across runs', async () => {
        const manager = makeEndpointManager();
        const generator = new JsonGenerator(manager as never);
        const globalTemplate = JSON.stringify({ LineId: '{{A8:sequence:global}}' });

        const first = await runOnce(generator, globalTemplate);
        const second = await runOnce(generator, globalTemplate);

        expect(Number(second.LineId)).to.be.greaterThan(Number(first.LineId));
    });

    it('still produces a value when the counter cannot be persisted', async () => {
        const brokenManager = {
            getEndpoint: async () => ({ id: ENDPOINT_ID, sequenceCounter: 21 }),
            getNextSequence: async () => {
                throw new Error('Endpoint with ID "ep-1" not found');
            },
            getNextArraySequence: async () => {
                throw new Error('Endpoint with ID "ep-1" not found');
            }
        };
        const generator = new JsonGenerator(brokenManager as never);

        const json = await runOnce(generator, template, { sequenceStartValue: 1001 });

        expect(Number(json.OriginalOrderId)).to.equal(1001);
    });
});

describe('A8:sequence — one number per scope (#288)', () => {
    let counter: number;
    let parser: TemplateParser;
    const manager = {
        getNextSequence: async () => ++counter,
        getNextArraySequence: async () => ++counter
    };

    beforeEach(() => {
        counter = 21;
        parser = new TemplateParser();
    });

    async function processElement(template: object, context: SequenceContext) {
        const result = await parser.processTemplateAsync(
            JSON.stringify(template), {}, undefined, ENDPOINT_ID, manager, context
        );
        expect(result.success, result.error).to.equal(true);
        return JSON.parse(result.processedJson!);
    }

    it('gives every occurrence in one array element the same number', async () => {
        const context = parser.createSequenceContext({ arrayPath: 'OriginalOrderLine', parentSequence: 22 });

        const line = await processElement(
            { Extended: { PickTicketLineNo: '{{A8:sequence}}' }, ReferenceOrderLine: '{{A8:sequence}}' },
            context
        );

        expect(line.Extended.PickTicketLineNo).to.equal(line.ReferenceOrderLine);
    });

    it('gives each array element its own number', async () => {
        const context = parser.createSequenceContext({ arrayPath: 'OriginalOrderLine', parentSequence: 22 });
        const lineTemplate = { PickTicketLineNo: '{{A8:sequence}}', ReferenceOrderLine: '{{A8:sequence}}' };

        const line1 = await processElement(lineTemplate, context);
        const line2 = await processElement(lineTemplate, context);

        expect(line1).to.deep.equal({ PickTicketLineNo: 22, ReferenceOrderLine: 22 });
        expect(line2).to.deep.equal({ PickTicketLineNo: 23, ReferenceOrderLine: 23 });
    });

    it('keeps sharing one number across the root of a request', async () => {
        const result = await parser.processTemplateAsync(
            JSON.stringify({ OriginalOrderId: '{{A8:sequence}}', Extended: { GPCMessageID: 'DBMN-{{A8:sequence}}' } }),
            {}, undefined, ENDPOINT_ID, manager
        );
        const root = JSON.parse(result.processedJson!);

        expect(root.OriginalOrderId).to.equal(22);
        expect(root.Extended.GPCMessageID).to.equal('DBMN-22');
    });

    it('leaves :parent and :local as they were', async () => {
        const context = parser.createSequenceContext({ arrayPath: 'OriginalOrderLine', parentSequence: 22 });
        const lineTemplate = { own: '{{A8:sequence}}', parent: '{{A8:sequence:parent}}', line: '{{A8:sequence:local}}' };

        const line1 = await processElement(lineTemplate, context);
        const line2 = await processElement(lineTemplate, context);

        expect(line1).to.deep.equal({ own: 22, parent: 22, line: 1 });
        expect(line2).to.deep.equal({ own: 23, parent: 22, line: 2 });
    });
});
