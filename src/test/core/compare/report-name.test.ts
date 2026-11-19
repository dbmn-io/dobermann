// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import * as assert from 'assert';
import { freeReportName, reportNameProblem } from '../../../services/compare/report-name';

describe('A report\'s name', () => {
    const saved: Record<string, unknown> = {
        queries: [{ id: 'qry-1', name: 'Low stock' }],
        compares: [{ id: 'cmp-1', name: 'List Inventory' }, { id: 'cmp-2' }],
    };
    const state = { get: <T>(key: string): T => saved[key] as T };

    it('is no other report\'s, query or compare, whatever the capitals', () => {
        assert.strictEqual(reportNameProblem(state, 'qry-1', 'Bins by aisle'), '');
        assert.strictEqual(reportNameProblem(state, 'qry-1', 'Low stock'), '', 'its own name');
        assert.match(reportNameProblem(state, 'cmp-1', 'low STOCK'), /already called/);
        assert.match(reportNameProblem(state, 'qry-1', 'list inventory'), /already called/);
    });
    it('is short, and is not empty', () => {
        assert.match(reportNameProblem(state, 'qry-1', 'x'.repeat(31)), /up to 30/);
        assert.match(reportNameProblem(state, 'qry-1', ''), /needs a name/);
    });
    it('a default is cut to length and numbered when it is taken', () => {
        assert.strictEqual(freeReportName(state, 'Bins'), 'Bins');
        assert.strictEqual(freeReportName(state, 'List Inventory'), 'List Inventory 2');
        assert.strictEqual(freeReportName(state, 'List Inventory', 'cmp-1'), 'List Inventory', 'its own name is free to it');
        assert.strictEqual(freeReportName(state, 'A very long endpoint name that goes on and on').length, 30);
    });
});
