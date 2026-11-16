// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #419: TELEMETRY.md lists every field the telemetry RPC sends. This fails when the code
 * (telemetry-payload.ts) and the document disagree, in either direction.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { telemetryEventsPayload } from '../../../../services/dbmn-auth/telemetry-payload';

const document = fs.readFileSync(path.resolve(__dirname, '../../../../../TELEMETRY.md'), 'utf8');

/** The backticked field names in the table under the heading that names the RPC. */
function documentedFields(rpc: string): string[] {
    const start = document.indexOf(`\`${rpc}\``);
    expect(start, `TELEMETRY.md names ${rpc}`).to.be.greaterThan(-1);
    const section = document.slice(start, document.indexOf('\n## ', start + 1) === -1 ? undefined : document.indexOf('\n## ', start + 1));
    return [...section.matchAll(/^\| `([a-z_]+)` \|/gm)].map(m => m[1]);
}

describe('#419 TELEMETRY.md matches what is sent', () => {
    it('upsert_telemetry_events: every field, no more', () => {
        const row = telemetryEventsPayload([{
            eventDate: '2026-10-29', apiCalls: 1, batchRuns: 1, batchRecords: 2, batchSuccesses: 2,
            batchFailures: 0, exportRecords: 0, importRecords: 0, executionTimeMs: 5, featuresUsed: {}
        }], { extensionVersion: '0.4.0', vscodeVersion: '1.0.0', osPlatform: 'linux' })[0];
        expect(Object.keys(row).sort()).to.deep.equal(documentedFields('upsert_telemetry_events').sort());
    });

    it('0.4.0: no environment address and no per-endpoint usage, in the code or the page', () => {
        const row = telemetryEventsPayload([{
            eventDate: '2026-10-29', apiCalls: 1, batchRuns: 0, batchRecords: 0, batchSuccesses: 0,
            batchFailures: 0, exportRecords: 0, importRecords: 0, executionTimeMs: 0, featuresUsed: {}
        }], { extensionVersion: '0.4.0', vscodeVersion: '1.0.0', osPlatform: 'linux' })[0];
        expect(row).to.not.have.property('environment_base_url');
        expect(document).to.not.include('upsert_telemetry_endpoint_usage');
        expect(document).to.not.match(/^\| `(environment_base_url|method|path_template)` \|/m);
    });

    it('says where the switch is and that nothing goes while signed out', () => {
        expect(document).to.include('dbmn.telemetry.enabled');
        expect(document).to.include('telemetry.telemetryLevel');
        expect(document).to.match(/Signed out, nothing\s+is sent/);
    });
});
