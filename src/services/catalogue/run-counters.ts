// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #366: run counters (#153) drawn from the user's catalogue, so VS Code, the web app and other
 * devices never hand out the same value. Before #366 each device counted in its own state.
 *
 * - Blocks: a batch draws a value per row, and a round trip per value would be slow. A draw that
 *   follows another quickly reserves twice as many (1, 2, 4 … up to 500); after a pause the
 *   unused end goes back to the account, so one device drawing alone gets contiguous numbers.
 *   A block lost (VS Code closed, another device drew meanwhile) leaves a gap: gaps are fine,
 *   reuse is not (#288).
 * - The device's old counter is a floor: the first draw of each counter carries it, so the
 *   account's counter never starts again below a value this device already used. Once.
 * - This device keeps its own copy: the highest value it has been given per counter. When the
 *   account can't be reached (offline, Supabase down, sign-in expired) a draw carries on from
 *   that copy, never from the start value, and the host is told (onLocal) so the user sees a
 *   warning. Back in reach, the copy is the floor of the next draw, so the account's counter
 *   jumps past everything this device handed out meanwhile. Two devices cut off at once can
 *   still hand out the same numbers: accepted (2026-10-11), the warning says so.
 * - Draws of one counter run one at a time; different counters don't wait for each other.
 */
import type { RunCounters } from '../../platform/interfaces/store-context.interface';
import type { CatalogStore } from './catalog-store.interface';

export interface RunCounterOptions {
    /** The counter this device kept before #366 (0 if none). */
    floor(endpointId: string, arrayPath?: string): number;
    /** Counters whose floor has been passed (or that were reset): no floor from then on. */
    seeded: { has(key: string): boolean; add(key: string): Promise<void> };
    /**
     * This device's copy of each counter: the highest value it has been given (`last`), and
     * whether it counted on its own while the account couldn't be reached (`ahead`: its copy
     * is then the floor of the next draw from the account). In memory when absent.
     */
    local?: LocalCounters;
    /** The account couldn't be reached and numbers are coming from this device: warn the user. */
    onLocal?(): void;
    /** A pause this long returns the unused end of a block. */
    idleMs?: number;
    maxBlock?: number;
    /** After a failed draw, how long to count locally before trying the account again. */
    retryMs?: number;
    log?: (message: string, error?: unknown) => void;
}

export interface LocalCounters {
    get(key: string): { last: number; ahead: boolean };
    set(key: string, value: { last: number; ahead: boolean }): Promise<void>;
    /** Every array path's copy of an endpoint back to 0 (resetArrays). */
    clearArrays(endpointId: string): Promise<void>;
}

/** What both hosts tell the user when numbers start coming from the device. */
export const RUN_COUNTERS_LOCAL_MESSAGE = 'Sequence numbers are coming from this device: your DBMN account can\'t be reached. ' +
    'Another device could use the same numbers until it is back.';

/** #427: the same, signed out (the catalogue is this computer's copy of the account's). */
export const RUN_COUNTERS_OFFLINE_MESSAGE = 'Sequence numbers are coming from this computer while you\'re signed out. ' +
    'The web app or another computer could use the same numbers until you sign in again.';

/** The same warning at most this often. */
const WARN_EVERY_MS = 5 * 60 * 1000;

function memoryCounters(): LocalCounters {
    const values = new Map<string, { last: number; ahead: boolean }>();
    return {
        get: key => values.get(key) ?? { last: 0, ahead: false },
        set: async (key, value) => { values.set(key, value); },
        clearArrays: async endpointId => {
            for (const key of [...values.keys()]) if (key.startsWith(`${endpointId}\u0000`) && key !== keyOf(endpointId)) values.delete(key);
        }
    };
}

interface Block {
    endpointId: string;
    arrayPath?: string;
    next: number;
    to: number;
    size: number;
    reservedAt: number;
    timer?: ReturnType<typeof setTimeout>;
}

const keyOf = (endpointId: string, arrayPath?: string) => `${endpointId}\u0000${arrayPath ?? ''}`;
/** Marks every array path of an endpoint as reset (resetArrays). */
const allArraysKey = (endpointId: string) => `${endpointId}\u0000*`;

export class AccountRunCounters implements RunCounters {
    private readonly blocks = new Map<string, Block>();
    private readonly chains = new Map<string, Promise<unknown>>();
    private readonly idleMs: number;
    private readonly maxBlock: number;
    private readonly retryMs: number;
    private readonly local: LocalCounters;
    /** The account couldn't be reached: count locally until then. */
    private unreachableUntil = 0;
    private warnedAt = 0;

    constructor(private readonly store: CatalogStore, private readonly options: RunCounterOptions) {
        this.idleMs = options.idleMs ?? 1500;
        this.maxBlock = options.maxBlock ?? 500;
        this.retryMs = options.retryMs ?? 30_000;
        this.local = options.local ?? memoryCounters();
    }

    next(endpointId: string, arrayPath?: string): Promise<number> {
        return this.inTurn(keyOf(endpointId, arrayPath), () => this.draw(endpointId, arrayPath));
    }

    reset(endpointId: string, arrayPath?: string): Promise<void> {
        const key = keyOf(endpointId, arrayPath);
        return this.inTurn(key, async () => {
            this.drop(key);
            await this.store.resetSequence(endpointId, arrayPath);
            await this.options.seeded.add(key);
            await this.local.set(key, { last: 0, ahead: false });
        });
    }

    async resetArrays(endpointId: string): Promise<void> {
        const arrays = [...this.blocks.entries()].filter(([, block]) => block.endpointId === endpointId && block.arrayPath !== undefined);
        await Promise.all(arrays.map(([key]) => this.inTurn(key, async () => this.drop(key))));
        await this.store.resetArraySequences(endpointId);
        await this.options.seeded.add(allArraysKey(endpointId));
        await this.local.clearArrays(endpointId);
    }

    /** Give back every block's unused end now (sign-out, shutdown). */
    async flush(): Promise<void> {
        await Promise.all([...this.blocks.keys()].map(key => this.inTurn(key, () => this.giveBack(key))));
    }

    private async draw(endpointId: string, arrayPath?: string): Promise<number> {
        const key = keyOf(endpointId, arrayPath);
        const block = this.blocks.get(key);
        if (block && block.next <= block.to) {
            this.idleLater(key, block);
            return block.next++;
        }
        const now = Date.now();
        const size = block && now - block.reservedAt < this.idleMs ? Math.min(block.size * 2, this.maxBlock) : 1;
        const seeded = this.isSeeded(endpointId, arrayPath);
        const own = this.local.get(key);
        // Floors: the device's counter from before #366 (once), and its own copy when it has
        // counted on its own since the account last answered
        const after = Math.max(seeded ? 0 : this.options.floor(endpointId, arrayPath), own.ahead ? own.last : 0);
        if (block?.timer) clearTimeout(block.timer);
        if (now < this.unreachableUntil) return this.drawLocally(key, after);
        let to: number;
        try {
            to = await this.store.nextSequence(endpointId, arrayPath, { count: size, after });
        } catch (error) {
            this.unreachableUntil = now + this.retryMs;
            this.options.log?.(`[RunCounters] the account's counter for ${endpointId} couldn't be reached: counting on this device`, error);
            if (now - this.warnedAt > WARN_EVERY_MS) {
                this.warnedAt = now;
                this.options.onLocal?.();
            }
            return this.drawLocally(key, after);
        }
        if (!seeded) await this.options.seeded.add(key);
        await this.local.set(key, { last: to, ahead: false });
        const reserved: Block = { endpointId, arrayPath, next: to - size + 2, to, size, reservedAt: now };
        this.blocks.set(key, reserved);
        this.idleLater(key, reserved);
        return to - size + 1;
    }

    /**
     * The account can't be reached: the next value from this device's copy (or the old device
     * counter, whichever is higher). Marked ahead, so the account catches up on the next draw
     * that reaches it.
     */
    private async drawLocally(key: string, floor: number): Promise<number> {
        this.drop(key);
        const value = Math.max(this.local.get(key).last, floor) + 1;
        await this.local.set(key, { last: value, ahead: true });
        return value;
    }

    private isSeeded(endpointId: string, arrayPath?: string): boolean {
        const { seeded } = this.options;
        return seeded.has(keyOf(endpointId, arrayPath)) || (arrayPath !== undefined && seeded.has(allArraysKey(endpointId)));
    }

    private idleLater(key: string, block: Block): void {
        if (block.timer) clearTimeout(block.timer);
        block.timer = setTimeout(() => {
            void this.inTurn(key, () => this.giveBack(key));
        }, this.idleMs);
        (block.timer as { unref?: () => void }).unref?.();
    }

    /** The unused end of a block back to the account (if nothing was drawn since). */
    private async giveBack(key: string): Promise<void> {
        const block = this.blocks.get(key);
        if (!block) return;
        this.drop(key);
        if (block.next > block.to) return;
        try {
            const returned = await this.store.returnSequence(block.endpointId, block.arrayPath, block.to, block.next - 1);
            // This device's copy follows what it actually used (kept at the block's end otherwise)
            if (returned && !this.local.get(key).ahead) await this.local.set(key, { last: block.next - 1, ahead: false });
        } catch (error) {
            this.options.log?.(`[RunCounters] could not give back ${block.next}…${block.to} of ${block.endpointId}: they stay a gap`, error);
        }
    }

    private drop(key: string): void {
        const block = this.blocks.get(key);
        if (block?.timer) clearTimeout(block.timer);
        this.blocks.delete(key);
    }

    /** Run `work` after this counter's earlier work (failed or not). */
    private inTurn<T>(key: string, work: () => Promise<T>): Promise<T> {
        const run = (this.chains.get(key) ?? Promise.resolve()).then(work, work);
        const settledRun = run.catch(() => undefined);
        this.chains.set(key, settledRun);
        void settledRun.then(() => { if (this.chains.get(key) === settledRun) this.chains.delete(key); });
        return run;
    }
}
