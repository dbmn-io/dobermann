// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Unit tests for Modifier Parser (GitHub Issue #175)
 *
 * Tests parsing of modifier strings for string, number, and date types.
 */

import { expect } from 'chai';
import {
    parseModifiers,
    extractModifiersFromFormat,
    validateModifierCompatibility,
    serializeModifiers
} from '../../../data-loading/modifier-parser';

describe('Modifier Parser (GitHub Issue #175)', () => {
    describe('parseModifiers', () => {
        describe('String Modifiers', () => {
            it('should return default trim behavior for empty modifier string', () => {
                const result = parseModifiers('', 'string');
                expect(result.applyTrim).to.be.true;
                expect(result.emptyBehavior).to.equal('default');
                expect(result.modifiers).to.have.length(0);
                expect(result.errors).to.have.length(0);
            });

            it('should parse exact length modifier (n)', () => {
                const result = parseModifiers('3', 'string');
                expect(result.modifiers).to.have.length(1);
                expect(result.modifiers[0]).to.deep.include({
                    kind: 'string',
                    type: 'exactLength',
                    length: 3
                });
            });

            it('should parse exact length with other modifiers', () => {
                const result = parseModifiers('5|upper', 'string');
                expect(result.modifiers).to.have.length(2);
                expect(result.modifiers[0]).to.deep.include({
                    kind: 'string',
                    type: 'exactLength',
                    length: 5
                });
                expect(result.modifiers[1]).to.deep.include({
                    kind: 'string',
                    type: 'upper'
                });
            });

            it('should parse noTrim modifier', () => {
                const result = parseModifiers('noTrim', 'string');
                expect(result.applyTrim).to.be.false;
                expect(result.modifiers).to.have.length(1);
                expect(result.modifiers[0]).to.deep.include({
                    kind: 'string',
                    type: 'noTrim'
                });
            });

            it('should parse upper modifier', () => {
                const result = parseModifiers('upper', 'string');
                expect(result.modifiers).to.have.length(1);
                expect(result.modifiers[0]).to.deep.include({
                    kind: 'string',
                    type: 'upper'
                });
            });

            it('should parse lower modifier', () => {
                const result = parseModifiers('lower', 'string');
                expect(result.modifiers).to.have.length(1);
                expect(result.modifiers[0]).to.deep.include({
                    kind: 'string',
                    type: 'lower'
                });
            });

            it('should parse min length modifier (n-)', () => {
                const result = parseModifiers('3-', 'string');
                expect(result.modifiers).to.have.length(1);
                expect(result.modifiers[0]).to.deep.include({
                    kind: 'string',
                    type: 'minLength',
                    min: 3
                });
            });

            it('should parse max length modifier (-n)', () => {
                const result = parseModifiers('-50', 'string');
                expect(result.modifiers).to.have.length(1);
                expect(result.modifiers[0]).to.deep.include({
                    kind: 'string',
                    type: 'maxLength',
                    max: 50
                });
            });

            it('should parse length range modifier (n-m)', () => {
                const result = parseModifiers('3-50', 'string');
                expect(result.modifiers).to.have.length(1);
                expect(result.modifiers[0]).to.deep.include({
                    kind: 'string',
                    type: 'lengthRange',
                    min: 3,
                    max: 50
                });
            });

            it('should parse chained string modifiers', () => {
                const result = parseModifiers('3-50|upper', 'string');
                expect(result.modifiers).to.have.length(2);
                expect(result.modifiers[0].type).to.equal('lengthRange');
                expect(result.modifiers[1].type).to.equal('upper');
            });

            it('should reject invalid length range (min > max)', () => {
                const result = parseModifiers('50-3', 'string');
                expect(result.errors).to.have.length(1);
                expect(result.errors[0]).to.include('cannot be greater than max');
            });

            it('should reject unknown string modifiers', () => {
                const result = parseModifiers('unknown', 'string');
                expect(result.errors).to.have.length(1);
                expect(result.errors[0]).to.include('Unknown string modifier');
            });
        });

        describe('Empty Value Modifiers (opt and null)', () => {
            it('should parse opt modifier for string type', () => {
                const result = parseModifiers('opt', 'string');
                expect(result.emptyBehavior).to.equal('opt');
                expect(result.modifiers).to.have.length(0); // opt is not stored as a modifier
            });

            it('should parse null modifier for string type', () => {
                const result = parseModifiers('null', 'string');
                expect(result.emptyBehavior).to.equal('null');
                expect(result.modifiers).to.have.length(0);
            });

            it('should parse opt modifier for number type', () => {
                const result = parseModifiers('opt', 'number');
                expect(result.emptyBehavior).to.equal('opt');
            });

            it('should parse null modifier for number type', () => {
                const result = parseModifiers('null', 'number');
                expect(result.emptyBehavior).to.equal('null');
            });

            it('should parse opt modifier for date type', () => {
                const result = parseModifiers('opt', 'date');
                expect(result.emptyBehavior).to.equal('opt');
            });

            it('should parse opt with other modifiers', () => {
                const result = parseModifiers('3-50|upper|opt', 'string');
                expect(result.emptyBehavior).to.equal('opt');
                expect(result.modifiers).to.have.length(2);
                expect(result.modifiers[0].type).to.equal('lengthRange');
                expect(result.modifiers[1].type).to.equal('upper');
            });

            it('should parse null with other modifiers', () => {
                const result = parseModifiers('>0|null', 'number');
                expect(result.emptyBehavior).to.equal('null');
                expect(result.modifiers).to.have.length(1);
                expect(result.modifiers[0].type).to.equal('greaterThan');
            });

            it('should handle case insensitivity for opt', () => {
                const result = parseModifiers('OPT', 'string');
                expect(result.emptyBehavior).to.equal('opt');
            });

            it('should handle case insensitivity for null', () => {
                const result = parseModifiers('NULL', 'number');
                expect(result.emptyBehavior).to.equal('null');
            });

            it('should use last empty behavior modifier if multiple specified', () => {
                const result = parseModifiers('opt|null', 'string');
                expect(result.emptyBehavior).to.equal('null'); // last one wins
            });
        });

        describe('Number Modifiers', () => {
            it('should parse int modifier', () => {
                const result = parseModifiers('int', 'number');
                expect(result.modifiers).to.have.length(1);
                expect(result.modifiers[0]).to.deep.include({
                    kind: 'number',
                    type: 'integer'
                });
            });

            it('should parse floor modifier', () => {
                const result = parseModifiers('floor', 'number');
                expect(result.modifiers).to.have.length(1);
                expect(result.modifiers[0]).to.deep.include({
                    kind: 'number',
                    type: 'floor'
                });
            });

            it('should parse ceil modifier', () => {
                const result = parseModifiers('ceil', 'number');
                expect(result.modifiers).to.have.length(1);
                expect(result.modifiers[0]).to.deep.include({
                    kind: 'number',
                    type: 'ceil'
                });
            });

            it('should parse rnd(n) modifier', () => {
                const result = parseModifiers('rnd(2)', 'number');
                expect(result.modifiers).to.have.length(1);
                expect(result.modifiers[0]).to.deep.include({
                    kind: 'number',
                    type: 'round',
                    decimals: 2
                });
            });

            it('should parse >n modifier', () => {
                const result = parseModifiers('>0', 'number');
                expect(result.modifiers).to.have.length(1);
                expect(result.modifiers[0]).to.deep.include({
                    kind: 'number',
                    type: 'greaterThan',
                    value: 0
                });
            });

            it('should parse >=n modifier', () => {
                const result = parseModifiers('>=0', 'number');
                expect(result.modifiers).to.have.length(1);
                expect(result.modifiers[0]).to.deep.include({
                    kind: 'number',
                    type: 'greaterOrEqual',
                    value: 0
                });
            });

            it('should parse <n modifier', () => {
                const result = parseModifiers('<100', 'number');
                expect(result.modifiers).to.have.length(1);
                expect(result.modifiers[0]).to.deep.include({
                    kind: 'number',
                    type: 'lessThan',
                    value: 100
                });
            });

            it('should parse <=n modifier', () => {
                const result = parseModifiers('<=100', 'number');
                expect(result.modifiers).to.have.length(1);
                expect(result.modifiers[0]).to.deep.include({
                    kind: 'number',
                    type: 'lessOrEqual',
                    value: 100
                });
            });

            it('should parse negative numbers in comparisons', () => {
                const result = parseModifiers('>-10', 'number');
                expect(result.modifiers).to.have.length(1);
                expect(result.modifiers[0]).to.deep.include({
                    kind: 'number',
                    type: 'greaterThan',
                    value: -10
                });
            });

            it('should parse decimal numbers in comparisons', () => {
                const result = parseModifiers('>=0.5', 'number');
                expect(result.modifiers).to.have.length(1);
                expect(result.modifiers[0]).to.deep.include({
                    kind: 'number',
                    type: 'greaterOrEqual',
                    value: 0.5
                });
            });

            it('should parse chained number modifiers', () => {
                const result = parseModifiers('>0|rnd(2)', 'number');
                expect(result.modifiers).to.have.length(2);
                expect(result.modifiers[0].type).to.equal('greaterThan');
                expect(result.modifiers[1].type).to.equal('round');
            });

            it('should parse range with multiple comparisons', () => {
                const result = parseModifiers('>=0|<=100', 'number');
                expect(result.modifiers).to.have.length(2);
                expect(result.modifiers[0].type).to.equal('greaterOrEqual');
                expect(result.modifiers[1].type).to.equal('lessOrEqual');
            });

            it('should reject unknown number modifiers', () => {
                const result = parseModifiers('unknown', 'number');
                expect(result.errors).to.have.length(1);
                expect(result.errors[0]).to.include('Unknown number modifier');
            });
        });

        describe('Date Math Modifiers', () => {
            it('should parse +nd (add days) modifier', () => {
                const result = parseModifiers('+2d', 'datetime');
                expect(result.modifiers).to.have.length(1);
                const mod = result.modifiers[0];
                expect(mod.kind).to.equal('dateMath');
                if (mod.kind === 'dateMath') {
                    expect(mod.amount).to.equal(2);
                    expect(mod.unit).to.equal('d');
                }
            });

            it('should parse -nd (subtract days) modifier', () => {
                const result = parseModifiers('-1d', 'date');
                expect(result.modifiers).to.have.length(1);
                const mod = result.modifiers[0];
                expect(mod.kind).to.equal('dateMath');
                if (mod.kind === 'dateMath') {
                    expect(mod.amount).to.equal(-1);
                    expect(mod.unit).to.equal('d');
                }
            });

            it('should parse +nh (add hours) modifier', () => {
                const result = parseModifiers('+4h', 'datetime');
                expect(result.modifiers).to.have.length(1);
                const mod = result.modifiers[0];
                expect(mod.kind).to.equal('dateMath');
                if (mod.kind === 'dateMath') {
                    expect(mod.amount).to.equal(4);
                    expect(mod.unit).to.equal('h');
                }
            });

            it('should parse +nm (add minutes) modifier', () => {
                const result = parseModifiers('+30m', 'datetime');
                expect(result.modifiers).to.have.length(1);
                const mod = result.modifiers[0];
                expect(mod.kind).to.equal('dateMath');
                if (mod.kind === 'dateMath') {
                    expect(mod.amount).to.equal(30);
                    expect(mod.unit).to.equal('m');
                }
            });

            it('should reject unknown date modifiers', () => {
                const result = parseModifiers('unknown', 'date');
                expect(result.errors).to.have.length(1);
                expect(result.errors[0]).to.include('Unknown date modifier');
            });
        });

        describe('Boolean Type', () => {
            it('should reject modifiers for boolean type', () => {
                const result = parseModifiers('upper', 'boolean');
                expect(result.errors).to.have.length(1);
                expect(result.errors[0]).to.include('Boolean type does not support modifiers');
            });
        });

        describe('Case Insensitivity', () => {
            it('should parse NOTRIM as noTrim', () => {
                const result = parseModifiers('NOTRIM', 'string');
                expect(result.applyTrim).to.be.false;
            });

            it('should parse UPPER as upper', () => {
                const result = parseModifiers('UPPER', 'string');
                const mod = result.modifiers[0];
                expect(mod.kind).to.equal('string');
                if (mod.kind === 'string') {
                    expect(mod.type).to.equal('upper');
                }
            });

            it('should parse INT as int', () => {
                const result = parseModifiers('INT', 'number');
                const mod = result.modifiers[0];
                expect(mod.kind).to.equal('number');
                if (mod.kind === 'number') {
                    expect(mod.type).to.equal('integer');
                }
            });

            it('should parse RND(2) as rnd(2)', () => {
                const result = parseModifiers('RND(2)', 'number');
                const mod = result.modifiers[0];
                expect(mod.kind).to.equal('number');
                if (mod.kind === 'number') {
                    expect(mod.type).to.equal('round');
                }
            });

            it('should parse +2D as +2d', () => {
                const result = parseModifiers('+2D', 'date');
                const mod = result.modifiers[0];
                expect(mod.kind).to.equal('dateMath');
                if (mod.kind === 'dateMath') {
                    expect(mod.unit).to.equal('d');
                }
            });
        });
    });

    describe('extractModifiersFromFormat', () => {
        it('should separate format string from modifiers for datetime', () => {
            const result = extractModifiersFromFormat('+2d|iso', 'datetime');
            expect(result.formatOnly).to.equal('iso');
            expect(result.modifiers.modifiers).to.have.length(1);
            expect(result.modifiers.modifiers[0].kind).to.equal('dateMath');
        });

        it('should keep format-only strings intact', () => {
            const result = extractModifiersFromFormat('YYYY-MM-DD', 'date');
            expect(result.formatOnly).to.equal('YYYY-MM-DD');
            expect(result.modifiers.modifiers).to.have.length(0);
        });

        it('should parse string modifiers without format', () => {
            const result = extractModifiersFromFormat('3-50|upper', 'string');
            expect(result.formatOnly).to.be.undefined;
            expect(result.modifiers.modifiers).to.have.length(2);
        });

        it('should parse number modifiers without format', () => {
            const result = extractModifiersFromFormat('>0|rnd(2)', 'number');
            expect(result.formatOnly).to.be.undefined;
            expect(result.modifiers.modifiers).to.have.length(2);
        });

        it('should handle empty format modifier', () => {
            const result = extractModifiersFromFormat('', 'string');
            expect(result.formatOnly).to.be.undefined;
            expect(result.modifiers.modifiers).to.have.length(0);
        });

        it('should handle undefined format modifier', () => {
            const result = extractModifiersFromFormat(undefined, 'string');
            expect(result.formatOnly).to.be.undefined;
            expect(result.modifiers.modifiers).to.have.length(0);
        });
    });

    describe('validateModifierCompatibility', () => {
        it('should accept valid string modifiers', () => {
            const modifiers = parseModifiers('3-50|upper', 'string');
            const errors = validateModifierCompatibility(modifiers, 'string');
            expect(errors).to.have.length(0);
        });

        it('should accept valid number modifiers', () => {
            const modifiers = parseModifiers('>0|rnd(2)', 'number');
            const errors = validateModifierCompatibility(modifiers, 'number');
            expect(errors).to.have.length(0);
        });

        it('should accept valid date math modifiers', () => {
            const modifiers = parseModifiers('+2d', 'datetime');
            const errors = validateModifierCompatibility(modifiers, 'datetime');
            expect(errors).to.have.length(0);
        });
    });

    describe('serializeModifiers', () => {
        it('should serialize string modifiers', () => {
            const modifiers = parseModifiers('3-50|upper', 'string');
            const serialized = serializeModifiers(modifiers);
            expect(serialized).to.equal('3-50|upper');
        });

        it('should serialize number modifiers', () => {
            const modifiers = parseModifiers('>0|rnd(2)', 'number');
            const serialized = serializeModifiers(modifiers);
            expect(serialized).to.equal('>0|rnd(2)');
        });

        it('should serialize date math modifiers', () => {
            const modifiers = parseModifiers('+2d', 'datetime');
            const serialized = serializeModifiers(modifiers);
            expect(serialized).to.equal('+2d');
        });

        it('should return empty string for no modifiers', () => {
            const modifiers = parseModifiers('', 'string');
            const serialized = serializeModifiers(modifiers);
            expect(serialized).to.equal('');
        });
    });

    describe('Real-world Examples', () => {
        it('should parse {{Name:string:3-50}} modifier', () => {
            const result = parseModifiers('3-50', 'string');
            expect(result.modifiers).to.have.length(1);
            expect(result.modifiers[0]).to.deep.include({
                kind: 'string',
                type: 'lengthRange',
                min: 3,
                max: 50
            });
        });

        it('should parse {{Amount:number:>0|rnd(2)}} modifier', () => {
            const result = parseModifiers('>0|rnd(2)', 'number');
            expect(result.modifiers).to.have.length(2);
            expect(result.modifiers[0]).to.deep.include({
                kind: 'number',
                type: 'greaterThan',
                value: 0
            });
            expect(result.modifiers[1]).to.deep.include({
                kind: 'number',
                type: 'round',
                decimals: 2
            });
        });

        it('should parse {{Qty:number:int|>0}} modifier', () => {
            const result = parseModifiers('int|>0', 'number');
            expect(result.modifiers).to.have.length(2);
            expect(result.modifiers[0].type).to.equal('integer');
            expect(result.modifiers[1].type).to.equal('greaterThan');
        });

        it('should parse {{Date:datetime:+2d|iso}} modifier', () => {
            const result = extractModifiersFromFormat('+2d|iso', 'datetime');
            expect(result.formatOnly).to.equal('iso');
            expect(result.modifiers.modifiers).to.have.length(1);
            const mod = result.modifiers.modifiers[0];
            expect(mod.kind).to.equal('dateMath');
            if (mod.kind === 'dateMath') {
                expect(mod.amount).to.equal(2);
                expect(mod.unit).to.equal('d');
            }
        });
    });
});
