// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #320: ProgressToConsoleAdapter reports through IExecutionProgressSink, with no VS Code
 * loaded. The VS Code path (VsCodeConsoleProgressSink → Console postMessage) is covered in
 * test/unit/services/progress-adapter.
 */
import { expect } from 'chai';
import { ProgressToConsoleAdapter } from '../../../services/progress-adapter/progress-to-console-adapter';
import { RecordingProgressSink } from '../../../platform/memory/recording-progress-sink';

describe('ProgressToConsoleAdapter through a progress sink', () => {
    const payloads = (sink: RecordingProgressSink) => sink.of('progress').map(event => event.payload);

    it('opens the batch Console when none is open, then reports to it', async () => {
        const sink = new RecordingProgressSink();
        const adapter = new ProgressToConsoleAdapter('batch-1', sink, { title: 'Batch Preparation' });

        await adapter.withProgress(async progress => {
            progress.report({ message: 'Creating transaction 3 of 10', increment: 30 });
        });

        expect(sink.events[0]).to.deep.equal({ kind: 'openConsole', executionId: 'batch-1', isBatch: true, focus: false });
        const [starting, creating] = payloads(sink);
        expect(starting).to.include({ executionId: 'batch-1', title: 'Batch Preparation', message: 'Starting...', status: 'running' });
        expect(creating).to.include({ message: 'Creating transaction 3 of 10', totalProgress: 30 });
    });

    it('does not reopen a Console that is already open', async () => {
        const sink = new RecordingProgressSink(['batch-1']);
        await new ProgressToConsoleAdapter('batch-1', sink).withProgress(async () => undefined);
        expect(sink.of('openConsole')).to.have.length(0);
        expect(payloads(sink)).to.have.length(1);
    });

    it('opens a queued batch as pending (Issue #309)', async () => {
        const sink = new RecordingProgressSink();
        await new ProgressToConsoleAdapter('batch-q', sink, { initialStatus: 'pending' }).withProgress(async () => undefined);
        expect(payloads(sink)[0]).to.include({ status: 'pending', message: 'Queued', queued: true });
    });

    it('parses counts and ETA from the message, and an explicit status wins over the guess', async () => {
        const sink = new RecordingProgressSink(['batch-1']);
        const before = Date.now();
        await new ProgressToConsoleAdapter('batch-1', sink).withProgress(async progress => {
            progress.report({ message: 'Executing 25/100 - ETA: 2m', status: 'pending' });
        });
        const last = payloads(sink)[1];
        expect(last).to.include({ current: 25, total: 100, percentage: 25, status: 'pending' });
        expect(last.estimatedEndTime).to.be.at.least(before + 120000);
    });

    it('drops progress when the Console could not be opened', async () => {
        const sink = new RecordingProgressSink();
        sink.ensureConsoleOpen = async () => undefined;
        await new ProgressToConsoleAdapter('batch-1', sink).withProgress(async progress => {
            progress.report({ message: 'Executing 1/2' });
        });
        expect(payloads(sink)).to.deep.equal([]);
    });

    it('hands the callback a cancellation flag that cancel() sets', async () => {
        const sink = new RecordingProgressSink(['batch-1']);
        const adapter = new ProgressToConsoleAdapter('batch-1', sink);
        const seen = await adapter.withProgress(async (_progress, token) => {
            const before = token.isCancellationRequested;
            adapter.cancel();
            return [before, token.isCancellationRequested];
        });
        expect(seen).to.deep.equal([false, true]);
        expect(adapter.isCancelled).to.equal(true);
    });
});
