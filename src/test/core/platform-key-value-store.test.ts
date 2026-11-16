// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/** Issue #319: MemoryKeyValueStore behaves like a VS Code Memento for core's uses. */
import { expect } from 'chai';
import { MemoryKeyValueStore } from '../../platform/memory/memory-key-value-store';

describe('platform MemoryKeyValueStore', () => {
    it('returns the default for a missing key, and copies values in and out', async () => {
        const store = new MemoryKeyValueStore({ seeded: { a: 1 } });
        expect(store.get('missing')).to.equal(undefined);
        expect(store.get('missing', 7)).to.equal(7);

        const value = { list: [1, 2] };
        await store.update('k', value);
        value.list.push(3);
        const read = store.get<{ list: number[] }>('k');
        read?.list.push(4);
        expect(store.get('k')).to.deep.equal({ list: [1, 2] });
        expect([...store.keys()].sort()).to.deep.equal(['k', 'seeded']);
    });

    it('updating to undefined removes the key, as Memento does', async () => {
        const store = new MemoryKeyValueStore({ k: 'v' });
        await store.update('k', undefined);
        expect(store.keys()).to.deep.equal([]);
    });
});
