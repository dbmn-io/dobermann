// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #339: where the API Catalogue is kept. One interface, so VS Code and the web app share a
 * store: Supabase by default (#341), VS Code's local store as the maximum-security option
 * (#342), the web app Supabase only. Items are always in the safe form (catalogue-safe-form.ts);
 * secrets and per-device state live elsewhere on each device.
 */
import { Event } from '../../platform/events';
import { CatalogueConsoleViews, CatalogueEndpoint, CatalogueEnvironment, CatalogueKind, CatalogueSystem, Versioned } from './catalogue.types';

export interface CatalogCollection<T extends { id: string }> {
    list(): Promise<Versioned<T>[]>;
    get(id: string): Promise<Versioned<T> | undefined>;
    /**
     * Create or replace. With `expectedVersion`, the write only succeeds if the stored version
     * still matches; otherwise it throws `CatalogConflictError` (someone changed it elsewhere).
     * `expectedVersion` 0 means create only: it fails if the id already exists, so an id clash
     * can never overwrite another item (seen 2026-10-06).
     */
    save(item: T, expectedVersion?: number): Promise<Versioned<T>>;
    delete(id: string, expectedVersion?: number): Promise<boolean>;
}

export interface CatalogChange {
    kind: CatalogueKind;
    id: string;
    deleted: boolean;
    /** The version after the change (for a delete, the last version). */
    version: number;
}

export interface CatalogStore {
    readonly endpoints: CatalogCollection<CatalogueEndpoint>;
    readonly systems: CatalogCollection<CatalogueSystem>;
    readonly environments: CatalogCollection<CatalogueEnvironment>;
    /** #365: Console views, one item per view scope. */
    readonly views: CatalogCollection<CatalogueConsoleViews>;
    /**
     * Next value of an endpoint's run counter (the endpoint's own, or one array path's, #153).
     * Atomic in shared stores, so two devices never hand out the same number. The first value
     * is 1. `count` reserves a block and returns its last value (#366); `after` is a floor: the
     * counter continues above it if it was lower.
     */
    nextSequence(endpointId: string, arrayPath?: string, options?: SequenceDraw): Promise<number>;
    /**
     * Give back the unused end of a block (values after `usedTo` up to `reservedTo`), only if
     * nothing has been drawn since. False when it couldn't (the values stay a gap).
     */
    returnSequence(endpointId: string, arrayPath: string | undefined, reservedTo: number, usedTo: number): Promise<boolean>;
    /** Back to 0: one array path, or (no path) the endpoint's own counter. */
    resetSequence(endpointId: string, arrayPath?: string): Promise<void>;
    /** Every array path's counter back to 0 (#153's reset with no path). */
    resetArraySequences(endpointId: string): Promise<void>;
    /** Fired for every change, made here or (in shared stores) on another device. */
    readonly onChanged: Event<CatalogChange>;
}

export interface SequenceDraw {
    /** How many values to reserve (default 1). */
    count?: number;
    /** Continue above this value if the counter is lower (a device's counter from before #366). */
    after?: number;
}

export class CatalogConflictError extends Error {
    constructor(
        readonly kind: CatalogueKind,
        readonly id: string,
        readonly expectedVersion: number,
        readonly actualVersion: number | undefined
    ) {
        super(`${kind} ${id} was changed elsewhere (expected version ${expectedVersion}, found ${actualVersion ?? 'none'})`);
        this.name = 'CatalogConflictError';
    }
}
