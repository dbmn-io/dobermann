// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { APIEndpointManager } from '../../../apiEndpointManager';
import { CatalogueState } from '../../../services/catalogue/catalogue-state';
import { KeyValueCatalogStore } from '../../../services/catalogue/key-value-catalog-store';
import { AccountRunCounters } from '../../../services/catalogue/run-counters';
import { MemoryKeyValueStore } from '../../../platform/memory/memory-key-value-store';
import type { ISecretStore } from '../../../platform/interfaces/secret-store.interface';

/**
 * #366: run counters come from the user's catalogue, so two devices (VS Code and the web app,
 * or two machines) on one account never hand out the same value.
 */
class MemoryVault implements ISecretStore {
    readonly values = new Map<string, string>();
    async get(key: string) { return this.values.get(key); }
    async store(key: string, value: string) { this.values.set(key, value); }
    async delete(key: string) { this.values.delete(key); }
}

const endpoint = { id: 'ep-1', name: 'Create Order', method: 'POST', path: '/orders', headers: {}, queryParams: {}, body: '{}' };

async function signedIn(catalogue: KeyValueCatalogStore, device = new MemoryKeyValueStore()) {
    const state = new CatalogueState(catalogue, device, new MemoryVault());
    await state.load();
    return { state, device, manager: new APIEndpointManager(state) };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('Run counters in the account (#366)', () => {
    it('two devices on one account never hand out the same value', async () => {
        const catalogue = new KeyValueCatalogStore(new MemoryKeyValueStore());
        const laptop = await signedIn(catalogue);
        await laptop.state.globalState.update('apiEndpoints', { endpoints: [endpoint], folders: [], version: '1.1.0' });
        const web = await signedIn(catalogue);

        const drawn: number[] = [];
        for (let i = 0; i < 5; i++) {
            drawn.push(await laptop.manager.getNextSequence('ep-1'));
            drawn.push(await web.manager.getNextSequence('ep-1'));
        }
        expect(new Set(drawn).size, `drawn: ${drawn.join(', ')}`).to.equal(drawn.length);
        drawn.push(await laptop.manager.getNextArraySequence('ep-1', 'lines[]'));
        expect(await web.manager.getNextArraySequence('ep-1', 'lines[]')).to.not.equal(drawn[drawn.length - 1]);
    });

    it('a device\'s counter from before #366 is the floor, once', async () => {
        const catalogue = new KeyValueCatalogStore(new MemoryKeyValueStore());
        const laptop = await signedIn(catalogue);
        await laptop.state.globalState.update('apiEndpoints', {
            endpoints: [{ ...endpoint, sequenceCounter: 1500, arraySequenceCounters: { 'lines[]': 7 } }], folders: [], version: '1.1.0'
        });
        expect(await laptop.manager.getNextSequence('ep-1')).to.equal(1501);
        expect(await laptop.manager.getNextArraySequence('ep-1', 'lines[]')).to.equal(8);

        await laptop.manager.resetSequence('ep-1');
        await laptop.state.runCounters.flush();
        expect(await laptop.manager.getNextSequence('ep-1'), 'after a reset, no floor').to.equal(1);
    });

    it('a batch reserves blocks, and the unused end goes back after a pause', async () => {
        const catalogue = new KeyValueCatalogStore(new MemoryKeyValueStore());
        let draws = 0;
        const counting = new Proxy(catalogue, {
            get(target, property, receiver) {
                if (property === 'nextSequence') draws++;
                return Reflect.get(target, property, receiver);
            }
        });
        const seededKeys = new Set<string>();
        const counters = new AccountRunCounters(counting, {
            floor: () => 0,
            seeded: { has: key => seededKeys.has(key), add: async key => { seededKeys.add(key); } },
            idleMs: 50
        });

        const values: number[] = [];
        for (let i = 0; i < 300; i++) values.push(await counters.next('ep-1'));
        expect(values).to.deep.equal(Array.from({ length: 300 }, (_, i) => i + 1));
        expect(draws, 'round trips for 300 values').to.be.below(12);

        await sleep(120);
        expect(await counters.next('ep-1'), 'contiguous after the pause').to.equal(301);
    });

    it('account unreachable: carries on from this device\'s copy with a warning, and the account catches up after', async () => {
        const catalogue = new KeyValueCatalogStore(new MemoryKeyValueStore());
        let down = false;
        const flaky = new Proxy(catalogue, {
            get(target, property, receiver) {
                if (property === 'nextSequence' && down) return async () => { throw new Error('Failed to fetch'); };
                return Reflect.get(target, property, receiver);
            }
        });
        const device = new MemoryKeyValueStore();
        const signIn = async () => {
            const state = new CatalogueState(flaky, device, new MemoryVault());
            await state.load();
            let warnings = 0;
            state.onCountersLocal = () => { warnings++; };
            return { manager: new APIEndpointManager(state), state, warnings: () => warnings };
        };
        const laptop = await signIn();
        await laptop.state.globalState.update('apiEndpoints', { endpoints: [endpoint], folders: [], version: '1.1.0' });
        expect([await laptop.manager.getNextSequence('ep-1'), await laptop.manager.getNextSequence('ep-1')]).to.deep.equal([1, 2]);

        down = true;
        const offline = [await laptop.manager.getNextSequence('ep-1'), await laptop.manager.getNextSequence('ep-1'), await laptop.manager.getNextSequence('ep-1')];
        expect(offline, 'never the start value, never a repeat').to.deep.equal([3, 4, 5]);
        expect(laptop.warnings(), 'one warning, not one per draw').to.equal(1);

        // Back in reach (VS Code restarted meanwhile: the copy is on the device, not in memory)
        down = false;
        const again = await signIn();
        expect(await again.manager.getNextSequence('ep-1'), 'the account jumps past what the device handed out').to.equal(6);
        const web = await signedIn(catalogue);
        expect(await web.manager.getNextSequence('ep-1')).to.equal(7);
        expect(again.warnings()).to.equal(0);
    });

    it('a reset clears this device\'s copy too: the next draw is 1 even if the account then drops', async () => {
        const catalogue = new KeyValueCatalogStore(new MemoryKeyValueStore());
        let down = false;
        const flaky = new Proxy(catalogue, {
            get(target, property, receiver) {
                if (property === 'nextSequence' && down) return async () => { throw new Error('Failed to fetch'); };
                return Reflect.get(target, property, receiver);
            }
        });
        const laptop = await signedIn(flaky as unknown as KeyValueCatalogStore);
        await laptop.state.globalState.update('apiEndpoints', { endpoints: [endpoint], folders: [], version: '1.1.0' });
        for (let i = 0; i < 4; i++) await laptop.manager.getNextSequence('ep-1');
        await laptop.manager.resetSequence('ep-1');
        down = true;
        expect(await laptop.manager.getNextSequence('ep-1')).to.equal(1);
    });

    it('another device drawing meanwhile: the block stays a gap, never reused', async () => {
        const catalogue = new KeyValueCatalogStore(new MemoryKeyValueStore());
        const seeded = () => { const keys = new Set<string>(); return { has: (k: string) => keys.has(k), add: async (k: string) => { keys.add(k); } }; };
        const laptop = new AccountRunCounters(catalogue, { floor: () => 0, seeded: seeded(), idleMs: 50 });
        const web = new AccountRunCounters(catalogue, { floor: () => 0, seeded: seeded(), idleMs: 50 });

        const first = [await laptop.next('ep-1'), await laptop.next('ep-1'), await laptop.next('ep-1')];   // block 1 + block 2..3
        await laptop.next('ep-1');                    // block of 4 reserved: 4..7
        const fromWeb = await web.next('ep-1');       // 8
        await sleep(120);                             // laptop's give-back fails: 5..7 stay a gap
        const later = await laptop.next('ep-1');
        expect(first).to.deep.equal([1, 2, 3]);
        expect(fromWeb).to.equal(8);
        expect(later).to.equal(9);
    });
});
