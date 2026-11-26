// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A number's rules as Validate reads them and as the run reads them: one answer. James, 2026-11-26: a quantity written
 * {{quantityOnHand:number:int|>=0}}, halved by a function on Map, showed 175.5 on Validate as Valid. Validate's own
 * reading of the template dropped a rule written after the type's colon; the run's (modifier-parser.ts) keeps it, so
 * the row passed Validate and was refused at the run. The page is the REAL dt-data-entry-grid.js.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';
import { extractVariablesFromJsonTemplate } from '../../../../data-loading/json-template-parser';
import { extractModifiersFromFormat } from '../../../../data-loading/modifier-parser';

const SHARED = path.resolve(__dirname, '../../../../../src/webviews/shared');

function validateReads(content: string): { isInteger: boolean; minValue: number | null; hints: string[] } {
    const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
    const w = dom.window as unknown as { eval(code: string): void; DTDataEntryGrid: { extractTemplateVariablesFromEndpoint(e: unknown): { modifiers: { isInteger: boolean; minValue: number | null; hints: string[] } }[] } };
    for (const file of ['json-comment-stripper.js', 'dt-data-entry-grid.js']) w.eval(fs.readFileSync(path.join(SHARED, file), 'utf8'));
    return w.DTDataEntryGrid.extractTemplateVariablesFromEndpoint({ method: 'POST', path: '/x', body: JSON.stringify({ q: `{{${content}}}` }) })[0].modifiers;
}
function runReads(content: string): string[] {
    const found = extractVariablesFromJsonTemplate(JSON.stringify({ q: `{{${content}}}` })) as unknown as { variables?: { formatModifier?: string; dataType: 'number' }[] } | { formatModifier?: string; dataType: 'number' }[];
    const variable = (Array.isArray(found) ? found : found.variables ?? [])[0];
    return extractModifiersFromFormat(variable.formatModifier, variable.dataType).modifiers.modifiers.map(m => m.type);
}

describe('Validate reads a number\'s rules as the run does', () => {
    for (const content of ['q:number:int|>=0', 'q:number|int|>=0', 'q:number:int', 'q:number:>=0|int']) {
        it(`{{${content}}}: a whole number, as the run has it`, () => {
            expect(runReads(content), 'the run').to.include('integer');
            const reads = validateReads(content);
            expect(reads.isInteger, 'Validate').to.equal(true);
            expect(reads.hints).to.include('integer');
        });
    }
    it('the other rule is still read, and a number without int is not made whole', () => {
        expect(validateReads('q:number:int|>=0').minValue).to.equal(0);
        expect(validateReads('q:number:>=0|int').minValue).to.equal(0);
        expect(validateReads('q:number|>=0').isInteger).to.equal(false);
        expect(runReads('q:number|>=0')).to.not.include('integer');
    });
});
