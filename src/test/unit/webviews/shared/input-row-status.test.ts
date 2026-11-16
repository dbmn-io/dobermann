// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const InputRowStatus = require('../../../../webviews/shared/input-row-status');

describe('InputRowStatus (Issue #304)', () => {
    it('gives each input row the status of the transaction that sent it', () => {
        const { status, owner } = InputRowStatus.rowStatuses(6, [
            { key: 'a', rowStart: 1, rows: 2, status: 'completed' },
            { key: 'b', rowStart: 3, rows: 2, status: 'error' },
            { key: 'c', rowStart: 5, rows: 1, status: 'running' }
        ]);
        expect(status).to.deep.equal(['completed', 'completed', 'error', 'error', 'running', 'not_processed']);
        expect(owner).to.deep.equal(['a', 'a', 'b', 'b', 'c', null]);
    });

    it('lets the smaller transaction win when a request was split', () => {
        const { status, owner } = InputRowStatus.rowStatuses(4, [
            { key: 'parent', rowStart: 1, rows: 4, status: 'split' },
            { key: 'child-1', rowStart: 1, rows: 2, status: 'completed' },
            { key: 'child-2', rowStart: 3, rows: 2, status: 'error' }
        ]);
        expect(status).to.deep.equal(['completed', 'completed', 'error', 'error']);
        expect(owner).to.deep.equal(['child-1', 'child-1', 'child-2', 'child-2']);
    });

    it('treats pending, split and unknown as not processed, and ignores bad ranges', () => {
        const { status } = InputRowStatus.rowStatuses(3, [
            { key: 'p', rowStart: '1', rows: '1', status: 'pending' },
            { key: 's', rowStart: 2, rows: 1, status: 'split' },
            { key: 'x', rowStart: undefined, rows: 1, status: 'error' },
            { key: 'y', rowStart: 3, rows: 0, status: 'error' }
        ]);
        expect(status).to.deep.equal(['not_processed', 'not_processed', 'not_processed']);
    });

    it('counts rows per status', () => {
        expect(InputRowStatus.counts(['completed', 'error', 'error', 'not_processed'])).to.deep.equal({
            all: 4, completed: 1, error: 2, running: 0, cancelled: 0, not_processed: 1
        });
    });

    it('shows a transaction Cancel cut off as Cancelled, not as not processed (#335)', () => {
        const { status } = InputRowStatus.rowStatuses(2, [
            { key: 'a', rowStart: 1, rows: 1, status: 'cancelled' },
            { key: 'b', rowStart: 2, rows: 1, status: 'pending' }
        ]);
        expect(status).to.deep.equal(['cancelled', 'not_processed']);
        expect(InputRowStatus.LABELS.cancelled).to.equal('Cancelled');
    });

    it('adds the Result column and filters, without touching the input rows', () => {
        const input = [{ sku: 'A' }, { sku: 'B' }, { sku: 'C' }];
        const { records, indices } = InputRowStatus.annotate(input, ['completed', 'error', 'error'], 'error', 'Result');
        expect(records).to.deep.equal([{ Result: 'Error', sku: 'B' }, { Result: 'Error', sku: 'C' }]);
        expect(indices).to.deep.equal([1, 2]);
        expect(input[1]).to.deep.equal({ sku: 'B' });
        expect(InputRowStatus.annotate(input, ['completed', 'error', 'error'], 'all', 'Result').records).to.have.length(3);
    });

    it('names the column Result, or DBMN Result when the input has a result column in any case', () => {
        // A file's own `status` (Puppy School Lesson 3) never collides.
        expect(InputRowStatus.columnId({ sku: 'A', status: 'active' })).to.equal('Result');
        expect(InputRowStatus.columnId({ sku: 'A', result: 'ok' })).to.equal('DBMN Result');
        expect(InputRowStatus.columnId({ sku: 'A', RESULT: 'ok' })).to.equal('DBMN Result');
    });
});
