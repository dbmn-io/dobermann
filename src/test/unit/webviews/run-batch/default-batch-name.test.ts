// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';

/**
 * A batch's default name (dt-batch-config.js): where its rows came from and when. James,
 * 2026-11-12: every run was named "batch_2026-11-12", because by Review the source is the grid
 * and the file's name was never looked at.
 */
const SCRIPT = path.resolve(__dirname, '../../../../../src/webviews/shared/dt-batch-config.js');
const AT = new Date(2026, 10, 12, 16, 30);

function load(state: Record<string, unknown>, opts: { chained?: boolean } = {}) {
    const dom = new JSDOM('<!DOCTYPE html><body data-endpoint-name="Bulk Inventory Upload"><input id="batchNameInput"></body>', { runScripts: 'outside-only' });
    const w = dom.window as any;
    if (opts.chained) w.ChainPreload = { isChained: () => true };
    w.eval(fs.readFileSync(SCRIPT, 'utf8'));
    const csvState: Record<string, unknown> = { ...state };
    w.DTBatchConfig.init(csvState, () => ({ postMessage: () => undefined }));
    return { w, csvState };
}

describe('Run Batch: the default batch name', () => {
    it('a file: its name and the time, though by Review the source is the grid', () => {
        const { w } = load({ sourceType: 'grid', originalSourceType: 'file', sourceFileName: 'inventory-67k.csv' });
        expect(w.DTBatchConfig.generateDefaultBatchName(AT)).to.equal('inventory-67k 12 Nov 16:30');
    });

    it('a workbook: its sheet beside it, unless it is the only Sheet1', () => {
        expect(load({ originalSourceType: 'file', sourceFileName: 'replenishment.xlsx', sourceSheetName: 'Orders' }).w.DTBatchConfig.generateDefaultBatchName(AT)).to.equal('replenishment (Orders) 12 Nov 16:30');
        expect(load({ originalSourceType: 'file', sourceFileName: 'replenishment.xlsx', sourceSheetName: 'Sheet1' }).w.DTBatchConfig.generateDefaultBatchName(AT)).to.equal('replenishment 12 Nov 16:30');
    });

    it('pasted, typed or chained rows: the endpoint\'s name and the time', () => {
        expect(load({ sourceType: 'grid', originalSourceType: 'paste' }).w.DTBatchConfig.generateDefaultBatchName(AT)).to.equal('Bulk Inventory Upload 12 Nov 16:30');
        expect(load({ sourceType: 'grid' }).w.DTBatchConfig.generateDefaultBatchName(AT)).to.equal('Bulk Inventory Upload 12 Nov 16:30');
        expect(load({ originalSourceType: 'file', sourceFileName: 'x.csv' }, { chained: true }).w.DTBatchConfig.generateDefaultBatchName(AT)).to.equal('Bulk Inventory Upload 12 Nov 16:30');
    });

    it('named in Review\'s Name: kept as typed (spaces tidied); emptied, the default comes back; the tab says it', () => {
        const { w, csvState } = load({ originalSourceType: 'file', sourceFileName: 'inventory-67k.csv' });
        const told: string[] = [];
        w.dbmnSetTabName = (name: string) => told.push(name);
        const input = w.document.getElementById('batchNameInput');
        // The default, shown in the box and on the tab as the steps go
        w.DTBatchConfig.refreshBatchName();
        expect(input.value).to.match(/^inventory-67k /);
        expect(told[told.length - 1]).to.equal(input.value);
        input.value = '  Stock take:   Brisbane  ';
        w.DTBatchConfig.updateBatchName();
        expect(csvState.batchName).to.equal('Stock take: Brisbane');
        expect(csvState.batchNameEdited).to.equal(true);
        expect(told[told.length - 1]).to.equal('Stock take: Brisbane');
        // Named by the user: the steps going on no longer change it
        w.DTBatchConfig.refreshBatchName();
        expect(csvState.batchName).to.equal('Stock take: Brisbane');
        input.value = '';
        w.DTBatchConfig.updateBatchName();
        expect(csvState.batchNameEdited).to.equal(false);
        expect(csvState.batchName).to.match(/^inventory-67k /);
    });
});
