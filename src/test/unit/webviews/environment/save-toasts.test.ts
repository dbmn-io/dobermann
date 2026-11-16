// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A save's outcome in the environment editor: the error from an attempt that failed (a name
 * already taken) goes when the next attempt succeeds, and the success is said, not only
 * shown by the asterisk going. The toast's source filter is the mechanism; the real
 * dbmn-toast.js in JSDOM proves it, and the editor's script is read for its use of it.
 */
import { expect } from 'chai';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../../../..');

function toasts() {
    const dom = new JSDOM('<!DOCTYPE html><body><main></main></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window as any;
    Object.defineProperty(win, 'innerHeight', { value: 600, configurable: true });
    dom.window.eval(fs.readFileSync(path.join(ROOT, 'src/webviews/shared/dbmn-toast.js'), 'utf8'));
    const shown = () => Array.from(dom.window.document.querySelectorAll('.dbmn-toast')).map(n => (n as HTMLElement).textContent?.replace(/\s+/g, ' ').trim());
    return { win, shown };
}

describe('environment editor: a save says how it went', () => {
    it('clearing one source takes down its toasts and leaves the rest', () => {
        const { win, shown } = toasts();
        win.DbmnToast.error('Could not save environment: name taken', { source: 'save' });
        win.DbmnToast.warn('Saved with empty variable(s): org');
        expect(shown()).to.have.length(2);
        win.DbmnToast.clear('save');
        expect(shown().join(' ')).to.contain('empty variable').and.not.contain('Could not save');
    });

    it('the editor clears the last save outcome before showing the new one, and says "Environment saved"', () => {
        const js = fs.readFileSync(path.join(ROOT, 'src/webviews/environment/environment.js'), 'utf8');
        const saved = js.slice(js.indexOf('function handleEnvironmentSaved('), js.indexOf('function handleEnvironmentSaveError('));
        expect(saved).to.contain("clearFooterNotification('save')");
        expect(saved).to.contain("showFooterNotification('success', 'Environment saved'");
        const failed = js.slice(js.indexOf('function handleEnvironmentSaveError('), js.indexOf('function handleEnvironmentSetActive('));
        expect(failed).to.contain("clearFooterNotification('save')");
        expect(failed).to.contain("source: 'save'");
        expect(js).to.contain('window.DbmnToast.clear(source)');
    });
});
