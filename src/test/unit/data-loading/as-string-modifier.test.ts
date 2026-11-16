// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Tests for |asString output modifier (GitHub Issue #185)
 *
 * The |asString modifier forces JSON string output regardless of the declared type.
 * Example: {{Qty:number|asString}} with value "1" → outputs "1" (string) instead of 1 (number)
 */

import { expect } from 'chai';
import { parseModifiers, extractModifiersFromFormat } from '../../../data-loading/modifier-parser';
import { TemplateParser } from '../../../data-loading/template-parser';

describe('|asString Output Modifier (GitHub Issue #185)', () => {
    const parser = new TemplateParser();

    describe('Modifier Parsing', () => {
        it('should parse |asString for number type', () => {
            const result = parseModifiers('asString', 'number');
            expect(result.outputAsString).to.be.true;
            expect(result.errors).to.have.length(0);
        });

        it('should parse |asString alongside other number modifiers', () => {
            const result = parseModifiers('rnd(2)|asString', 'number');
            expect(result.outputAsString).to.be.true;
            expect(result.modifiers).to.have.length(1);
            expect(result.modifiers[0]).to.deep.include({ kind: 'number', type: 'round', decimals: 2 });
            expect(result.errors).to.have.length(0);
        });

        it('should parse |asString for boolean type', () => {
            const result = parseModifiers('asString', 'boolean');
            expect(result.outputAsString).to.be.true;
            expect(result.errors).to.have.length(0);
        });

        it('should parse |asString for string type (no-op but valid)', () => {
            const result = parseModifiers('asString', 'string');
            expect(result.outputAsString).to.be.true;
            expect(result.errors).to.have.length(0);
        });

        it('should be case-insensitive', () => {
            const result = parseModifiers('ASSTRING', 'number');
            expect(result.outputAsString).to.be.true;
        });

        it('should default outputAsString to false', () => {
            const result = parseModifiers('rnd(2)', 'number');
            expect(result.outputAsString).to.be.false;
        });

        it('should recognize asString in extractModifiersFromFormat', () => {
            const result = extractModifiersFromFormat('rnd(2)|asString', 'number');
            expect(result.modifiers.outputAsString).to.be.true;
        });

        it('should recognize asString as a modifier token in extractModifiersFromFormat', () => {
            const result = extractModifiersFromFormat('asString', 'number');
            expect(result.modifiers.outputAsString).to.be.true;
            expect(result.formatOnly).to.be.undefined;
        });
    });

    describe('Sync Path (processTemplate)', () => {
        it('should output number as string with |asString', () => {
            const template = `{
                "quantity": "{{QTY:number|asString}}"
            }`;

            const result = parser.processTemplate(template, { 'QTY': '1' });

            expect(result.success).to.be.true;
            const parsed = JSON.parse(result.processedJson!);
            expect(parsed.quantity).to.equal('1');
            expect(typeof parsed.quantity).to.equal('string');
        });

        it('should output number without |asString as raw number', () => {
            const template = `{
                "quantity": "{{QTY:number}}"
            }`;

            const result = parser.processTemplate(template, { 'QTY': '1' });

            expect(result.success).to.be.true;
            const parsed = JSON.parse(result.processedJson!);
            expect(parsed.quantity).to.equal(1);
            expect(typeof parsed.quantity).to.equal('number');
        });

        it('should chain rnd(2) with |asString', () => {
            const template = `{
                "cost": "{{COST:number|rnd(2)|asString}}"
            }`;

            const result = parser.processTemplate(template, { 'COST': '100.456' });

            expect(result.success).to.be.true;
            const parsed = JSON.parse(result.processedJson!);
            expect(parsed.cost).to.equal('100.46');
            expect(typeof parsed.cost).to.equal('string');
        });

        it('should handle COBOL-style number with |asString', () => {
            const template = `{
                "quantity": "{{QTY:number|asString}}"
            }`;

            const result = parser.processTemplate(template, { 'QTY': '+000000001.0000' });

            expect(result.success).to.be.true;
            const parsed = JSON.parse(result.processedJson!);
            expect(parsed.quantity).to.equal('1');
            expect(typeof parsed.quantity).to.equal('string');
        });

        it('should output boolean as string with |asString', () => {
            const template = `{
                "active": "{{FLAG:boolean|asString}}"
            }`;

            const result = parser.processTemplate(template, { 'FLAG': 'true' });

            expect(result.success).to.be.true;
            const parsed = JSON.parse(result.processedJson!);
            expect(parsed.active).to.equal('true');
            expect(typeof parsed.active).to.equal('string');
        });
    });

    describe('Async Path (processTemplateAsync)', () => {
        it('should output number as string with |asString', async () => {
            const template = `{
                "quantity": "{{QTY:number|asString}}"
            }`;

            const result = await parser.processTemplateAsync(template, { 'QTY': '1' });

            expect(result.success).to.be.true;
            const parsed = JSON.parse(result.processedJson!);
            expect(parsed.quantity).to.equal('1');
            expect(typeof parsed.quantity).to.equal('string');
        });

        it('should output number without |asString as raw number', async () => {
            const template = `{
                "quantity": "{{QTY:number}}"
            }`;

            const result = await parser.processTemplateAsync(template, { 'QTY': '1' });

            expect(result.success).to.be.true;
            const parsed = JSON.parse(result.processedJson!);
            expect(parsed.quantity).to.equal(1);
            expect(typeof parsed.quantity).to.equal('number');
        });

        it('should chain rnd(2) with |asString', async () => {
            const template = `{
                "cost": "{{COST:number|rnd(2)|asString}}"
            }`;

            const result = await parser.processTemplateAsync(template, { 'COST': '100.456' });

            expect(result.success).to.be.true;
            const parsed = JSON.parse(result.processedJson!);
            expect(parsed.cost).to.equal('100.46');
            expect(typeof parsed.cost).to.equal('string');
        });

        it('should handle COBOL-style number with |asString', async () => {
            const template = `{
                "quantity": "{{QTY:number|asString}}"
            }`;

            const result = await parser.processTemplateAsync(template, { 'QTY': '+000000001.0000' });

            expect(result.success).to.be.true;
            const parsed = JSON.parse(result.processedJson!);
            expect(parsed.quantity).to.equal('1');
            expect(typeof parsed.quantity).to.equal('string');
        });

        it('should output boolean as string with |asString', async () => {
            const template = `{
                "active": "{{FLAG:boolean|asString}}"
            }`;

            const result = await parser.processTemplateAsync(template, { 'FLAG': 'true' });

            expect(result.success).to.be.true;
            const parsed = JSON.parse(result.processedJson!);
            expect(parsed.active).to.equal('true');
            expect(typeof parsed.active).to.equal('string');
        });
    });
});
