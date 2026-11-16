// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Error tab count after "resume → retry failed".
 *
 * Reported 2026-09-18: a batch finished with 64 failed members. Resume, retry them, and all
 * 64 succeed — the rows leave the Error tab, but its badge says 64 for the whole retry and
 * only comes right when the batch completes (the Console then reloads from disk).
 *
 * Cause: the `clear_errors` handler in console.html removed the failed rows but left the
 * running error tally and the executionId → position map as they were. See
 * src/webviews/shared/console-live-counts.js.
 */
import { expect } from 'chai';
import { describe, it } from 'mocha';
import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const LiveCounts = require('../../../../webviews/shared/console-live-counts');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createConsoleTableBuilder } = require('../../../../webviews/shared/console-table-builder');

type Row = { httpStatus: number | string; status: string; metadata: { executionId: string; status: string } };

const classify = (rows: Row[]) => createConsoleTableBuilder().classifyResponses(rows);
const row = (id: string, status: string, httpStatus: number | string): Row =>
    ({ httpStatus, status, metadata: { executionId: id, status } });

/** A finished batch: 600 completed, then 64 failed scattered through it, then 6 never run. */
function finishedBatchWith64Errors(): Row[] {
    const rows: Row[] = [];
    for (let i = 0; i < 670; i++) {
        if (i >= 664) rows.push(row(`m${i}`, 'pending', '-'));
        else if (i % 10 === 3 && rows.filter(r => r.status === 'error').length < 64) rows.push(row(`m${i}`, 'error', 503));
        else rows.push(row(`m${i}`, 'completed', 201));
    }
    return rows;
}

/**
 * The Console's two live handlers, reduced to their bookkeeping — written the way
 * console.html writes them, on top of the module under test.
 */
function makeConsole(rows: Row[]) {
    let state = LiveCounts.seed(rows, classify);
    const self = {
        get errors() { return state.liveErrors as number; },
        get success() { return state.liveSuccess as number; },
        get rows() { return state.responses as Row[]; },
        get indexMap() { return state.indexMap as Map<string, number>; },
        clearErrors() { state = LiveCounts.clearErrors(state.responses, classify); },
        memberStatus(id: string, status: string) {
            const index = LiveCounts.resolveIndex(state.indexMap, state.responses, id);
            if (index >= 0) {
                const was = LiveCounts.classifyResult(state.responses[index]);
                if (was === 'success') state.liveSuccess--; else if (was === 'errors') state.liveErrors--;
                state.responses[index].status = status;
                state.responses[index].metadata.status = status;
            } else {
                state.indexMap.set(id, state.responses.length);
                state.responses.push(row(id, status, '-'));
            }
        },
        memberResult(result: Row) {
            const id = result.metadata.executionId;
            const index = LiveCounts.resolveIndex(state.indexMap, state.responses, id);
            if (index >= 0) {
                const was = LiveCounts.classifyResult(state.responses[index]);
                if (was === 'success') state.liveSuccess--; else if (was === 'errors') state.liveErrors--;
                state.responses[index] = result;
            } else {
                state.indexMap.set(id, state.responses.length);
                state.responses.push(result);
            }
            const now = LiveCounts.classifyResult(result);
            if (now === 'success') state.liveSuccess++; else if (now === 'errors') state.liveErrors++;
        }
    };
    return self;
}

describe('Console live counts — resume and retry the failures', () => {
    it('a finished batch seeds both tallies from what is on disk', () => {
        const c = makeConsole(finishedBatchWith64Errors());
        expect(c.errors).to.equal(64);
        expect(c.success).to.equal(600);
    });

    it('clearing the errors takes the tally to 0 WITH the rows — not just the badge', () => {
        const c = makeConsole(finishedBatchWith64Errors());
        c.clearErrors();
        expect(c.errors, 'the running error tally').to.equal(0);
        expect(c.success).to.equal(600);
        expect(c.rows.filter(r => r.status === 'error')).to.have.lengthOf(0);
    });

    it('the position map is rebuilt: every entry points at its own row', () => {
        const c = makeConsole(finishedBatchWith64Errors());
        c.clearErrors();
        expect(c.indexMap.size).to.equal(c.rows.length);
        for (const [id, index] of c.indexMap) {
            expect(c.rows[index].metadata.executionId, id).to.equal(id);
        }
    });

    it('members still waiting their turn keep their rows; completed rows are never dropped', () => {
        const rows = finishedBatchWith64Errors();
        rows[0] = row('m0', 'completed', '-');          // completed, but an odd httpStatus
        const c = makeConsole(rows);
        c.clearErrors();
        expect(c.rows.filter(r => r.status === 'pending')).to.have.lengthOf(6);
        expect(c.rows.some(r => r.metadata.executionId === 'm0')).to.equal(true);
        expect(c.success).to.equal(600);
    });

    it('THE REPORT: all 64 retried and succeeding — the Error tally stays 0 throughout, Completed climbs to 664', () => {
        const rows = finishedBatchWith64Errors();
        const failedIds = rows.filter(r => r.status === 'error').map(r => r.metadata.executionId);
        const c = makeConsole(rows);
        c.clearErrors();

        const seen: number[] = [];
        for (const id of failedIds) {
            c.memberStatus(id, 'running');
            seen.push(c.errors);
            c.memberResult(row(id, 'completed', 201));
            seen.push(c.errors);
        }
        expect(Math.max(...seen), 'highest Error count shown during the retry').to.equal(0);
        expect(c.success).to.equal(664);
        expect(c.errors).to.equal(0);
        // and nobody else's row was touched on the way
        expect(c.rows.filter(r => r.status === 'completed')).to.have.lengthOf(664);
        expect(c.rows.filter(r => r.status === 'pending')).to.have.lengthOf(6);
    });

    it('a retry that fails again counts as one error, once', () => {
        const rows = finishedBatchWith64Errors();
        const [first] = rows.filter(r => r.status === 'error').map(r => r.metadata.executionId);
        const c = makeConsole(rows);
        c.clearErrors();
        c.memberStatus(first, 'running');
        c.memberResult(row(first, 'error', 500));
        expect(c.errors).to.equal(1);
        c.memberStatus(first, 'running');                 // retried a second time
        expect(c.errors).to.equal(0);
        c.memberResult(row(first, 'completed', 201));
        expect(c.errors).to.equal(0);
        expect(c.success).to.equal(601);
    });

    it('a stale position never lands on somebody else\'s row', () => {
        const rows = [row('a', 'completed', 201), row('b', 'completed', 201)];
        const map = new Map<string, number>([['a', 0], ['b', 1], ['gone', 1], ['beyond', 9]]);
        expect(LiveCounts.resolveIndex(map, rows, 'b')).to.equal(1);
        expect(LiveCounts.resolveIndex(map, rows, 'gone'), 'position 1 belongs to b').to.equal(-1);
        expect(LiveCounts.resolveIndex(map, rows, 'beyond'), 'past the end of the table').to.equal(-1);
        expect(map.has('gone') || map.has('beyond'), 'stale entries are dropped').to.equal(false);
        expect(LiveCounts.resolveIndex(map, rows, undefined)).to.equal(-1);
    });
});

describe('the Console page uses the shared bookkeeping (it used to keep it by hand, and forgot)', () => {
    const consoleDir = path.resolve(__dirname, '../../../../../src/webviews/console');
    const html = fs.readFileSync(path.join(consoleDir, 'console.html'), 'utf8');
    // The page's script, a file since #372 (it was inline in console.html)
    const script = fs.readFileSync(path.join(consoleDir, 'console-page.js'), 'utf8');
    const clearCase = script.slice(script.indexOf("case 'clear_errors':"), script.indexOf("case 'REPORT_SETTINGS_LOADED':"));

    it('loads the module', () => {
        expect(html).to.contain('{{CONSOLE_LIVE_COUNTS_URI}}');
        const manager = fs.readFileSync(path.join(consoleDir, '..', '..', 'screens', 'console', 'console-page.ts'), 'utf8');
        expect(manager).to.contain("CONSOLE_LIVE_COUNTS_URI: 'shared/console-live-counts.js'");
    });

    it('clear_errors rebuilds rows, position map and tallies together', () => {
        expect(clearCase).to.contain('ConsoleLiveCounts.clearErrors');
        expect(clearCase).to.contain('applyLiveCounts');
        expect(clearCase, 'the hand-rolled httpStatus filter is gone').to.not.contain('httpStatus >= 200');
    });

    it('a full load seeds through the same code', () => {
        expect(script).to.contain('ConsoleLiveCounts.seed');
    });

    it('both live handlers resolve a row through the guard, never straight from the map', () => {
        expect(script.match(/ConsoleLiveCounts\.resolveIndex\(/g) || []).to.have.lengthOf(2);
        expect(script, 'no direct position lookups left').to.not.match(/_responseIndexMap\.get\(/);
    });
});

describe('append — a chunk of a large batch streams in (GitHub Issue #312)', () => {
    it('merges the chunk and rebuilds the tallies and positions from all rows', () => {
        const first = [row('m-1', 'completed', 200), row('m-2', 'error', 500)];
        const state = LiveCounts.append(first, [row('m-3', 'completed', 200), row('m-4', 'completed', 200)], classify);
        expect(state.responses.map((r: Row) => r.metadata.executionId)).to.deep.equal(['m-1', 'm-2', 'm-3', 'm-4']);
        expect(state.liveSuccess).to.equal(3);
        expect(state.liveErrors).to.equal(1);
        expect(state.indexMap.get('m-4')).to.equal(3);
    });

    it('a chunk row for an execution that already has a row replaces it — a live result beat the stream', () => {
        const first = [row('m-1', 'completed', 200), row('m-2', 'completed', 200)];
        const state = LiveCounts.append(first, [row('m-2', 'error', 500), row('m-3', 'completed', 200)], classify);
        expect(state.responses).to.have.length(3);
        expect(state.responses[1].status).to.equal('error');
        expect(state.liveSuccess).to.equal(2);
        expect(state.liveErrors).to.equal(1);
    });

    it('does not mutate the array it was given', () => {
        const first = [row('m-1', 'completed', 200)];
        LiveCounts.append(first, [row('m-2', 'completed', 200)], classify);
        expect(first).to.have.length(1);
    });
});
