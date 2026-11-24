// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The web and desktop apps' stand-in for VS Code's webview messaging (web/scripts/shell-config.ts,
 * BOOTSTRAP) copies each message a screen posts. A JSON copy turned a file's bytes (an
 * ArrayBuffer) into {}: Run Batch could not read any .xlsx in the browser ("Unsupported file data
 * format"), and the Hub's Import lost a binary file the same way. VS Code passes bytes as bytes.
 *
 * The real BOOTSTRAP text is run here, in this realm, and what it hands on goes to the real Run
 * Batch controller with a real three-sheet workbook.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as XLSX from 'xlsx';
import { EnvironmentManager } from '../../../environmentManager';
import { APIEndpointManager } from '../../../apiEndpointManager';
import { memoryStoreContext } from '../../../platform/memory/memory-store-context';
import { RunBatchController } from '../../../screens/run-batch/run-batch.controller';
import type { RunBatchPorts } from '../../../screens/run-batch/run-batch.ports';
import { ScreenSession } from '../../../screens/screen-session';
import { FormatConverterService } from '../../../services/format-converter/format-converter.service';

type Message = Record<string, any>;
const ROOT = path.resolve(__dirname, '../../../..');

/** The BOOTSTRAP script, as the web app's page runs it. */
function bootstrap(): (message: unknown) => Message {
    const source = fs.readFileSync(path.join(ROOT, 'web/scripts/shell-config.ts'), 'utf8');
    const start = source.indexOf('export const BOOTSTRAP = `') + 'export const BOOTSTRAP = `'.length;
    const script = source.slice(start, source.indexOf('`;', start));
    const received: Message[] = [];
    const window: Record<string, any> = { __dbmnShell: { receive: (m: Message) => received.push(m) } };
    new Function('window', script)(window);
    const api = window.acquireVsCodeApi();
    return message => { api.postMessage(message); return received[received.length - 1]; };
}

function threeSheets(): ArrayBuffer {
    const wb = XLSX.utils.book_new();
    for (const name of ['Inventory', 'Returns', 'Carriers']) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['sku', 'note'], [`${name}-1`, 'x']]), name);
    const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    return bytes;
}

describe('Web app messaging: a file\'s bytes reach the host as bytes', () => {
    it('an ArrayBuffer arrives as an ArrayBuffer with the same bytes, not shared with the sender', () => {
        const post = bootstrap();
        const bytes = new Uint8Array([80, 75, 3, 4, 0, 255]).buffer;
        const got = post({ type: 'detectFileFormat', fileData: bytes });
        expect(got.fileData).to.be.instanceOf(ArrayBuffer);
        expect(Array.from(new Uint8Array(got.fileData))).to.deep.equal([80, 75, 3, 4, 0, 255]);
        new Uint8Array(bytes)[0] = 1;
        expect(new Uint8Array(got.fileData)[0], 'a copy').to.equal(80);
    });

    it('a typed array keeps its type; nested ones too', () => {
        const post = bootstrap();
        const got = post({ type: 'x', payload: { list: [new Uint8Array([1, 2]), new Float64Array([0.5])] } });
        expect(got.payload.list[0]).to.be.instanceOf(Uint8Array);
        expect(Array.from(got.payload.list[0])).to.deep.equal([1, 2]);
        expect(got.payload.list[1]).to.be.instanceOf(Float64Array);
        expect(Array.from(got.payload.list[1])).to.deep.equal([0.5]);
    });

    it('everything else is copied as before: JSON, as VS Code sends a webview\'s messages', () => {
        const post = bootstrap();
        const when = new Date(Date.UTC(2026, 10, 24));
        const sent = { type: 'x', when, gone: undefined, fn: () => 1, nested: { a: [1, 'b', null] }, set: new Set([1]) };
        const got = post(sent);
        expect(got).to.deep.equal({ type: 'x', when: '2026-11-24T00:00:00.000Z', nested: { a: [1, 'b', null] }, set: {} });
        expect(got.nested).to.not.equal(sent.nested);
    });

    it('Run Batch reads a three-sheet workbook sent through it (the web app\'s Source step)', async () => {
        const post = bootstrap();
        const context = memoryStoreContext();
        const endpoints = new APIEndpointManager(context);
        const endpoint = await endpoints.addEndpoint({ name: 'Sheet Load', method: 'POST', path: '/inventory', body: '{"sku":"{{sku}}"}' });
        const posted: Message[] = [];
        const session = new ScreenSession({ post: m => posted.push(m) }, { openExternal: () => undefined });
        const ports = { endpoints, environments: new EnvironmentManager(context), formatConverter: new FormatConverterService() } as unknown as RunBatchPorts;
        const controller = new RunBatchController(session, ports, { context: 'runBatch', endpointId: endpoint.id, endpointName: endpoint.name, endpoint } as never);
        const file = threeSheets();
        await controller.handleMessage(post({ type: 'detectFileFormat', fileData: file, fileName: 'three-sheets.xlsx', fileSize: file.byteLength }) as never);
        const detected = posted.find(m => m.type === 'formatDetected');
        expect(detected?.error, 'no error').to.equal(undefined);
        expect(detected?.format).to.equal('excel');
        expect(detected?.metadata?.sheets).to.deep.equal(['Inventory', 'Returns', 'Carriers']);
    });
});
