// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Unit Tests for "Run API" vs "Run Batch" detection (GitHub Issues #255, #257)
 *
 * The endpoint editor shows "Run Batch" when the endpoint contains at least one
 * template variable ({{...}}) across its body, path, query params or headers,
 * and "Run API" otherwise (endpoint.js -> getTemplateVariableCount()).
 *
 * Two bugs were reported:
 *  - #255: a commented-out body placeholder (e.g. `// "Query": "{{SKU}}"`) still
 *          triggered "Run Batch". Comments must be stripped before counting.
 *  - #257: a query-param placeholder did not enable "Run Batch" at all (the DOM
 *          detection used the wrong input selector). The pure extraction below
 *          documents that a query/path/header value placeholder must be counted.
 *
 * These tests exercise the pure pieces of that logic, mirrored from endpoint.js
 * and json-comment-stripper.js, which is the testability convention used by the
 * other core-logic suites in this repo.
 */

import { expect } from 'chai';
import { describe, it } from 'mocha';

/**
 * Extracted from src/webviews/shared/json-comment-stripper.js (stripJsonComments).
 * Removes // and /* *\/ comments while preserving string content.
 */
function stripJsonComments(jsonString: string): string {
    if (!jsonString || typeof jsonString !== 'string') {
        return jsonString;
    }

    let result = '';
    let i = 0;
    let inString = false;
    let stringChar = '';
    let inSingleLineComment = false;
    let inMultiLineComment = false;

    while (i < jsonString.length) {
        const char = jsonString[i];
        const nextChar = i + 1 < jsonString.length ? jsonString[i + 1] : '';

        if (!inSingleLineComment && !inMultiLineComment) {
            if (!inString && (char === '"' || char === "'")) {
                inString = true;
                stringChar = char;
                result += char;
                i++;
                continue;
            } else if (inString && char === stringChar) {
                let backslashCount = 0;
                let j = i - 1;
                while (j >= 0 && jsonString[j] === '\\') {
                    backslashCount++;
                    j--;
                }
                if (backslashCount % 2 === 0) {
                    inString = false;
                    stringChar = '';
                }
                result += char;
                i++;
                continue;
            }
        }

        if (inString) {
            result += char;
            i++;
            continue;
        }

        if (!inSingleLineComment && !inMultiLineComment) {
            if (char === '/' && nextChar === '/') {
                inSingleLineComment = true;
                i += 2;
                continue;
            }
            if (char === '/' && nextChar === '*') {
                inMultiLineComment = true;
                i += 2;
                continue;
            }
        }

        if (inSingleLineComment) {
            if (char === '\n' || char === '\r') {
                inSingleLineComment = false;
                result += char;
            }
            i++;
            continue;
        }

        if (inMultiLineComment) {
            if (char === '*' && nextChar === '/') {
                inMultiLineComment = false;
                i += 2;
                continue;
            }
            i++;
            continue;
        }

        result += char;
        i++;
    }

    return result;
}

/**
 * Extracted from src/webviews/endpoint/endpoint.js (extractTemplateVariables).
 * Returns the unique user-supplied template variable names, skipping
 * auto-generated (A8:/V8:) and loop (#/) syntax.
 */
function extractTemplateVariables(text: string): string[] {
    if (!text) {
        return [];
    }

    const variables: string[] = [];
    const regex = /\{\{([^}]+)\}\}/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
        const variable = match[1].trim();
        const variableName = variable.split(':')[0].trim();

        if (!variable.startsWith('A8:') &&
            !variable.startsWith('V8:') &&
            !variableName.startsWith('#') &&
            !variableName.startsWith('/') &&
            !variables.includes(variableName)) {
            variables.push(variableName);
        }
    }

    return variables;
}

/**
 * Mirrors getTemplateVariableCount() in endpoint.js after the #255/#257 fix:
 * the body has comments stripped before extraction; path, query-param values
 * and header values are concatenated as-is.
 */
function countTemplateVariables(sources: {
    body?: string;
    path?: string;
    queryParamValues?: string[];
    headerValues?: string[];
}): number {
    let allText = '';
    if (sources.body) {
        allText += stripJsonComments(sources.body) + ' ';
    }
    if (sources.path) {
        allText += sources.path + ' ';
    }
    (sources.queryParamValues || []).forEach((v) => { allText += v + ' '; });
    (sources.headerValues || []).forEach((v) => { allText += v + ' '; });
    return extractTemplateVariables(allText).length;
}

describe('Run API vs Run Batch detection (#255, #257)', () => {
    describe('#255 - commented-out body placeholders must NOT trigger Run Batch', () => {
        it('returns 0 vars when the only placeholders are inside // comments', () => {
            const body = [
                '{',
                '  // "Query": "Volume > 0",',
                '  // "Query": "ItemId = ACAU-{{SKU:string}}"',
                '  "Template": {',
                '    "ItemId": null,',
                '    "UnitPrice": null',
                '  }',
                '}'
            ].join('\n');
            expect(countTemplateVariables({ body })).to.equal(0);
        });

        it('returns 0 vars when placeholders are inside a /* */ block comment', () => {
            const body = '{\n  /* "Query": "{{SKU}}" */\n  "Template": { "ItemId": null }\n}';
            expect(countTemplateVariables({ body })).to.equal(0);
        });

        it('still counts an active (uncommented) body placeholder', () => {
            const body = '{\n  "Query": "ItemId = ACAU-{{SKU:string}}"\n}';
            expect(countTemplateVariables({ body })).to.equal(1);
        });

        it('counts only the active placeholder when commented and active are mixed', () => {
            const body = [
                '{',
                '  // "Query": "{{OLD}}",',
                '  "Query": "{{SKU}}"',
                '}'
            ].join('\n');
            expect(countTemplateVariables({ body })).to.equal(1);
        });
    });

    describe('#257 - query-param / path / header placeholders DO trigger Run Batch', () => {
        it('counts a placeholder in a query-param value', () => {
            expect(countTemplateVariables({ queryParamValues: ['ItemId={{SKU}}[ or ]'] })).to.equal(1);
        });

        it('counts a placeholder in the path', () => {
            expect(countTemplateVariables({ path: '/item-master/api/item-master/item/{{id}}' })).to.equal(1);
        });

        it('counts a placeholder in a header value', () => {
            expect(countTemplateVariables({ headerValues: ['Bearer {{token}}'] })).to.equal(1);
        });

        it('does not double-count the same variable across sources', () => {
            expect(countTemplateVariables({
                body: '{ "a": "{{SKU}}" }',
                queryParamValues: ['q={{SKU}}']
            })).to.equal(1);
        });

        it('ignores auto-generated A8: pagination params (Run API, not Batch)', () => {
            expect(countTemplateVariables({
                queryParamValues: ['{{A8:PAGE:0}}', '{{A8:SIZE:20}}']
            })).to.equal(0);
        });
    });
});
