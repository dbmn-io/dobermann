// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/** Issue #324: the portable EventEmitter behaves like vscode.EventEmitter for core's uses. */
import { expect } from 'chai';
import { EventEmitter, Disposable } from '../../platform/events';

describe('platform EventEmitter', () => {
    it('delivers to listeners in order, with thisArgs, until each is disposed', () => {
        const emitter = new EventEmitter<number>();
        const seen: string[] = [];
        const owner = { name: 'owner' };
        const disposables: Disposable[] = [];
        emitter.event(function (this: { name: string }, n) { seen.push(`${this.name}:${n}`); }, owner, disposables);
        const second = emitter.event(n => { seen.push(`second:${n}`); });

        emitter.fire(1);
        second.dispose();
        emitter.fire(2);
        disposables.forEach(d => d.dispose());
        emitter.fire(3);

        expect(seen).to.deep.equal(['owner:1', 'second:1', 'owner:2']);
    });

    it('dispose() drops every listener', () => {
        const emitter = new EventEmitter<string>();
        let calls = 0;
        emitter.event(() => { calls++; });
        emitter.dispose();
        emitter.fire('x');
        expect(calls).to.equal(0);
    });
});
