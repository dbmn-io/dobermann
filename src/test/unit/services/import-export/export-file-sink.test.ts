// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it } from 'mocha';
import { ImportExportService } from '../../../../services/import-export/import-export.service';
import { IFileSink, FileSaveRequest, FileSaveResult } from '../../../../services/io/file-sink.interface';

/**
 * GitHub Issue #275 — portability seam. Proves export persists through the
 * injected IFileSink (not a hard-wired vscode.window.showSaveDialog), so eject
 * can swap the sink without touching export logic.
 */
describe('ImportExportService — FileSink seam (#275)', () => {
    const fakeEndpointMgr = { getAllEndpoints: async () => [] };
    const fakeEnvMgr = { getAllEnvironments: async () => [] };
    const fakeLogger = { info() {}, error() {}, debug() {}, warn() {} };
    // createMetadata reads context.extension.packageJSON.version.
    const fakeContext = { extension: { packageJSON: { version: '0.0.0-test' } } };

    function makeService(sink: IFileSink): ImportExportService {
        return new ImportExportService(
            fakeEndpointMgr as never,
            fakeEnvMgr as never,
            undefined as never,
            fakeContext as never,
            fakeLogger as never,
            sink
        );
    }

    it('routes the zip bytes through the sink and returns its path', async () => {
        const calls: FileSaveRequest[] = [];
        const sink: IFileSink = {
            save: async (req): Promise<FileSaveResult> => {
                calls.push(req);
                return { saved: true, path: '/chosen/dir/my-export.dbmn.zip' };
            }
        };

        const res = await makeService(sink).exportToZip({
            endpoints: [],
            environments: [],
            includeConsoleSettings: false,
            filename: 'my-export'
        });

        expect(res.success).to.equal(true);
        expect(res.filePath).to.equal('/chosen/dir/my-export.dbmn.zip');
        expect(calls).to.have.length(1);
        expect(calls[0].suggestedName).to.equal('my-export.dbmn.zip');
        expect(calls[0].data.length).to.be.greaterThan(0); // a real zip buffer
        expect(calls[0].filters).to.have.property('Dobermann Export');
    });

    it('reports a cancelled save as an unsuccessful (cancelled) export', async () => {
        const sink: IFileSink = {
            save: async (): Promise<FileSaveResult> => ({ saved: false, cancelled: true })
        };

        const res = await makeService(sink).exportToZip({
            endpoints: [],
            environments: [],
            includeConsoleSettings: false,
            filename: 'my-export'
        });

        expect(res.success).to.equal(false);
        expect(res.error).to.match(/cancel/i);
    });
});
