// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { MissedStatusBuffer } from '../../../../webviews/console/missed-status-buffer';

describe('MissedStatusBuffer', () => {
    it('hands back the update that arrived before the console registered', () => {
        const buffer = new MissedStatusBuffer<{ status: string }>();
        buffer.record('exec_1', { status: 'error' });

        expect(buffer.take('exec_1')).to.deep.equal({ status: 'error' });
    });

    it('keeps only the latest update per execution — a fast run sends preparing, running, error before the iframe is ready', () => {
        const buffer = new MissedStatusBuffer<{ status: string }>();
        buffer.record('exec_1', { status: 'preparing' });
        buffer.record('exec_1', { status: 'running' });
        buffer.record('exec_1', { status: 'error' });

        expect(buffer.take('exec_1')).to.deep.equal({ status: 'error' });
    });

    it('replays once only', () => {
        const buffer = new MissedStatusBuffer<{ status: string }>();
        buffer.record('exec_1', { status: 'completed' });
        buffer.take('exec_1');

        expect(buffer.take('exec_1')).to.equal(undefined);
    });

    it('returns undefined for an execution that missed nothing', () => {
        expect(new MissedStatusBuffer<{ status: string }>().take('exec_1')).to.equal(undefined);
    });

    it('drops the oldest entries past its limit, so runs whose console never opens cannot pile up', () => {
        const buffer = new MissedStatusBuffer<{ status: string }>(2);
        buffer.record('exec_1', { status: 'completed' });
        buffer.record('exec_2', { status: 'completed' });
        buffer.record('exec_3', { status: 'completed' });

        expect(buffer.take('exec_1')).to.equal(undefined);
        expect(buffer.take('exec_2')).to.deep.equal({ status: 'completed' });
        expect(buffer.take('exec_3')).to.deep.equal({ status: 'completed' });
    });
});
