// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A Console View keeps its saved searches (dbmn-saved-searches, James 2026-11-23: "that saved
 * search should be everywhere where we have a search box… console"): the schema an endpoint's
 * Views go through on export and import keeps them, and refuses what the component never makes.
 */
import { expect } from 'chai';
import { ConsoleViewSchema } from '../../../data-loading/zod-schemas';

const view = { name: 'Orders', rowBasis: 'root', columns: [{ id: 'sku', source: 'current' as const }] };

describe('Console View saved searches', () => {
    it('are kept with the View', () => {
        const searches = [{ name: 'Late orders', text: '@status=late' }, { name: 'Big', text: '@qty>40' }];
        const parsed = ConsoleViewSchema.parse({ ...view, searches });
        expect(parsed.searches).to.deep.equal(searches);
    });
    it('a View without them is as before', () => {
        expect(ConsoleViewSchema.parse(view).searches).to.equal(undefined);
    });
    it('a blank name or text, a name over 30 characters, or more than 50 are refused', () => {
        expect(ConsoleViewSchema.safeParse({ ...view, searches: [{ name: '', text: 'x' }] }).success).to.equal(false);
        expect(ConsoleViewSchema.safeParse({ ...view, searches: [{ name: 'a', text: '' }] }).success).to.equal(false);
        expect(ConsoleViewSchema.safeParse({ ...view, searches: [{ name: 'x'.repeat(31), text: 'x' }] }).success).to.equal(false);
        const many = Array.from({ length: 51 }, (_v, i) => ({ name: `S${i}`, text: `t${i}` }));
        expect(ConsoleViewSchema.safeParse({ ...view, searches: many }).success).to.equal(false);
    });
});
