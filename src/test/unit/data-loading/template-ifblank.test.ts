// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * `ifblank` in a request template (James, 2026-11-23): `{{note | ifblank:'none'}}` sends "none" for a
 * blank note, and for one of spaces only (templates trim first), unless `notrim` keeps the spaces.
 */
import { expect } from 'chai';
import { extractVariablesFromJsonTemplate } from '../../../data-loading/json-template-parser';
import { TemplateParser } from '../../../data-loading/template-parser';
import { parseModifiers } from '../../../data-loading/modifier-parser';
import { applyModifiers } from '../../../data-loading/modifier-executor';
import { setTemplateLookupTables } from '../../../data-loading/template-lookups';

describe('Template ifblank: what a blank value becomes', () => {
    const run = (value: string, chain: string, type: 'string' | 'number' = 'string') => applyModifiers(value, type, parseModifiers(chain, type));

    it("reads ifblank:'text', the text in single quotes", () => {
        expect(parseModifiers("ifblank:'none'", 'string').ifBlank).to.equal('none');
        expect(parseModifiers("ifblank:'no note'", 'string').ifBlank).to.equal('no note');
        expect(parseModifiers("upper|ifblank:'N/A'", 'string').ifBlank).to.equal('N/A');
        expect(parseModifiers('upper', 'string').ifBlank).to.equal(undefined);
    });

    // James, 2026-11-23: "it should be in quotes… don't allow just random text outside of the string" (single quotes:
    // a double one would end a JSON body's string)
    it('text not in single quotes is refused, saying how to write it, and a run stops on it', async () => {
        expect(parseModifiers('ifblank:none', 'string').errors).to.deep.equal(["Put the text in quotes: ifblank:'none'"]);
        expect(parseModifiers('ifblank:"none"', 'string').errors).to.deep.equal(["Put the text in quotes: ifblank:'none'"]);
        expect(parseModifiers('ifblank:', 'string').errors).to.deep.equal(["ifblank needs the text a blank becomes, in quotes: ifblank:'none'"]);
        expect(parseModifiers('ifblank:none', 'string').ifBlank).to.equal(undefined);
        const filled = await new TemplateParser().processTemplateAsync('{ "note": "{{note | ifblank:none}}" }', { note: '' });
        expect(filled.success).to.equal(false);
        expect(filled.error).to.contain("Put the text in quotes: ifblank:'none'");
    });

    it('a blank, or spaces only, becomes the text; with notrim the spaces stay; a value stays as it is', () => {
        expect(run('', 'ifblank:\'none\'')).to.deep.equal({ success: true, value: 'none' });
        expect(run('   ', 'ifblank:\'none\'')).to.deep.equal({ success: true, value: 'none' });
        expect(run('   ', 'notrim|ifblank:\'none\'')).to.deep.equal({ success: true, value: '   ' });
        expect(run('rush', 'ifblank:\'none\'')).to.deep.equal({ success: true, value: 'rush' });
        expect(run('', 'ifblank:\'0\'', 'number')).to.deep.equal({ success: true, value: 0 });
    });

    it('then the rest of the chain: upper, and a lookup of the text it became', () => {
        setTemplateLookupTables([{ id: 'u', name: 'UOM', updatedAt: '', columns: [{ id: 'w', name: 'WMS' }, { id: 't', name: 'TMS' }], rows: [{ w: 'EA', t: 'EA' }] }]);
        try {
            expect(run('', 'ifblank:\'ea\'|upper')).to.deep.equal({ success: true, value: 'EA' });
            expect(run('', 'ifblank:\'EA\'|lookup:uom:tms>wms')).to.deep.equal({ success: true, value: 'EA' });
        } finally { setTemplateLookupTables([]); }
    });

    it('{{note | ifblank:\'none\'}} and {{note:string | ifblank:\'none\'}} fill a blank note with none', async () => {
        for (const template of ['{ "note": "{{note | ifblank:\'none\'}}" }', '{ "note": "{{note:string | ifblank:\'none\'}}" }']) {
            const { variables, errors } = extractVariablesFromJsonTemplate(template);
            expect(errors, template).to.deep.equal([]);
            expect(variables.map(v => v.resolvedName)).to.deep.equal(['note']);
            const filled = await new TemplateParser().processTemplateAsync(template, { note: '  ' });
            expect(filled.success, template).to.equal(true);
            expect(JSON.parse(filled.processedJson as string)).to.deep.equal({ note: 'none' });
        }
    });
});
