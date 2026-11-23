// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * `lu` in a request template (James, 2026-11-23): `{{uom | lu:uom:tms>wms}}` looks the value up in
 * lookup table uom (TMS in, WMS out); `{{uom | lu:uom:wms}}` checks it is in WMS. Blank, not there, or
 * a blank To: a failure, said in words. There twice: the first row's (one rule with Translate values).
 */
import { expect } from 'chai';
import { extractVariablesFromJsonTemplate } from '../../../data-loading/json-template-parser';
import { TemplateParser } from '../../../data-loading/template-parser';
import { parseModifiers } from '../../../data-loading/modifier-parser';
import { applyModifiers } from '../../../data-loading/modifier-executor';
import { applyLookup, setTemplateLookupTables, templateUsesLookups } from '../../../data-loading/template-lookups';
import type { LookupTable } from '../../../services/lookup-tables/lookup-tables';

const UOM: LookupTable = {
    id: 'lkp-uom', name: 'UOM', updatedAt: '2026-11-23T00:00:00Z',
    columns: [{ id: 'c1', name: 'WMS' }, { id: 'c2', name: 'ERP' }, { id: 'c3', name: 'TMS' }, { id: 'c4', name: 'OMS' }],
    rows: [
        { c1: 'EA', c2: 'Each', c3: 'EA', c4: 'UNIT' },
        { c1: 'ST', c2: 'Set', c3: 'SE', c4: 'Group' },
        { c1: 'CS', c2: 'Case', c3: 'CA', c4: '' },
        { c1: 'BX', c2: 'Box', c3: 'CA', c4: 'BOX' }
    ]
};

describe('Template lu: a value looked up in a lookup table', () => {
    beforeEach(() => setTemplateLookupTables([UOM]));
    afterEach(() => setTemplateLookupTables([]));

    it('reads lu:table:from>to and lu:table:column as a modifier, and says what a broken one lacks', () => {
        expect(parseModifiers('lu:uom:tms>wms', 'string').modifiers).to.deep.equal([{ kind: 'lookup', type: 'lookup', table: 'uom', from: 'tms', to: 'wms' }]);
        expect(parseModifiers('upper|lu:uom:wms', 'string').modifiers[1]).to.deep.equal({ kind: 'lookup', type: 'lookup', table: 'uom', from: 'wms' });
        expect(parseModifiers('lu:uom', 'string').errors[0]).to.match(/^lu needs a table and a column/);
        expect(parseModifiers('lu:uom:tms>', 'string').errors[0]).to.match(/^lu needs/);
    });

    it('looks a value up: From in, To out; a table and its columns by name any case; only checked without a To', () => {
        expect(applyLookup('SE', { type: 'lookup', table: 'uom', from: 'tms', to: 'wms' })).to.deep.equal({ success: true, value: 'ST' });
        expect(applyLookup('Each', { type: 'lookup', table: 'UOM', from: 'ERP', to: 'oms' })).to.deep.equal({ success: true, value: 'UNIT' });
        expect(applyLookup('EA', { type: 'lookup', table: 'uom', from: 'wms' })).to.deep.equal({ success: true, value: 'EA' });
    });

    it('fails, in words: blank, not there, a blank To, no such table or column; there twice, the first row\'s', () => {
        const error = (value: string, from: string, to?: string, table = 'uom') => applyLookup(value, { type: 'lookup', table, from, to }).error;
        expect(error('', 'tms', 'wms')).to.equal("needs a value from UOM's TMS column");
        expect(error('DZ', 'tms', 'wms')).to.equal("DZ isn't in UOM's TMS column");
        expect(error('ea', 'wms')).to.equal("ea isn't in UOM's WMS column", 'case counts, as in Translate values');
        expect(applyLookup('CA', { type: 'lookup', table: 'uom', from: 'tms', to: 'wms' })).to.deep.equal({ success: true, value: 'CS' });
        expect(error('Case', 'erp', 'oms')).to.equal("Case's OMS in UOM is blank");
        expect(error('EA', 'tms', 'wms', 'units')).to.equal("there's no lookup table called units");
        expect(error('EA', 'nope', 'wms')).to.equal('UOM has no column called nope');
        expect(error('EA', 'tms', 'nope')).to.equal('UOM has no column called nope');
    });

    it('in the modifier chain: trimmed, upper first if asked, then looked up', () => {
        const run = (value: string, chain: string) => applyModifiers(value, 'string', parseModifiers(chain, 'string'));
        expect(run(' se ', 'upper|lu:uom:tms>wms')).to.deep.equal({ success: true, value: 'ST' });
        expect(run('DZ', 'lu:uom:tms>wms').success).to.equal(false);
    });

    it('{{uom | lu:…}}: the name before the pipe, a text value, the lu after it', () => {
        const { variables, errors } = extractVariablesFromJsonTemplate('{ "uom": "{{uom | lu:uom:tms>wms}}", "qty": "{{qty:number}}" }');
        expect(errors).to.deep.equal([]);
        expect(variables.map(v => [v.resolvedName, v.dataType, v.formatModifier])).to.deep.equal([['uom', 'string', 'lu:uom:tms>wms'], ['qty', 'number', undefined]]);
        // A type, then a pipe with spaces around it
        const typed = extractVariablesFromJsonTemplate('{ "uom": "{{uom:string | lu:uom:wms}}" }');
        expect(typed.errors).to.deep.equal([]);
        expect(typed.variables.map(v => [v.resolvedName, v.dataType, v.formatModifier])).to.deep.equal([['uom', 'string', 'lu:uom:wms']]);
        expect(templateUsesLookups('{{uom | lu:uom:wms}}')).to.equal(true);
        expect(templateUsesLookups('{{uom:string|upper}}')).to.equal(false);
    });

    it('fills a row: the looked-up value sent; a value not in the table stops the row, saying why', async () => {
        const parser = new TemplateParser();
        const template = '{ "uom": "{{uom | lu:uom:tms>wms}}", "check": "{{oms | lu:uom:oms}}" }';
        const ok = await parser.processTemplateAsync(template, { uom: 'SE', oms: 'UNIT' });
        expect(ok.success).to.equal(true);
        expect(JSON.parse(ok.processedJson as string)).to.deep.equal({ uom: 'ST', check: 'UNIT' });
        const bad = await parser.processTemplateAsync(template, { uom: 'DZ', oms: 'UNIT' });
        expect(bad.success).to.equal(false);
        expect(bad.error).to.equal("uom: DZ isn't in UOM's TMS column");
    });
});
