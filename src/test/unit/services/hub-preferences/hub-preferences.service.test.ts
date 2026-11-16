// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import {
    HubPreferencesService,
    HUB_PREFERENCES_STORAGE_KEY,
    HUB_PREFERENCES_MAX_JSON_BYTES
} from '../../../../services/hub-preferences/hub-preferences.service';

describe('HubPreferencesService', () => {
    let backing: Map<string, unknown>;
    let service: HubPreferencesService;

    beforeEach(() => {
        backing = new Map();
        service = new HubPreferencesService({
            get: <T>(key: string) => backing.get(key) as T | undefined,
            update: (key: string, value: unknown) => { backing.set(key, value); return Promise.resolve(); }
        });
    });

    it('returns an empty object when nothing is stored', () => {
        expect(service.get()).to.deep.equal({});
    });

    it('stores and returns a preferences object', async () => {
        expect(await service.set({ catalogueGroupBy: 'url', hubCol2Width: 320, transactionsStatusFilters: ['error'] })).to.equal(true);
        expect(service.get()).to.deep.equal({ catalogueGroupBy: 'url', hubCol2Width: 320, transactionsStatusFilters: ['error'] });
        expect(backing.get(HUB_PREFERENCES_STORAGE_KEY)).to.deep.equal(service.get());
    });

    it('returns a copy, not the stored reference', () => {
        backing.set(HUB_PREFERENCES_STORAGE_KEY, { a: 1 });
        const got = service.get();
        got.a = 2;
        expect((backing.get(HUB_PREFERENCES_STORAGE_KEY) as { a: number }).a).to.equal(1);
    });

    it('rejects non-objects and leaves storage untouched', async () => {
        await service.set({ keep: true });
        for (const bad of [null, undefined, 'x', 42, ['a'], () => 1]) {
            expect(await service.set(bad)).to.equal(false);
        }
        expect(service.get()).to.deep.equal({ keep: true });
    });

    it('rejects an oversized object', async () => {
        const big = { blob: 'x'.repeat(HUB_PREFERENCES_MAX_JSON_BYTES + 1) };
        expect(await service.set(big)).to.equal(false);
        expect(service.get()).to.deep.equal({});
    });

    it('strips undefined values via JSON round-trip', async () => {
        await service.set({ a: 1, gone: undefined });
        expect(service.get()).to.deep.equal({ a: 1 });
    });

    it('treats a corrupt stored value as empty', () => {
        backing.set(HUB_PREFERENCES_STORAGE_KEY, 'not an object');
        expect(service.get()).to.deep.equal({});
    });
});
