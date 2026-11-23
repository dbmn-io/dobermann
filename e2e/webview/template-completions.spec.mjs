/**
 * The template editor's checks and predictive text for the list and lookup types and ifblank
 * (src/webviews/endpoint/modules/template-completions.js), in a real browser; Monaco stood in for.
 *
 *   npm run test:e2e:webview      (no backend needed)
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = rel => readFileSync(join(ROOT, 'src/webviews', rel), 'utf8');
const page = () => `<!doctype html><html><head><script>
  window.monaco = { languages: { CompletionItemKind: { Text: 1, Module: 2, Field: 3, Keyword: 4, TypeParameter: 5, Function: 6, Variable: 7, Value: 8 } } };
  window.dbmnLookupTables = [{ name: 'UOM', columns: ['WMS', 'ERP', 'TMS'] }, { name: 'Sites', columns: ['site'] }];
</script><script>${read('endpoint/modules/template-completions.js')}</script></head><body></body></html>`;

test('list and lookup: checked against the lookup tables; ifblank and {{name | …}} read; an old lu said what it is now', async ({ page: p }) => {
    // James, 2026-11-23: list and lookup are types; "if a lu table has only one column, could we use shorthand?"
    await p.setContent(page());
    const check = text => p.evaluate(t => { const r = window.TemplateCompletions.validate(t); return r.valid ? 'ok' : `${r.isWarning ? 'warn' : 'error'}: ${r.error}`; }, text);
    expect(await check('uom:list|uom:wms')).toBe('ok');
    expect(await check('site:list|sites')).toBe('ok');
    expect(await check('uom:lookup|uom:tms>wms')).toBe('ok');
    expect(await check('uom:lookup|uom:tms>wms|ifblank:EA')).toBe('ok');
    expect(await check('note | ifblank:none')).toBe('ok');
    expect(await check('note:string | ifblank:none')).toBe('ok');
    expect(await check('uom:list')).toBe('error: list needs a table: {{name:list|table:column}}');
    expect(await check('uom:lookup|uom:tms')).toBe('error: lookup needs a table and two columns: {{name:lookup|table:from>to}}');
    expect(await check('uom:list|units:wms')).toBe('warn: No lookup table called units');
    expect(await check('uom:list|uom:oms')).toBe('warn: UOM has no column called oms');
    expect(await check('uom:list|uom')).toBe('warn: UOM has more than one column: say which, e.g. uom:wms');
    expect(await check('note | ifblank:')).toBe('error: ifblank needs the text a blank becomes: ifblank:none');
    expect(await check('uom | lu:uom:tms>wms')).toMatch(/^error: lu is now a type/);
});

test('predictive text: after list| the tables, after the table\'s colon its columns, after > the other columns, after | the modifiers', async ({ page: p }) => {
    await p.setContent(page());
    const offer = (type, typed) => p.evaluate(([ty, t]) => (window.TemplateCompletions.listSuggestions(ty, t, {}) || []).map(s => s.label), [type, typed]);
    expect(await offer('list', '')).toEqual(['UOM', 'Sites']);
    expect(await offer('lookup', 'uom:')).toEqual(['WMS', 'ERP', 'TMS']);
    expect(await offer('lookup', 'uom:tms>')).toEqual(['WMS', 'ERP']);
    expect(await offer('list', 'uom:wms>')).toEqual([]);
    expect(await offer('lookup', 'uom:tms>wms|')).toContain('ifblank:');
});
