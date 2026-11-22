// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #298: a Compare side is a saved result shaped by a Console View, built with the
 * Console's own table builder, so it holds the rows the Console shows.
 */
import { expect } from 'chai';
import { buildCompareSide, CompareView } from '../../../services/compare/compare-side';

const response = (status: string, items: Array<Record<string, unknown>>) => ({
    httpStatus: status === 'completed' ? 200 : 500,
    status,
    data: { page: 1, items },
});

// "Dimensions": one row per item, the page number from the response as an ancestor column.
const view: CompareView = {
    name: 'Dimensions',
    rowBasis: 'data.items',
    columns: [
        { id: 'data.page', source: 'ancestor' },
        { id: 'data.items.id', source: 'current' },
        { id: 'data.items.itemCode', source: 'current' },
        { id: 'data.items.height', source: 'current' },
    ],
};

describe('Compare side', () => {
    const test = [
        response('completed', [{ id: 1, itemCode: 'ITM-1', height: 400 }, { id: 2, itemCode: 'ITM-2', height: 400 }]),
        response('error', [{ id: 3, itemCode: 'ITM-ERR', height: 1 }]),
    ];
    const prod = [
        response('completed', [{ id: 91, itemCode: 'ITM-2', height: 410 }, { id: 92, itemCode: 'ITM-1', height: 400 }]),
    ];

    it('holds the View\'s rows and columns for the completed responses only', () => {
        const side = buildCompareSide(test, view);
        expect(side).to.include({ responseCount: 2, completedCount: 1 });
        expect(side.rows).to.have.lengthOf(2);
        expect(side.rows[0]).to.deep.equal({
            'data.page': 1, 'data.items.id': 1, 'data.items.itemCode': 'ITM-1', 'data.items.height': 400,
        });
        expect(side.columns.map(c => c.name)).to.deep.equal(['page', 'id', 'itemCode', 'height']);
    });
});
