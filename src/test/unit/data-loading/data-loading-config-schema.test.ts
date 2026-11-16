// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { DataLoadingConfigSchema, createDefaultDataLoadingConfig } from '../../../data-loading/zod-schemas';

// The endpoint editor saves the zod-PARSED dataLoadingConfig, which drops undeclared keys.
// A Run Batch field missing from the schema would be wiped by the next editor save.
describe('DataLoadingConfigSchema', () => {
    it('keeps the remembered Run Batch mapping (#307)', () => {
        const parsed = DataLoadingConfigSchema.parse({
            ...createDefaultDataLoadingConfig(),
            columnMappings: { buyerGln: 'location.gln', orderedQty: 'reorderQty' }
        });
        expect(parsed.columnMappings).to.deep.equal({ buyerGln: 'location.gln', orderedQty: 'reorderQty' });
    });

    it('a config from before #307 still parses, with no mapping remembered', () => {
        const parsed = DataLoadingConfigSchema.parse(createDefaultDataLoadingConfig());
        expect(parsed.columnMappings).to.equal(undefined);
    });

    it('a mapping value must be a column name', () => {
        expect(DataLoadingConfigSchema.safeParse({ ...createDefaultDataLoadingConfig(), columnMappings: { buyerGln: 42 } }).success).to.equal(false);
    });
});
