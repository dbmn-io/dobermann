// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/** 2026-10-06: a catalogue read refused as "JWT issued at future" is retried once, after a moment. */
import { expect } from 'chai';
import { settled } from '../../../platform/supabase/settled';

describe('catalogue reads retry "JWT issued at future" once', function () {
    this.timeout(5000);

    it('retries after the clock settles and returns the second answer', async () => {
        const answers = [
            { data: null, error: { message: 'JWT issued at future' } },
            { data: ['row'], error: null }
        ];
        let calls = 0;
        const started = Date.now();
        const result = await settled(async () => answers[calls++]);
        expect(calls).to.equal(2);
        expect(result).to.deep.equal({ data: ['row'], error: null });
        expect(Date.now() - started).to.be.at.least(1000);
    });

    it('does not retry other errors, and retries at most once', async () => {
        let calls = 0;
        const other = await settled(async () => { calls++; return { data: null, error: { message: 'permission denied' } }; });
        expect(calls).to.equal(1);
        expect(other.error?.message).to.equal('permission denied');

        calls = 0;
        const twice = await settled(async () => { calls++; return { data: null, error: { message: 'JWT issued at future' } }; });
        expect(calls).to.equal(2);
        expect(twice.error?.message).to.equal('JWT issued at future');
    });
});
