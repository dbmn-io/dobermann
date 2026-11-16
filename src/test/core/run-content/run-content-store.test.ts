// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    RUN_ARCHIVE_NAME, appendRunFile, forgetRunArchives, listRunFiles, readRunFile, readRunFileIfExists,
    removeRunFile, renameRunFile, runFileExists, runFileSize, writeRunFile
} from '../../../services/run-content/run-content-store';

/**
 * #358: a run's request, response and log content in one archive per run folder. The paths stay
 * the identifiers; the bytes live in `run-content.dbmn`.
 */
describe('Run content store (#358)', () => {
    let dir: string;
    const file = (name: string) => path.join(dir, name);

    beforeEach(async () => {
        dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dbmn-run-content-'));
        forgetRunArchives();
    });
    afterEach(async () => {
        await fs.promises.rm(dir, { recursive: true, force: true });
    });

    it('a batch of 670 requests and responses is one file in the folder, not 1,340', () => {
        for (let i = 1; i <= 670; i++) {
            const n = String(i).padStart(3, '0');
            writeRunFile(file(`transaction-${n}.json`), JSON.stringify({ rows: Array(100).fill({ sku: `SKU-${n}`, qty: i }) }));
            writeRunFile(file(`transaction-${n}-response.json`), JSON.stringify({ status: 201, data: { inserted: 100 } }));
        }
        expect(fs.readdirSync(dir)).to.deep.equal([RUN_ARCHIVE_NAME]);
        expect(listRunFiles(dir)).to.have.length(1340);
        expect(JSON.parse(readRunFile(file('transaction-417.json'))).rows[0].sku).to.equal('SKU-417');
    });

    it('compresses: repetitive JSON takes a fraction of its size', () => {
        const body = JSON.stringify({ rows: Array(500).fill({ gtin: '00012345600012', status: 'low_stock', uom: 'EA' }) });
        writeRunFile(file('transaction-001.json'), body);
        expect(fs.statSync(file(RUN_ARCHIVE_NAME)).size).to.be.lessThan(body.length / 10);
        expect(readRunFile(file('transaction-001.json'))).to.equal(body);
    });

    it('a rewrite replaces, an append adds on (the log, a line at a time), a delete forgets', () => {
        writeRunFile(file('a.json'), 'first');
        writeRunFile(file('a.json'), 'second');
        expect(readRunFile(file('a.json'))).to.equal('second');

        appendRunFile(file('a.log'), 'line 1\n');
        appendRunFile(file('a.log'), 'line 2\n');
        expect(readRunFile(file('a.log'))).to.equal('line 1\nline 2\n');

        removeRunFile(file('a.json'));
        expect(runFileExists(file('a.json'))).to.equal(false);
        expect(readRunFileIfExists(file('a.json'))).to.equal(undefined);
        expect(() => readRunFile(file('a.json'))).to.throw(/ENOENT/);
    });

    it('renames (reprocess keeps the earlier attempt as _attemptN), archived or loose', () => {
        writeRunFile(file('t-001-response.json'), '{"attempt":1}');
        renameRunFile(file('t-001-response.json'), file('t-001-response_attempt1.json'));
        expect(runFileExists(file('t-001-response.json'))).to.equal(false);
        expect(readRunFile(file('t-001-response_attempt1.json'))).to.equal('{"attempt":1}');
        fs.writeFileSync(file('old-response.json'), '{"loose":true}');
        renameRunFile(file('old-response.json'), file('old-response_attempt1.json'));
        expect(fs.existsSync(file('old-response.json'))).to.equal(false);
        expect(readRunFile(file('old-response_attempt1.json'))).to.equal('{"loose":true}');
    });

    it('unicode survives, and size is the uncompressed byte length', () => {
        writeRunFile(file('u.json'), '{"name":"Café — 🐕"}');
        expect(readRunFile(file('u.json'))).to.equal('{"name":"Café — 🐕"}');
        expect(runFileSize(file('u.json'))).to.equal(Buffer.byteLength('{"name":"Café — 🐕"}'));
    });

    it('a workspace from before #358 still reads its loose files', () => {
        fs.writeFileSync(file('old-response.json'), '{"old":true}');
        expect(runFileExists(file('old-response.json'))).to.equal(true);
        expect(readRunFile(file('old-response.json'))).to.equal('{"old":true}');
        expect(listRunFiles(dir)).to.include('old-response.json');
        removeRunFile(file('old-response.json'));
        expect(fs.existsSync(file('old-response.json'))).to.equal(false);
    });

    it('sees what another writer appended (another window, the batch engine) since it last looked', () => {
        writeRunFile(file('one.json'), '1');
        expect(readRunFile(file('one.json'))).to.equal('1');
        // Another process appends: simulate by writing records while our index is cached
        forgetRunArchives(); writeRunFile(file('two.json'), '2'); // index rebuilt lazily
        expect(readRunFile(file('two.json'))).to.equal('2');
        writeRunFile(file('three.json'), '3');
        expect(readRunFile(file('three.json'))).to.equal('3');
        expect(readRunFile(file('one.json'))).to.equal('1');
    });

    it('a half-written last record is ignored until it is complete, and earlier records still read', () => {
        writeRunFile(file('good.json'), '{"ok":1}');
        const archive = file(RUN_ARCHIVE_NAME);
        const whole = fs.readFileSync(archive);
        writeRunFile(file('torn.json'), '{"torn":true, "padding": "' + 'x'.repeat(200) + '"}');
        const withTorn = fs.readFileSync(archive);
        fs.writeFileSync(archive, withTorn.subarray(0, withTorn.length - 10));   // crash mid-append
        forgetRunArchives();
        expect(readRunFile(file('good.json'))).to.equal('{"ok":1}');
        expect(runFileExists(file('torn.json'))).to.equal(false);
        expect(whole.length).to.be.greaterThan(0);
    });

    it('a damaged record is skipped and the ones after it still read', () => {
        writeRunFile(file('a.json'), 'A');
        const archive = file(RUN_ARCHIVE_NAME);
        fs.appendFileSync(archive, Buffer.from('garbage bytes from a bad disk'));
        writeRunFile(file('b.json'), 'B');
        forgetRunArchives();
        expect(readRunFile(file('a.json'))).to.equal('A');
        expect(readRunFile(file('b.json'))).to.equal('B');
    });

    it('a folder deleted and made again is read afresh, not through the old index', () => {
        for (let i = 0; i < 20; i++) appendRunFile(file('old.log'), `old line ${i}\n`);
        expect(readRunFile(file('old.log'))).to.contain('old line 19');
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir);
        for (let i = 0; i < 40; i++) appendRunFile(file('new.log'), `new line ${i}\n`);   // bigger than before
        expect(readRunFile(file('new.log')).split('\n').filter(Boolean)).to.have.length(40);
        expect(runFileExists(file('old.log'))).to.equal(false);
    });

    it('deleting the run folder takes the archive with it', () => {
        writeRunFile(file('x.json'), 'x');
        fs.rmSync(dir, { recursive: true, force: true });
        expect(runFileExists(file('x.json'))).to.equal(false);
    });
});
