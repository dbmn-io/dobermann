// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * GitHub Issue #309: what the progress adapter tells the Console about a
 * queued batch. Its opening message used to be "Starting..." — parsed as
 * `running` — so the Console timed a batch that was only waiting.
 */

import { expect } from 'chai';
import { ProgressToConsoleAdapter } from '../../../../services/progress-adapter/progress-to-console-adapter';
import { ConsoleController } from '../../../../screens/console/console.controller';
import { VsCodeConsoleProgressSink } from '../../../../platform/vscode/vscode-console-progress-sink';

describe('ProgressToConsoleAdapter — queued batches (GitHub Issue #309)', () => {
    const consoles = (ConsoleController as any).activeConsoles as Map<string, unknown>;
    let posted: any[];
    // Issue #320: through the VS Code sink, so this still proves what reaches a real Console
    const sink = new VsCodeConsoleProgressSink();

    beforeEach(() => {
        posted = [];
        consoles.set('batch-q', { post: async (m: unknown) => { posted.push(m); return true; } });
    });

    afterEach(() => { consoles.delete('batch-q'); });

    const payloads = () => posted.filter(m => m.type === 'progress_update').map(m => m.payload);

    it('opens as pending when told the batch will queue', async () => {
        const adapter = new ProgressToConsoleAdapter('batch-q', sink, { title: 't', initialStatus: 'pending' });
        await adapter.withProgress(async () => undefined);
        expect(payloads()[0].status).to.equal('pending');
        expect(payloads()[0].message).to.equal('Queued');
    });

    it('opens as "Starting..." (running) when nothing is ahead of it', async () => {
        const adapter = new ProgressToConsoleAdapter('batch-q', sink, { title: 't' });
        await adapter.withProgress(async () => undefined);
        expect(payloads()[0].status).to.equal('running');
    });

    it('passes an explicit status, the batch ahead and the expected start through to the Console', async () => {
        const adapter = new ProgressToConsoleAdapter('batch-q', sink, { title: 't', initialStatus: 'pending' });
        const at = Date.now() + 90000;
        await adapter.withProgress(async (progress) => {
            progress.report({ message: 'Waiting for current batch to complete... 5s elapsed', status: 'pending', queuedBehind: 'Orders', expectedStartTime: at });
        });
        const last = payloads()[payloads().length - 1];
        expect(last.status).to.equal('pending');
        expect(last.queuedBehind).to.equal('Orders');
        expect(last.expectedStartTime).to.equal(at);
    });

    it('an explicit status wins over the text guess', async () => {
        const adapter = new ProgressToConsoleAdapter('batch-q', sink, { title: 't' });
        await adapter.withProgress(async (progress) => {
            progress.report({ message: 'Executing 1/2', status: 'pending' });
        });
        const last = payloads()[payloads().length - 1];
        expect(last.status).to.equal('pending');
    });
});
