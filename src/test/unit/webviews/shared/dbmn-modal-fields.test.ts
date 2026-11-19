// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Password managers and the browser's autofill belong only where a sign-in is asked for (an email,
 * a user name, a password). Everywhere else they are told to stay out (1Password drew its button
 * over the Rename dialog's "Name" field).
 */
const SRC = path.resolve(__dirname, '../../../../../src/webviews/shared/dbmn-modal.js');

describe('DbmnModal fields and password managers', () => {
    it('a text field, a textarea and a select are marked to be ignored; a password field is not', () => {
        const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
        const w = dom.window as any;
        w.eval(fs.readFileSync(SRC, 'utf8'));
        w.DbmnModal.show({
            title: 'Rename',
            fields: [
                { id: 'name', type: 'text', label: 'Name', value: 'New query' },
                { id: 'note', type: 'textarea', label: 'Note' },
                { id: 'kind', type: 'select', label: 'Kind', options: [{ value: 'a', label: 'A' }] },
                { id: 'secret', type: 'password', label: 'Secret' },
                { id: 'email', type: 'email', label: 'Email' },
                { id: 'user', type: 'text', label: 'User name', autocomplete: 'username' }
            ],
            actions: [{ id: 'ok', label: 'OK', variant: 'primary' }]
        });
        for (const id of ['name', 'note', 'kind']) {
            const input = w.document.getElementById(`dbmn-modal-field-${id}`);
            expect(input, id).to.not.equal(null);
            expect(input.getAttribute('autocomplete'), id).to.equal('off');
            expect(input.getAttribute('data-1p-ignore'), id).to.equal('true');
            expect(input.getAttribute('data-lpignore'), id).to.equal('true');
            expect(input.getAttribute('data-bwignore'), id).to.equal('true');
            expect(input.getAttribute('data-form-type'), id).to.equal('other');
        }
        // A sign-in's fields are left to them, and say what they are
        const signIn: Record<string, string> = { secret: 'current-password', email: 'email', user: 'username' };
        for (const id of Object.keys(signIn)) {
            const input = w.document.getElementById(`dbmn-modal-field-${id}`);
            expect(input.getAttribute('data-1p-ignore'), id).to.equal(null);
            expect(input.getAttribute('data-lpignore'), id).to.equal(null);
            expect(input.getAttribute('autocomplete'), id).to.equal(signIn[id]);
        }
    });
});
