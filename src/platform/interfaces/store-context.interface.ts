// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * What the catalogue managers (APIEndpointManager, EnvironmentManager, SystemManager) persist
 * through. VS Code passes its ExtensionContext (globalState + secrets); the web app passes
 * state backed by the Supabase catalogue and the browser.
 */
import type { IKeyValueStore } from './key-value-store.interface';
import type { ISecretStore } from './secret-store.interface';

export interface StoreContext {
    globalState: Pick<IKeyValueStore, 'get' | 'update'>;
    secrets: ISecretStore;
    /**
     * #366: run counters kept in the user's catalogue (atomic across devices). Absent, the
     * managers count on the endpoint in this store, as before.
     */
    runCounters?: RunCounters;
}

/** An endpoint's run counters (#153): its own (no array path), and one per array path. */
export interface RunCounters {
    next(endpointId: string, arrayPath?: string): Promise<number>;
    reset(endpointId: string, arrayPath?: string): Promise<void>;
    /** Every array path's counter back to 0. */
    resetArrays(endpointId: string): Promise<void>;
    /** Give back values reserved but not used (sign-out, shutdown). */
    flush(): Promise<void>;
}
