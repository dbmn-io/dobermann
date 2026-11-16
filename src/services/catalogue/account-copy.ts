// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #427: this computer's working copy of an account's API Catalogue, so signing out is like going
 * offline, never an empty catalogue (James, 2026-11-05: the Obsidian model, predictable above all).
 *
 * - Signed in, the account's catalogue is read and written through `MirroredCatalogStore`: every
 *   list, save and delete that reaches the account is also written to the copy, with the
 *   account's version. That version is the copy's `base`: what the account had when this device
 *   last heard from it.
 * - Signed out, the managers work on the copy itself (`OfflineCatalogStore`): the same endpoints,
 *   environments, Systems and Console views, editable. An edit raises the copy's version past
 *   its base; a new item has no base; a deleted one has a base and no row. Run counters never
 *   come from the copy (they throw, so AccountRunCounters counts on from this device's own copy
 *   of each counter and the account jumps past those values at the next draw).
 * - Signing in again, `sendOfflineChanges` sends what changed here before anything is loaded:
 *     changed here only            saved over the account's version
 *     new here                     created
 *     deleted here                 deleted, unless the account changed it meanwhile (kept)
 *     deleted in the account, changed here   created again (a change wins over a delete)
 *     changed in both places       the newer one wins, and an endpoint or environment that
 *                                  lost is kept beside it as "<name> (copy)". Systems and
 *                                  Console views: the newer one wins.
 *   Each item's base moves as soon as it is sent, so a sign-in that fails half way sends only
 *   the rest next time.
 * - A copy belongs to one account. Signing in as someone else never sends it there.
 * - Secrets are never in the copy: they stay in the vault, keyed by environment, as signed in.
 */
import { EventEmitter } from '../../platform/events';
import type { IKeyValueStore } from '../../platform/interfaces/key-value-store.interface';
import { CatalogConflictError, type CatalogChange, type CatalogCollection, type CatalogStore } from './catalog-store.interface';
import type { CatalogueKind, Versioned } from './catalogue.types';
import { CATALOGUE_KEYS as COPY_KEYS, KeyValueCatalogStore } from './key-value-catalog-store';

type Item = { id: string; name?: string };
type Rows = Record<string, Versioned<Item>>;
/** The account's version of each item when this device last heard from it, per kind. */
type Base = Partial<Record<CatalogueKind, Record<string, number>>>;

const KINDS: CatalogueKind[] = ['endpoints', 'environments', 'systems', 'views'];
const BASE_KEY = 'dbmnCatalogue.base';

export type OfflineChange = { kind: CatalogueKind; id: string; change: 'created' | 'changed' | 'deleted' };

export class AccountCopy {
    /** The copy as a CatalogStore of its own (the signed-out managers' store). */
    readonly local: KeyValueCatalogStore;

    constructor(private readonly kv: IKeyValueStore) {
        this.local = new KeyValueCatalogStore(kv);
    }

    private rows(kind: CatalogueKind): Rows {
        return this.kv.get<Rows>(COPY_KEYS[kind], {});
    }

    private base(): Base {
        return this.kv.get<Base>(BASE_KEY, {});
    }

    /** Anything here: a catalogue to work on while signed out. */
    get exists(): boolean {
        return this.kv.get<Base>(BASE_KEY) !== undefined;
    }

    /** The account's whole list of one kind, as it is now: the copy and its base follow it. */
    async mirror(kind: CatalogueKind, rows: Versioned<Item>[]): Promise<void> {
        await this.kv.update(COPY_KEYS[kind], Object.fromEntries(rows.map(row => [row.item.id, row])));
        await this.kv.update(BASE_KEY, { ...this.base(), [kind]: Object.fromEntries(rows.map(row => [row.item.id, row.version])) });
    }

    /** One item as the account now has it. */
    async saved(kind: CatalogueKind, row: Versioned<Item>): Promise<void> {
        await this.kv.update(COPY_KEYS[kind], { ...this.rows(kind), [row.item.id]: row });
        const base = this.base();
        await this.kv.update(BASE_KEY, { ...base, [kind]: { ...(base[kind] ?? {}), [row.item.id]: row.version } });
    }

    /** One item gone from the account (and so from here). */
    async deleted(kind: CatalogueKind, id: string): Promise<void> {
        const rows = { ...this.rows(kind) };
        delete rows[id];
        await this.kv.update(COPY_KEYS[kind], rows);
        const base = this.base();
        const ofKind = { ...(base[kind] ?? {}) };
        delete ofKind[id];
        await this.kv.update(BASE_KEY, { ...base, [kind]: ofKind });
    }

    /** What changed here since this device last heard from the account. */
    pending(): OfflineChange[] {
        const base = this.base();
        const changes: OfflineChange[] = [];
        for (const kind of KINDS) {
            const rows = this.rows(kind);
            const known = base[kind] ?? {};
            for (const [id, row] of Object.entries(rows)) {
                if (known[id] === undefined) changes.push({ kind, id, change: 'created' });
                else if (known[id] !== row.version) changes.push({ kind, id, change: 'changed' });
            }
            for (const id of Object.keys(known)) {
                if (!rows[id]) changes.push({ kind, id, change: 'deleted' });
            }
        }
        return changes;
    }

    row(kind: CatalogueKind, id: string): Versioned<Item> | undefined {
        return this.rows(kind)[id];
    }

    baseVersion(kind: CatalogueKind, id: string): number | undefined {
        return this.base()[kind]?.[id];
    }

    /** Every environment id the copy holds (their secrets go when the copy goes). */
    environmentIds(): string[] {
        return Object.keys(this.rows('environments'));
    }

    /** Remove the copy from this computer. */
    async clear(): Promise<void> {
        for (const key of [...KINDS.map(kind => COPY_KEYS[kind]), COPY_KEYS.sequences, BASE_KEY]) {
            await this.kv.update(key, undefined);
        }
    }
}

/** `kv` under a prefix, as a whole IKeyValueStore (the copy of one account lives under its own). */
export function prefixedStore(kv: IKeyValueStore, prefix: string): IKeyValueStore {
    return {
        get: ((key: string, defaultValue?: unknown) => kv.get(prefix + key, defaultValue)) as IKeyValueStore['get'],
        update: (key: string, value: unknown) => kv.update(prefix + key, value),
        keys: () => kv.keys().filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length))
    };
}

class MirroredCollection<T extends Item> implements CatalogCollection<T> {
    constructor(private readonly remote: CatalogCollection<T>, private readonly copy: AccountCopy, private readonly kind: CatalogueKind) {}

    async list(): Promise<Versioned<T>[]> {
        const rows = await this.remote.list();
        await this.copy.mirror(this.kind, rows);
        return rows;
    }

    get(id: string): Promise<Versioned<T> | undefined> {
        return this.remote.get(id);
    }

    async save(item: T, expectedVersion?: number): Promise<Versioned<T>> {
        const saved = await this.remote.save(item, expectedVersion);
        await this.copy.saved(this.kind, saved);
        return saved;
    }

    async delete(id: string, expectedVersion?: number): Promise<boolean> {
        const deleted = await this.remote.delete(id, expectedVersion);
        await this.copy.deleted(this.kind, id);
        return deleted;
    }
}

/** Signed in: the account's catalogue, every answer also written to this computer's copy. */
export class MirroredCatalogStore implements CatalogStore {
    readonly endpoints: CatalogStore['endpoints'];
    readonly systems: CatalogStore['systems'];
    readonly environments: CatalogStore['environments'];
    readonly views: CatalogStore['views'];
    readonly onChanged: CatalogStore['onChanged'];

    constructor(private readonly remote: CatalogStore, copy: AccountCopy) {
        this.endpoints = new MirroredCollection(remote.endpoints, copy, 'endpoints');
        this.systems = new MirroredCollection(remote.systems, copy, 'systems');
        this.environments = new MirroredCollection(remote.environments, copy, 'environments');
        this.views = new MirroredCollection(remote.views, copy, 'views');
        this.onChanged = remote.onChanged;
    }

    nextSequence(...args: Parameters<CatalogStore['nextSequence']>) { return this.remote.nextSequence(...args); }
    returnSequence(...args: Parameters<CatalogStore['returnSequence']>) { return this.remote.returnSequence(...args); }
    resetSequence(...args: Parameters<CatalogStore['resetSequence']>) { return this.remote.resetSequence(...args); }
    resetArraySequences(...args: Parameters<CatalogStore['resetArraySequences']>) { return this.remote.resetArraySequences(...args); }
}

/** Signed out, a draw from the account's counters: AccountRunCounters counts on this device instead. */
export class SignedOutError extends Error {
    constructor() {
        super('Signed out of DBMN: run counters come from this device');
        this.name = 'SignedOutError';
    }
}

/** Signed out: the copy, editable. Run counters are never drawn from it (see the header). */
export class OfflineCatalogStore implements CatalogStore {
    readonly endpoints: CatalogStore['endpoints'];
    readonly systems: CatalogStore['systems'];
    readonly environments: CatalogStore['environments'];
    readonly views: CatalogStore['views'];
    private readonly changed = new EventEmitter<CatalogChange>();
    /** Nothing changes it from elsewhere. */
    readonly onChanged = this.changed.event;

    constructor(copy: AccountCopy) {
        this.endpoints = copy.local.endpoints;
        this.systems = copy.local.systems;
        this.environments = copy.local.environments;
        this.views = copy.local.views;
    }

    async nextSequence(): Promise<number> { throw new SignedOutError(); }
    async returnSequence(): Promise<boolean> { return false; }
    /** The account's counter is left as it is: the next draw only ever continues above it. */
    async resetSequence(): Promise<void> { /* nothing to reset here */ }
    async resetArraySequences(): Promise<void> { /* nothing to reset here */ }
}

export interface SentOfflineChanges {
    sent: number;
    /** Changed here and in the account: which one was kept, and the copy made of the other. */
    conflicts: Array<{ kind: CatalogueKind; name: string; kept: 'here' | 'account'; copyName?: string }>;
}

export interface SendOptions {
    /** A new id for the copy of an item that lost (default crypto.randomUUID). */
    newId?: () => string;
    /** An environment was copied to a new id: its secrets on this device go with it. */
    onCopied?: (kind: CatalogueKind, fromId: string, toId: string) => Promise<void>;
}

const COPIED_KINDS: CatalogueKind[] = ['endpoints', 'environments'];

/** The changes made here while signed out, to the account (the rules in the header). */
export async function sendOfflineChanges(remote: CatalogStore, copy: AccountCopy, options: SendOptions = {}): Promise<SentOfflineChanges> {
    const newId = options.newId ?? (() => globalThis.crypto.randomUUID());
    const result: SentOfflineChanges = { sent: 0, conflicts: [] };
    for (const { kind, id, change } of copy.pending()) {
        const collection = remote[kind] as CatalogCollection<Item>;
        const base = copy.baseVersion(kind, id);
        const account = await collection.get(id);

        if (change === 'deleted') {
            if (account && account.version !== base) {
                await copy.saved(kind, account);      // changed in the account meanwhile: kept
                continue;
            }
            if (account) await collection.delete(id, base);
            await copy.deleted(kind, id);
            result.sent++;
            continue;
        }

        const here = copy.row(kind, id)!;
        if (!account) {
            // New here, or deleted in the account while it was changed here
            await copy.saved(kind, await collection.save(here.item, 0));
            result.sent++;
            continue;
        }
        if (change === 'changed' && account.version === base) {
            await copy.saved(kind, await saveOver(collection, here.item, base));
            result.sent++;
            continue;
        }

        // Changed in both places (or made twice with one id): the newer one wins
        const hereIsNewer = here.updatedAt >= account.updatedAt;
        const winner = hereIsNewer ? here.item : account.item;
        const loser = hereIsNewer ? account.item : here.item;
        await copy.saved(kind, hereIsNewer ? await collection.save(winner) : account);
        let copyName: string | undefined;
        if (COPIED_KINDS.includes(kind)) {
            copyName = `${loser.name || loser.id} (copy)`;
            const toId = newId();
            await copy.saved(kind, await collection.save({ ...loser, id: toId, name: copyName }, 0));
            await options.onCopied?.(kind, id, toId);
        }
        result.sent++;
        result.conflicts.push({ kind, name: winner.name || id, kept: hereIsNewer ? 'here' : 'account', copyName });
    }
    return result;
}

/** A versioned save; if the account moved on in the meantime, this device's change still goes in. */
async function saveOver(collection: CatalogCollection<Item>, item: Item, version: number | undefined): Promise<Versioned<Item>> {
    try {
        return await collection.save(item, version);
    } catch (error) {
        if (!(error instanceof CatalogConflictError)) throw error;
        return collection.save(item);
    }
}

const KIND_NOUN: Record<CatalogueKind, string> = { endpoints: 'endpoint', environments: 'environment', systems: 'System', views: 'Console views of' };

/** What the user is told after signing in, or nothing when nothing was waiting. */
export function offlineChangesMessage(result: SentOfflineChanges): string | undefined {
    if (result.sent === 0) return undefined;
    const sent = `Sent ${result.sent} ${result.sent === 1 ? 'change' : 'changes'} you made while signed out to your DBMN account.`;
    const both = result.conflicts.map(c => {
        const kept = c.kept === 'here' ? 'this computer\'s, the newer one, is kept' : 'your account\'s, the newer one, is kept';
        return `The ${KIND_NOUN[c.kind]} "${c.name}" was changed in both places: ${kept}${c.copyName ? `, and the other is saved as "${c.copyName}"` : ''}.`;
    });
    return [sent, ...both].join(' ');
}
