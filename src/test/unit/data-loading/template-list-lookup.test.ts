// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The list and lookup template types (James, 2026-11-23, in place of the `lu` function):
 * `{{uom:list|uom:wms}}` checks the value is in lookup table uom's WMS column; `{{uom:list|uom}}`
 * the same for a table of one column; `{{uom:lookup|uom:tms>wms}}` finds it in TMS and sends WMS.
 * Blank, not there, or a blank To: a failure, said in words. There more than once: the first row's.
 */
import { expect } from 'chai';
import { extractVariablesFromJsonTemplate } from '../../../data-loading/json-template-parser';
import { TemplateParser } from '../../../data-loading/template-parser';
import { parseModifiers } from '../../../data-loading/modifier-parser';
import { applyModifiers } from '../../../data-loading/modifier-executor';
import { applyLookup, lookupTablesNamed, lookupValuesOf, setTemplateLookupTables, templateUsesLookups } from '../../../data-loading/template-lookups';
import { ParameterCollectionService } from '../../../services/parameter/parameter-collection.service';
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
const SITES: LookupTable = { id: 'lkp-sites', name: 'Sites', updatedAt: '', columns: [{ id: 's', name: 'site' }], rows: [{ s: 'DC01' }, { s: 'DC02' }] };
const lookup = (table: string, from: string, to?: string) => ({ type: 'lookup' as const, table, from, to });

describe('Template list and lookup types: a value in a lookup table', () => {
    beforeEach(() => setTemplateLookupTables([UOM, SITES]));
    afterEach(() => setTemplateLookupTables([]));

    it('reads {{x:list|table:column}}, {{x:list|table}} and {{x:lookup|table:from>to}}: text, with the table as the chain\'s first step', () => {
        const { variables, errors } = extractVariablesFromJsonTemplate('{ "a": "{{uom:list|uom:wms}}", "b": "{{site:list|sites}}", "c": "{{tms:lookup|uom:tms>wms|ifblank:\'EA\'}}", "d": "{{qty:number|>0}}" }');
        expect(errors).to.deep.equal([]);
        expect(variables.map(v => [v.resolvedName, v.dataType, v.formatModifier])).to.deep.equal([
            ['uom', 'string', 'list:uom:wms'], ['site', 'string', 'list:sites'], ['tms', 'string', "lookup:uom:tms>wms|ifblank:'EA'"], ['qty', 'number', '>0']
        ]);
        expect(parseModifiers('list:uom:wms', 'string').modifiers).to.deep.equal([{ kind: 'lookup', type: 'lookup', table: 'uom', from: 'wms' }]);
        expect(parseModifiers('lookup:uom:tms>wms', 'string').modifiers).to.deep.equal([{ kind: 'lookup', ...lookup('uom', 'tms', 'wms') }]);
    });

    it('says what is missing: a list or lookup with no table; a lookup with one column; an old lu', () => {
        expect(extractVariablesFromJsonTemplate('{ "a": "{{uom:list}}" }').errors[0].message).to.match(/^list needs a table/);
        expect(parseModifiers('lookup:uom:tms', 'string').errors[0]).to.match(/^lookup needs a table and two columns/);
        expect(parseModifiers('lu:uom:tms>wms', 'string').errors[0]).to.match(/^lu is now a type/);
    });

    it('looks a value up: From in, To out; a table and its columns by name any case; a list only checks', () => {
        expect(applyLookup('SE', lookup('uom', 'tms', 'wms'))).to.deep.equal({ success: true, value: 'ST' });
        expect(applyLookup('Each', lookup('UOM', 'ERP', 'oms'))).to.deep.equal({ success: true, value: 'UNIT' });
        expect(applyLookup('EA', lookup('uom', 'wms'))).to.deep.equal({ success: true, value: 'EA' });
    });

    it('{{x:list|table}}: a table of one column needs none named; one of more is said, never guessed', () => {
        expect(applyLookup('DC02', lookup('sites', ''))).to.deep.equal({ success: true, value: 'DC02' });
        expect(applyLookup('DC09', lookup('sites', '')).error).to.equal("DC09 isn't in Sites's site column");
        expect(applyLookup('EA', lookup('uom', '')).error).to.equal('UOM has more than one column: say which, e.g. uom:wms');
    });

    it('fails, in words: blank, not there, a blank To, no such table or column', () => {
        const error = (value: string, from: string, to?: string, table = 'uom') => applyLookup(value, lookup(table, from, to)).error;
        expect(error('', 'tms', 'wms')).to.equal("needs a value from UOM's TMS column");
        expect(error('DZ', 'tms', 'wms')).to.equal("DZ isn't in UOM's TMS column");
        expect(error('ea', 'wms')).to.equal("ea isn't in UOM's WMS column", 'case counts, as in Translate values');
        expect(error('Case', 'erp', 'oms')).to.equal("Case's OMS in UOM is blank");
        expect(error('EA', 'tms', 'wms', 'units')).to.equal("there's no lookup table called units");
        expect(error('EA', 'nope', 'wms')).to.equal('UOM has no column called nope');
    });

    // The manager for James, 2026-11-23: "if we're looking up, we pick the first one"
    it('a value in the From column more than once takes the first row\'s, top to bottom; a list is not bothered', () => {
        expect(applyLookup('CA', lookup('uom', 'tms', 'wms'))).to.deep.equal({ success: true, value: 'CS' });
        expect(applyLookup('CA', lookup('uom', 'tms'))).to.deep.equal({ success: true, value: 'CA' });
    });

    it('in the chain: trimmed, upper if asked, a blank filled by ifblank, then looked up', () => {
        const run = (value: string, chain: string) => applyModifiers(value, 'string', parseModifiers(chain, 'string'));
        expect(run(' se ', 'upper|lookup:uom:tms>wms')).to.deep.equal({ success: true, value: 'ST' });
        expect(run('', "lookup:uom:tms>wms|ifblank:'EA'")).to.deep.equal({ success: true, value: 'EA' });
        expect(run('DZ', 'lookup:uom:tms>wms').success).to.equal(false);
    });

    it('which templates use them, and the tables they name', () => {
        expect(templateUsesLookups('{{uom:list|uom:wms}}')).to.equal(true);
        expect(templateUsesLookups('{{uom : lookup | uom:tms>wms}}')).to.equal(true);
        expect(templateUsesLookups('{{uom:string|upper}}')).to.equal(false);
        expect([...lookupTablesNamed('{ "a": "{{uom:list|UOM:wms}}", "b": "{{s:list|sites}}", "c": "{{t:lookup|uom:tms>wms}}" }')]).to.deep.equal(['uom', 'sites']);
    });

    it('fills a row: the looked-up value sent; a value not in the table stops the row, saying why', async () => {
        const parser = new TemplateParser();
        const template = '{ "uom": "{{uom:lookup|uom:tms>wms}}", "check": "{{oms:list|uom:oms}}", "site": "{{site:list|sites}}" }';
        const ok = await parser.processTemplateAsync(template, { uom: 'SE', oms: 'UNIT', site: 'DC01' });
        expect(ok.success).to.equal(true);
        expect(JSON.parse(ok.processedJson as string)).to.deep.equal({ uom: 'ST', check: 'UNIT', site: 'DC01' });
        const bad = await parser.processTemplateAsync(template, { uom: 'DZ', oms: 'UNIT', site: 'DC01' });
        expect(bad.success).to.equal(false);
        expect(bad.error).to.equal("uom: DZ isn't in UOM's TMS column");
    });

    // James, 2026-11-23: "we actually give an options list" in the Run dialog
    it('the Run dialog offers the valid values, each once, whichever way the template was read', () => {
        expect(lookupValuesOf(lookup('uom', 'tms'))).to.deep.equal(['EA', 'SE', 'CA']);
        expect(lookupValuesOf(lookup('sites', ''))).to.deep.equal(['DC01', 'DC02']);
        expect(lookupValuesOf(lookup('uom', ''))).to.deep.equal([]);
        const quiet = { debug() {}, info() {}, warn() {}, error() {}, trace() {}, show() {}, clear() {}, dispose() {} };
        const service = new ParameterCollectionService(quiet as never) as unknown as { buildModalField(v: unknown): { type: string; suggestions?: string[] } };
        // (the text scan's form, then a JSON body's)
        expect(service.buildModalField({ name: 'uom', isAutoGenerated: false, typeHint: 'lookup', formatModifier: "uom:tms>wms|ifblank:'EA'" }).suggestions).to.deep.equal(['EA', 'SE', 'CA']);
        expect(service.buildModalField({ name: 'uom', isAutoGenerated: false, typeHint: 'string', formatModifier: 'list:uom:wms' }).suggestions).to.deep.equal(['EA', 'ST', 'CS', 'BX']);
        expect(service.buildModalField({ name: 'note', isAutoGenerated: false, typeHint: 'string' }).suggestions).to.equal(undefined);
    });
});
