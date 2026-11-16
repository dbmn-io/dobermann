// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #304: a split child must know which input row it came from, or the
 * Input tab's Result (and the Raw card's input rows) fall back to the split
 * parent and show "Not processed" for rows that actually failed.
 *
 * Issue #321: runs in test:core — the splitter writes child request files with Node fs, into
 * a temp folder here.
 */

import { expect } from 'chai';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { stub } from 'sinon';
import { TransactionSplitter } from '../../../services/transaction-preparation/helpers/transaction-splitter.helper';
import { createMockLogger } from '../../helpers/logging/mock-logger';
import { listRunFiles, readRunFile } from '../../../services/run-content/run-content-store';

describe('Split array errors — each child keeps its input row (Issue #304)', () => {
    let stored: any[];
    let runDir: string;

    const split = async (parent: Record<string, unknown>, elements: unknown[]) => {
        stored = [];
        const deps: any = {
            transactionCreator: { createTransaction: stub() },
            executionMetadataService: {
                getExecution: stub().resolves({ id: 'parent', executionType: 'batch_member', requestFile: path.join(runDir, 'transaction-010.json'), status: 'error', ...parent }),
                storeBatchExecution: stub().callsFake(async (m: unknown) => { stored.push(m); return { success: true }; }),
                updateExecution: stub().resolves()
            }
        };
        const splitter = new TransactionSplitter(deps, createMockLogger());
        stub(splitter, 'canSplitTransaction').resolves(true);
        stub(splitter as any, 'readArrayDataWithFormat').resolves({ arrayData: elements, wrapperKey: null });
        stub(splitter as any, 'markOriginalAsSplit').resolves();
        await splitter.splitArrayTransaction('parent', 'batch-1');
        return stored;
    };

    beforeEach(async () => {
        runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dbmn-split-'));
    });
    afterEach(async () => {
        await fs.rm(runDir, { recursive: true, force: true });
    });

    it('writes one request file per element, next to the original, in its format', async () => {
        await split({ rowStart: 1, rows: '2' }, [{ sku: 'A' }, { sku: 'B' }]);
        // #358: the run folder holds one content archive; the request files are named inside it
        const files = listRunFiles(runDir).sort();
        expect(files).to.deep.equal(['transaction-010-001.json', 'transaction-010-002.json']);
        expect(JSON.parse(readRunFile(path.join(runDir, files[1])))).to.deep.equal([{ sku: 'B' }]);
    });

    it('one row per element: child n sends input row rowStart + n', async () => {
        const children = await split({ rowStart: 901, rows: '3' }, [{ sku: 'A' }, { sku: 'B' }, { sku: 'C' }]);
        expect(children.map(c => [c.rowStart, c.rows])).to.deep.equal([[901, '1'], [902, '1'], [903, '1']]);
    });

    it('elements built from several rows each (nested): no row is claimed', async () => {
        const children = await split({ rowStart: 1, rows: '7' }, [{ sku: 'A' }, { sku: 'B' }]);
        expect(children.map(c => c.rowStart)).to.deep.equal([undefined, undefined]);
    });

    it('a parent with no row range gives its children none', async () => {
        const children = await split({ rows: '2' }, [{ sku: 'A' }, { sku: 'B' }]);
        expect(children.map(c => c.rowStart)).to.deep.equal([undefined, undefined]);
    });
});
