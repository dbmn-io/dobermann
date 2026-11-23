// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Auto-discovered columns: the status code and the body, and nothing else.
 *
 * Reported 2026-09-19 from Puppy School Lesson 3. Columns were discovered in the response's
 * own key order, and the extension wraps every response as `{ executionId, duration,
 * httpStatus, httpStatusText, headers, data, status }`. A failed batch therefore showed
 * twenty-two columns — eleven of them HTTP headers — with `error` SIXTEENTH, off the side
 * of the table. The only way to read why a load failed was to build a view.
 *
 * The envelope now contributes one column, `httpStatus`. Headers are transport metadata;
 * `status` repeats what the tab already says; `httpStatusText` restates the code;
 * `executionId` is a UUID nobody reads; `duration` is noise in a table of records.
 *
 * Nothing is hidden: the Raw tab shows the whole response, and the View editor builds its
 * tree from the response itself, so any of them can be added back to a view.
 *
 * The rule is about the envelope, not about error field names, so it holds for any API.
 */
import { expect } from 'chai';
import { describe, it } from 'mocha';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createConsoleTableBuilder } = require('../../../../webviews/shared/console-table-builder');

type Column = { id: string };
const ids = (rows: unknown[]): string[] =>
    createConsoleTableBuilder().inferColumnsFromData(rows).map((c: Column) => c.id);

const HEADERS = {
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-allow-origin': '*',
    connection: 'keep-alive',
    'content-encoding': 'gzip',
    'content-length': '290',
    'content-type': 'application/json',
    date: 'Sat, 19 Sep 2026 03:58:02 GMT',
    vary: 'Accept-Encoding',
    via: 'kong/2.8.1',
    'x-kong-proxy-latency': '2',
    'x-kong-upstream-latency': '230'
};

/** A response exactly as the extension stores one. */
const response = (body: unknown, httpStatus = 400) => ({
    executionId: '51a9e9b4-85f4-4003-9a7a-0b9edf68f99b',
    duration: 508,
    httpStatus,
    httpStatusText: httpStatus === 400 ? 'Bad Request' : 'Internal Server Error',
    headers: { ...HEADERS },
    data: body,
    status: httpStatus < 400 ? 'completed' : 'error'
});

const ENVELOPE_NOISE = ['executionId', 'duration', 'httpStatusText', 'status'];
const hasAnyHeader = (cols: string[]) => cols.some(id => id === 'headers' || id.startsWith('headers.'));

describe('Console columns — the status code and the body', () => {
    it('our own error: the whole body, one status column, nothing else', () => {
        const cols = ids([response({
            error: 'Invalid reference value: Key (gtin)=(99999999999999) is not present in table "playground_products".',
            code: 'FK_VIOLATION',
            pgDetails: 'Key (gtin)=(99999999999999) is not present in table "playground_products"',
            pgMessage: 'insert or update on table "playground_inventory" violates foreign key constraint'
        })]);
        expect(cols).to.include.members(['httpStatus', 'data.error', 'data.code', 'data.pgDetails', 'data.pgMessage']);
        expect(hasAnyHeader(cols), cols.join(', ')).to.equal(false);
        for (const id of ENVELOPE_NOISE) { expect(cols, id).to.not.include(id); }
        expect(cols.length, 'was 22 columns').to.be.lessThan(8);
    });

    it("somebody else's error shape works the same — no field names are special-cased", () => {
        for (const body of [
            { message: 'Validation failed', detail: 'sku is required' },
            { title: 'Conflict', errors: ['duplicate key'] },
            { fault: { faultstring: 'rate limit exceeded' } }
        ]) {
            const cols = ids([response(body)]);
            expect(cols.filter(id => id.startsWith('data.')).length, JSON.stringify(body)).to.be.greaterThan(0);
            expect(cols, JSON.stringify(body)).to.include('httpStatus');
            expect(hasAnyHeader(cols), JSON.stringify(body)).to.equal(false);
        }
    });

    it("an API's OWN status field is body, not envelope, and survives", () => {
        const cols = ids([response({ status: 'low_stock', sku: 'SKU-WOOF-001', quantityOnHand: 7 }, 200)]);
        expect(cols).to.include.members(['data.status', 'data.sku', 'data.quantityOnHand']);
        expect(cols, 'the envelope status still goes').to.not.include('status');
    });

    it('a failure with no response at all still reads', () => {
        const cols = ids([{ executionId: 'e1', duration: 30, status: 'error', data: { error: 'ECONNREFUSED' } }]);
        expect(cols).to.include('data.error');
        expect(cols).to.not.include('executionId');
    });

    it('a plain-string body is still a column', () => {
        expect(ids([response('502 Bad Gateway')])).to.include('data');
    });

    it('the Completed tab gains the same: the records, and the status code', () => {
        const cols = ids([response({ created: 100, data: [{ sku: 'SKU-1' }] }, 201)]);
        expect(cols).to.include.members(['httpStatus', 'data.created']);
        expect(hasAnyHeader(cols)).to.equal(false);
    });

    it('excludeEnvelopeNoise is pure, defensive, and matches the envelope only', () => {
        const builder = createConsoleTableBuilder();
        expect(builder.excludeEnvelopeNoise([]).length).to.equal(0);
        expect(builder.excludeEnvelopeNoise(null)).to.equal(null);
        const kept = builder.excludeEnvelopeNoise([
            { id: 'status' }, { id: 'duration' }, { id: 'headers.date' },
            { id: 'data.status' }, { id: 'data.duration' }, { id: 'headersReceived' },
            { id: 'httpStatus' }, { id: 'data.error' }
        ]);
        expect(kept.map((c: Column) => c.id)).to.deep.equal([
            'data.status', 'data.duration', 'headersReceived', 'httpStatus', 'data.error'
        ]);
    });
});

// James, 2026-11-23: "@ also shows keys NOT yet shown and then allows us to add them into their group"
describe('The Console: every leaf a record has, as the View names it', () => {
    const paths = (records: unknown[], cap?: number) => createConsoleTableBuilder().recordLeafPaths(records, cap);

    it('dot paths from the root, into objects and into lists of records; a list of plain values is one leaf', () => {
        expect(paths([{ id: 1, header: { site: 'A' }, asnline: [{ sku: 'X', qty: 1 }, { sku: 'Y', lot: 'L1' }], tags: ['a', 'b'], empty: [] }]))
            .to.deep.equal(['id', 'header.site', 'asnline.sku', 'asnline.qty', 'asnline.lot', 'tags', 'empty']);
    });

    it('merged over the records, each once, in the order first met, and never more than asked', () => {
        expect(paths([{ a: 1 }, { b: 2, a: 3 }, null, 'text'])).to.deep.equal(['a', 'b']);
        expect(paths([{ a: 1, b: 2, c: 3 }], 2)).to.deep.equal(['a', 'b']);
        expect(paths([])).to.deep.equal([]);
    });
});

