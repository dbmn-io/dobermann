// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * GitHub Issue #312: the Console host streams a large batch in chunks.
 * extractResponses is the per-file reader it calls per chunk; its rows must be
 * exactly what extractRawConsoleData used to build inline, in file order, with
 * an unreadable file still counted (as an error row) so nothing goes missing.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ResponseDataExtractor } from '../../../../services/console/response-data-extractor';

describe('ResponseDataExtractor.extractResponses (GitHub Issue #312)', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbmn-312-'));
        for (let i = 1; i <= 3; i++) {
            fs.writeFileSync(path.join(dir, `exec_${i}-response.json`), JSON.stringify({
                httpStatus: i === 2 ? 500 : 200, duration: 10 * i, headers: {}, data: { page: i }
            }));
        }
    });

    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const file = (i: number) => path.join(dir, `exec_${i}-response.json`);

    it('returns one row per file, in order, carrying the database status', async () => {
        const rows = await new ResponseDataExtractor().extractResponses([file(1), file(2), file(3)], { [file(2)]: 'error' });
        expect(rows.map(r => (r.data as { page: number }).page)).to.deep.equal([1, 2, 3]);
        expect(rows[1].status).to.equal('error');
        expect(rows[1].metadata.status).to.equal('error');
        expect(rows[0].metadata.sourceFile).to.equal('exec_1-response.json');
    });

    it('an unreadable file is an error row, not a hole', async () => {
        const rows = await new ResponseDataExtractor().extractResponses([file(1), path.join(dir, 'missing-response.json')]);
        expect(rows).to.have.length(2);
        expect(rows[1].httpStatus).to.equal('ERROR');
        expect((rows[1].data as { type: string }).type).to.equal('EXTRACTION_ERROR');
    });

    it('matches what extractRawConsoleData builds for the same files', async () => {
        const x = new ResponseDataExtractor();
        const files = [file(1), file(2), file(3)];
        const whole = await x.extractRawConsoleData(files, undefined, undefined, undefined, 'b', 'b', {});
        const chunked = [...await x.extractResponses(files.slice(0, 2), {}), ...await x.extractResponses(files.slice(2), {})];
        expect(chunked).to.deep.equal(whole.responses);
    });
});
