// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { JSDOM, VirtualConsole } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';
import { isProductionEnvironment } from '../../../../services/ui/production-guard.service';

/**
 * Review's "Sending To" card warns when the rows go to a production environment. The real Review
 * markup (screens/run-batch/run-batch-page.ts) and the real Data Transformer scripts in JSDOM, fed
 * the host's `currentEnvironmentData` message. Nothing is sent anywhere: the environment is a local
 * one on 127.0.0.1, marked as production.
 *
 * The Threads drop-down once wrote a hint into `#executionConcurrencyDetails`, which Review no
 * longer has: the write threw, and the warning after it never ran.
 */
const ROOT = path.resolve(__dirname, '../../../../..');
const SHARED = path.join(ROOT, 'src/webviews/shared');
const SCRIPTS = ['json-comment-stripper.js', 'template-rename.js', 'batch-explainer.js', 'request-preview.js', 'dt-data-entry-grid.js',
    'dt-type-coercion.js', 'dt-data-ingestion.js', 'dt-data-preview.js', 'dt-mismatch-repair.js', 'dt-batch-config.js', 'data-transformer.js'];

function reviewMarkup(): string {
    const source = fs.readFileSync(path.join(ROOT, 'src/screens/run-batch/run-batch-page.ts'), 'utf8');
    const start = source.indexOf('<div id="csvJsonPreviewStep"');
    return source.slice(start, source.indexOf('<p id="batchWorking"', start));
}

function load() {
    const errors: string[] = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', e => errors.push(String(e.message || e)));
    const dom = new JSDOM(`<!DOCTYPE html><body>${reviewMarkup()}</body>`, { runScripts: 'outside-only', virtualConsole });
    const win = dom.window as any;
    win.vscode = { postMessage: () => undefined };
    win.DbmnModal = { show: () => Promise.resolve({}) };
    for (const file of SCRIPTS) { dom.window.eval(fs.readFileSync(path.join(SHARED, file), 'utf8')); }
    const $ = (id: string) => dom.window.document.getElementById(id) as HTMLElement;
    const warningShown = () => !$('executionWarning').classList.contains('hidden');
    /** The host's answer to getCurrentEnvironment (run-batch.controller.ts), with Review open. */
    const sendEnvironment = (environment: Record<string, unknown>) => {
        win.CSVHandler.setState({ modalStep: 4, endpointConfig: { method: 'POST', path: '/stock' } });
        const isProduction = isProductionEnvironment(environment as never);
        win.dispatchEvent(new win.MessageEvent('message', { data: { type: 'currentEnvironmentData', environment, isProduction, headerVariables: [] } }));
    };
    return { $, errors, warningShown, sendEnvironment };
}

const LOCAL_PLAYGROUND = 'http://127.0.0.1:54321/functions/v1/playground';
const environment = (over: Record<string, unknown>) => ({ id: 'local', name: 'Local playground', baseUrl: LOCAL_PLAYGROUND, variables: {}, ...over });

describe('Run Batch Review: the production warning', () => {
    for (const parallelProcessing of [{ enabled: true, maxConcurrency: 4 }, undefined]) {
        const threads = parallelProcessing ? 'threads allowed' : 'one thread';
        it(`an environment marked production shows the warning, and nothing throws (${threads})`, () => {
            // named without "prod": the type alone decides, as it does for Execute's confirmation
            const { errors, warningShown, sendEnvironment } = load();
            sendEnvironment(environment({ environmentType: 'production', parallelProcessing }));
            expect(errors, 'Review threw').to.deep.equal([]);
            expect(warningShown(), 'the warning shows').to.equal(true);
        });
    }

    it('the Threads choices are still filled from the environment', () => {
        const { $, errors, sendEnvironment } = load();
        sendEnvironment(environment({ environmentType: 'production', parallelProcessing: { enabled: true, maxConcurrency: 4 } }));
        expect(errors).to.deep.equal([]);
        const dropdown = $('processingModeDropdown') as HTMLSelectElement;
        expect(Array.from(dropdown.options).map(o => o.value)).to.deep.equal(['1', '2', '4']);
        expect(dropdown.value).to.equal('1');
    });

    it('a name with "prod" in it still warns, as before', () => {
        const { errors, warningShown, sendEnvironment } = load();
        sendEnvironment(environment({ name: 'PROD copy', environmentType: 'development' }));
        expect(errors).to.deep.equal([]);
        expect(warningShown()).to.equal(true);
    });

    it('any other environment: no warning, and a production one before it is cleared', () => {
        const { errors, warningShown, sendEnvironment } = load();
        sendEnvironment(environment({ environmentType: 'production' }));
        sendEnvironment(environment({ environmentType: 'development' }));
        expect(errors).to.deep.equal([]);
        expect(warningShown()).to.equal(false);
    });
});
