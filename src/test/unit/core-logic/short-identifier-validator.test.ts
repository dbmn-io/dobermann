// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it } from 'mocha';
import {
    validateShortIdentifier,
    validateSystemName,
    SHORT_NAME_MAX_LENGTH
} from '../../../data-loading/system-schema';

describe('validateShortIdentifier — System and folder name rules', () => {
    it('accepts simple lowercase names', () => {
        expect(validateShortIdentifier('acmewms', { kind: 'System' })).to.equal(undefined);
        expect(validateShortIdentifier('dbmn', { kind: 'System' })).to.equal(undefined);
        expect(validateShortIdentifier('acmewms', { kind: 'Folder' })).to.equal(undefined);
    });

    it('accepts digits — d365 is a real product name', () => {
        expect(validateShortIdentifier('d365', { kind: 'System' })).to.equal(undefined);
        expect(validateShortIdentifier('oauth2', { kind: 'System' })).to.equal(undefined);
    });

    it('accepts UPPERCASE input — the caller is expected to lowercase before saving', () => {
        expect(validateShortIdentifier('ACMEWMS', { kind: 'System' })).to.equal(undefined);
        expect(validateShortIdentifier('  ACMEWMS  ', { kind: 'System' })).to.equal(undefined);
    });

    it('rejects empty / whitespace-only', () => {
        expect(validateShortIdentifier('', { kind: 'System' })).to.equal('System name cannot be empty');
        expect(validateShortIdentifier('   ', { kind: 'Folder' })).to.equal('Folder name cannot be empty');
    });

    it('rejects names longer than 16 characters', () => {
        const seventeen = 'a'.repeat(17);
        expect(validateShortIdentifier(seventeen, { kind: 'System' })).to.equal(`Maximum ${SHORT_NAME_MAX_LENGTH} characters`);
    });

    it('rejects spaces and underscores explicitly', () => {
        const error = 'Lowercase letters and digits only (a–z, 0–9) — no spaces, underscores, or symbols';
        expect(validateShortIdentifier('foo bar', { kind: 'System' })).to.equal(error);
        expect(validateShortIdentifier('foo_bar', { kind: 'System' })).to.equal(error);
        expect(validateShortIdentifier('foo-bar', { kind: 'System' })).to.equal(error);
    });

    it('rejects names that contain duplicate (case-insensitive) entries already in use', () => {
        const existing = new Set(['acmewms', 'dbmn']);
        expect(validateShortIdentifier('ACMEWMS', {
            kind: 'System',
            existingNames: existing
        })).to.equal('A system with this name already exists');
        expect(validateShortIdentifier('dbmn', {
            kind: 'System',
            existingNames: existing
        })).to.equal('A system with this name already exists');
    });

    it('mentions the right "kind" in the duplicate-name error', () => {
        const existing = new Set(['admin']);
        expect(validateShortIdentifier('admin', {
            kind: 'Folder',
            existingNames: existing
        })).to.equal('A folder with this name already exists');
    });

    it('validateSystemName is a convenience wrapper for kind=System', () => {
        expect(validateSystemName('acmewms')).to.equal(undefined);
        expect(validateSystemName('foo bar')).to.contain('Lowercase letters and digits only');
    });
});
