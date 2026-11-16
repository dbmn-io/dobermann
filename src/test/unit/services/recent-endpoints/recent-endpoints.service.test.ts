// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import {
    RecentEndpointsService,
    RECENT_ENDPOINTS_STORAGE_KEY,
    RECENT_ENDPOINTS_MAX
} from '../../../../services/recent-endpoints/recent-endpoints.service';

describe('RecentEndpointsService', () => {
    let backing: Map<string, unknown>;
    let clock: number;
    let service: RecentEndpointsService;

    const store = () => ({
        get: <T>(key: string) => backing.get(key) as T | undefined,
        update: (key: string, value: unknown) => { backing.set(key, value); return Promise.resolve(); }
    });

    beforeEach(() => {
        backing = new Map();
        clock = 1000;
        service = new RecentEndpointsService(store(), () => clock);
    });

    it('starts empty when nothing is stored', () => {
        expect(service.list()).to.deep.equal([]);
    });

    it('touch() puts the endpoint first and persists to globalState', async () => {
        await service.touch('a');
        clock = 2000;
        await service.touch('b');
        expect(service.list().map(e => e.id)).to.deep.equal(['b', 'a']);
        expect(backing.get(RECENT_ENDPOINTS_STORAGE_KEY)).to.deep.equal([
            { id: 'b', touchedAt: 2000 },
            { id: 'a', touchedAt: 1000 }
        ]);
    });

    it('touching an existing id moves it to the front without duplicating', async () => {
        await service.touch('a');
        await service.touch('b');
        clock = 3000;
        await service.touch('a');
        expect(service.list()).to.deep.equal([
            { id: 'a', touchedAt: 3000 },
            { id: 'b', touchedAt: 1000 }
        ]);
    });

    it('ignores empty and draft (new-*) ids', async () => {
        await service.touch('');
        await service.touch('new-123');
        expect(service.list()).to.deep.equal([]);
        expect(backing.has(RECENT_ENDPOINTS_STORAGE_KEY)).to.equal(false);
    });

    it('caps the list at RECENT_ENDPOINTS_MAX, dropping the oldest', async () => {
        for (let i = 0; i < RECENT_ENDPOINTS_MAX + 5; i++) {
            clock = i;
            await service.touch('ep-' + i);
        }
        const ids = service.list().map(e => e.id);
        expect(ids).to.have.length(RECENT_ENDPOINTS_MAX);
        expect(ids[0]).to.equal('ep-' + (RECENT_ENDPOINTS_MAX + 4));
        expect(ids).to.not.include('ep-0');
    });

    it('remove() drops the id and only persists when something changed', async () => {
        await service.touch('a');
        backing.clear();
        await service.remove('missing');
        expect(backing.has(RECENT_ENDPOINTS_STORAGE_KEY)).to.equal(false);
        await service.remove('a');
        expect(service.list()).to.deep.equal([]);
        expect(backing.get(RECENT_ENDPOINTS_STORAGE_KEY)).to.deep.equal([]);
    });

    it('prune() keeps only ids that still exist', async () => {
        await service.touch('a');
        await service.touch('b');
        await service.touch('c');
        await service.prune(['b']);
        expect(service.list().map(e => e.id)).to.deep.equal(['b']);
    });

    it('loads, sorts, and sanitises whatever is in storage', () => {
        backing.set(RECENT_ENDPOINTS_STORAGE_KEY, [
            { id: 'old', touchedAt: 1 },
            { id: 'new', touchedAt: 9 },
            { id: 'new', touchedAt: 5 },          // duplicate → first wins
            { id: 42, touchedAt: 7 },             // bad id
            { id: 'x' },                          // missing timestamp
            'garbage'
        ]);
        const s = new RecentEndpointsService(store(), () => 0);
        expect(s.list()).to.deep.equal([
            { id: 'new', touchedAt: 9 },
            { id: 'old', touchedAt: 1 }
        ]);
    });

    it('tolerates a non-array value in storage', () => {
        backing.set(RECENT_ENDPOINTS_STORAGE_KEY, { nope: true });
        expect(new RecentEndpointsService(store()).list()).to.deep.equal([]);
    });

    it('fires onDidChange on touch and remove, and disposal unsubscribes', async () => {
        let fired = 0;
        const sub = service.onDidChange(() => { fired++; });
        await service.touch('a');
        await service.remove('a');
        expect(fired).to.equal(2);
        sub.dispose();
        await service.touch('b');
        expect(fired).to.equal(2);
    });
});
