// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #428: why a transaction is on the Error tab — src/webviews/shared/console-error-reason.js.
 * A 200 failed by the endpoint's own test is named as a test failure, never a bare ERROR.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Reasons = require('../../../../webviews/shared/console-error-reason');

const testFailed = {
    httpStatus: 200,
    status: 'error',
    data: { success: true },
    metadata: { status: 'error', testStatus: 'failed', errorMessage: 'Test "PostExecutionTest" failed: Expected undefined to be true' }
};
const serverError = { httpStatus: 400, status: 'error', data: { message: 'Bad' }, metadata: { status: 'error', errorMessage: 'HTTP 400: Bad Request' } };
const completed = { httpStatus: 200, status: 'completed', data: { success: true }, metadata: { status: 'completed', testStatus: 'passed' } };

describe('Console error reasons (#428)', () => {
    it('a 200 whose test failed is a test failure, with the test and its assertion as the reason', () => {
        expect(Reasons.isTestFailure(testFailed)).to.equal(true);
        expect(Reasons.reasonFor(testFailed)).to.equal('Test "PostExecutionTest" failed: Expected undefined to be true');
    });

    it('a server error is an error, not a test failure, and says its status', () => {
        expect(Reasons.isTestFailure(serverError)).to.equal(false);
        expect(Reasons.reasonFor(serverError)).to.equal('HTTP 400: Bad Request');
        expect(Reasons.reasonFor({ httpStatus: 503, status: 'error', metadata: {} })).to.equal('HTTP 503');
        expect(Reasons.reasonFor({ httpStatus: '-', status: 'error', metadata: {} })).to.equal('No response');
    });

    it('a completed transaction has no reason, even when its test ran', () => {
        expect(Reasons.isTestFailure(completed)).to.equal(false);
        expect(Reasons.reasonFor(completed)).to.equal('');
    });

    it('a test that failed on a run DBMN still records as completed is not called one', () => {
        expect(Reasons.isTestFailure({ ...completed, metadata: { status: 'completed', testStatus: 'failed' } })).to.equal(false);
    });

    it('the Error tab gets a Reason column first, filled from each row\'s response', () => {
        const rowA: Record<string, unknown> = { 'data.success': true };
        Object.defineProperty(rowA, '__response', { value: testFailed, enumerable: false });
        const rowB: Record<string, unknown> = { 'data.message': 'Bad' };
        Object.defineProperty(rowB, '__response', { value: serverError, enumerable: false });
        const columns = [{ id: 'httpStatus', name: 'Http Status' }, { id: 'data.success', name: 'Success' }];

        const withReason = Reasons.withReasonColumn([rowA, rowB], columns);

        expect(withReason.map((c: { id: string }) => c.id)).to.deep.equal([Reasons.REASON_COLUMN_ID, 'httpStatus', 'data.success']);
        expect(withReason[0].name).to.equal('Reason');
        expect(rowA[Reasons.REASON_COLUMN_ID]).to.equal('Test "PostExecutionTest" failed: Expected undefined to be true');
        expect(rowB[Reasons.REASON_COLUMN_ID]).to.equal('HTTP 400: Bad Request');
        expect(Reasons.withReasonColumn([rowA], withReason), 'never twice').to.have.length(3);
    });

    it('the Console page loads it', () => {
        const root = path.resolve(__dirname, '../../../../../src');
        expect(fs.readFileSync(path.join(root, 'webviews/console/console.html'), 'utf8')).to.contain('{{CONSOLE_ERROR_REASON_URI}}');
        expect(fs.readFileSync(path.join(root, 'screens/console/console-page.ts'), 'utf8'))
            .to.contain("CONSOLE_ERROR_REASON_URI: 'shared/console-error-reason.js'");
    });
});
