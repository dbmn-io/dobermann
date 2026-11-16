// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * GitHub Issue #336: when the batch engine sends the Console a new "Remaining" estimate.
 * Seen 2026-10-06: a split of 100 started slowly (completions at 4 s and 12 s); the first
 * estimate, from those two, said 16m against a real 2m, and stayed on screen until 65 s.
 */
import { expect } from 'chai';
import { etaUpdateDue } from '../../../services/execution/batch-execution-engine.service';

describe('ETA schedule (GitHub Issue #336)', () => {
    it('nothing in the first 5 seconds', () => {
        expect(etaUpdateDue(3, 50, undefined)).to.equal(false);
    });

    it('the first estimate waits for 5 completions, or 15 seconds', () => {
        expect(etaUpdateDue(6, 2, undefined), 'two completions: too few').to.equal(false);
        expect(etaUpdateDue(6, 5, undefined), 'five: enough').to.equal(true);
        expect(etaUpdateDue(15, 2, undefined), 'a slow API still gets an estimate at 15 s').to.equal(true);
    });

    it('every 10 seconds in the first minute, so an early guess is soon corrected', () => {
        expect(etaUpdateDue(20, 10, 5_000)).to.equal(false);
        expect(etaUpdateDue(20, 10, 10_000)).to.equal(true);
    });

    it('then every 60 seconds, as before', () => {
        expect(etaUpdateDue(90, 100, 30_000)).to.equal(false);
        expect(etaUpdateDue(90, 100, 60_000)).to.equal(true);
    });
});
