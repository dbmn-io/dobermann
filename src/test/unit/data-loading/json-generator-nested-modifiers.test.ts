// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Nested (grouped) templates must honour the empty-value modifiers and keep types.
 *
 * Flat and root-array templates go through TemplateParser, which implements `|opt`
 * (omit the key) and `|null`. Templates with root variables + a lines array — a purchase
 * order, a shipment — are filled by JsonGenerator.substituteVariables instead, which read
 * everything after the colon as the type. So in a grouped batch:
 *   - `{{part:string|opt}}` with a blank cell sent `"part": ""` instead of omitting the key
 *   - `{{qty:number|null}}` with a blank cell sent `""` instead of null
 *   - `{{qty:number|>=0}}` sent the STRING "5", because "number|>=0" is not a known type
 * The docs promise all three work everywhere. Found while building Puppy School Lesson 5.
 */
import { expect } from 'chai';
import { describe, it, beforeEach } from 'mocha';
import { JsonGenerator } from '../../../data-loading/json-generator';

describe('JsonGenerator — modifiers in nested (grouped) templates', () => {
    let gen: JsonGenerator;
    const headers = ['po', 'note', 'sku', 'part', 'qty'];
    const mappings = headers.map(h => ({ variable: h, column: h, dataType: h === 'qty' ? 'number' : 'string' }));
    const csv = [
        'po,note,sku,part,qty',
        'PO1,rush,SKU-A,P-1,5',
        'PO1,rush,SKU-B,,7',
        'PO2,,SKU-C,,'
    ].join('\n');

    beforeEach(() => { gen = new JsonGenerator(); });

    async function run(template: string): Promise<any[]> {
        const result = await gen.generateBatchJsonFiles(csv, {
            template, headers, mappings,
            repeatableArrays: [{ arrayPath: 'lines', enabled: true, maxRepetitions: 1000 }],
            environmentVariables: {}
        } as any);
        expect(result.success, result.error).to.equal(true);
        return result.files.map(f => f.content);
    }

    it('|opt on a LINE field omits the key for blank cells and keeps it for filled ones', async () => {
        const [po1, po2] = await run('{ "po": "{{po}}", "lines": [ { "sku": "{{sku}}", "part": "{{part:string|opt}}" } ] }');
        expect(po1.lines).to.deep.equal([{ sku: 'SKU-A', part: 'P-1' }, { sku: 'SKU-B' }]);
        expect(po2.lines).to.deep.equal([{ sku: 'SKU-C' }]);
    });

    it('|opt on a HEADER field omits the key when the group\'s value is blank', async () => {
        const [po1, po2] = await run('{ "po": "{{po}}", "note": "{{note:string|opt}}", "lines": [ { "sku": "{{sku}}" } ] }');
        expect(po1).to.have.property('note', 'rush');
        expect(po2).to.not.have.property('note');
        expect(po2.lines).to.deep.equal([{ sku: 'SKU-C' }]);
    });

    it('|null sends null for a blank cell', async () => {
        const [po1, po2] = await run('{ "po": "{{po}}", "lines": [ { "sku": "{{sku}}", "qty": "{{qty:number|null}}" } ] }');
        expect(po1.lines[0].qty).to.equal(5);
        expect(po2.lines[0].qty).to.equal(null);
    });

    it('a typed variable keeps its type when it carries other modifiers', async () => {
        const [po1] = await run('{ "po": "{{po}}", "lines": [ { "sku": "{{sku}}", "qty": "{{qty:number|>=0}}" } ] }');
        expect(po1.lines[0].qty).to.equal(5);
        expect(po1.lines[1].qty).to.equal(7);
    });

    it('leaves a variable without modifiers exactly as it was: blank string stays ""', async () => {
        const [, po2] = await run('{ "po": "{{po}}", "lines": [ { "sku": "{{sku}}", "part": "{{part}}" } ] }');
        expect(po2.lines).to.deep.equal([{ sku: 'SKU-C', part: '' }]);
    });

    it('|opt inside a longer string is not an omission — only a whole-value variable can drop its key', async () => {
        const [, po2] = await run('{ "po": "{{po}}", "lines": [ { "sku": "{{sku}}", "part": "PRE-{{part:string|opt}}" } ] }');
        expect(po2.lines[0].part).to.equal('PRE-');
    });
});

/**
 * An optional variable does not need a column at all. Run Batch lets the user leave an
 * `|opt` / `|null` variable unmapped (the file simply has no such column); generation must
 * then treat it as empty — omit the key, or send null — never leave `{{part:string|opt}}`
 * in the request as literal text.
 */
describe('JsonGenerator — optional variables with NO column in the data', () => {
    const headers = ['po', 'sku'];
    const mappings = headers.map(h => ({ variable: h, column: h, dataType: 'string' }));
    const csv = ['po,sku', 'PO1,SKU-A', 'PO1,SKU-B', 'PO2,SKU-C'].join('\n');
    const LINES = [{ arrayPath: 'lines', enabled: true, maxRepetitions: 1000 }];

    async function run(template: string, repeatableArrays: unknown[]): Promise<any[]> {
        const result = await new JsonGenerator().generateBatchJsonFiles(csv, {
            template, headers, mappings, repeatableArrays, environmentVariables: {}
        } as any);
        expect(result.success, result.error).to.equal(true);
        return result.files.map(f => f.content);
    }

    it('nested: an unmapped |opt LINE variable is omitted from every line', async () => {
        const [po1] = await run('{ "po": "{{po}}", "lines": [ { "sku": "{{sku}}", "part": "{{part:string|opt}}" } ] }', LINES);
        expect(po1.lines).to.deep.equal([{ sku: 'SKU-A' }, { sku: 'SKU-B' }]);
    });

    it('nested: an unmapped |opt HEADER variable is omitted', async () => {
        const [po1] = await run('{ "po": "{{po}}", "note": "{{note:string|opt}}", "lines": [ { "sku": "{{sku}}" } ] }', LINES);
        expect(po1).to.not.have.property('note');
        expect(JSON.stringify(po1)).to.not.include('{{');
    });

    it('nested: an unmapped |null variable is sent as null', async () => {
        const [po1] = await run('{ "po": "{{po}}", "lines": [ { "sku": "{{sku}}", "qty": "{{qty:number|null}}" } ] }', LINES);
        expect(po1.lines[0].qty).to.equal(null);
    });

    it('flat: an unmapped |opt variable is omitted', async () => {
        const [first] = await run('{ "po": "{{po}}", "sku": "{{sku}}", "part": "{{part:string|opt}}" }', []);
        expect(first).to.deep.equal({ po: 'PO1', sku: 'SKU-A' });
    });

    it('an unmapped REQUIRED variable is still left visible, not silently dropped', async () => {
        const [po1] = await run('{ "po": "{{po}}", "lines": [ { "sku": "{{sku}}", "part": "{{part:string}}" } ] }', LINES);
        expect(po1.lines[0].part).to.equal('{{part:string}}');
    });
});
