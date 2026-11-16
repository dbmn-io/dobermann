// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #319: small persistent key/value state — what VS Code calls a Memento
 * (`context.globalState` / `workspaceState`). Shaped like Memento on purpose, so the VS Code
 * shell passes `context.globalState` straight in. The web shell will back it with IndexedDB
 * (#329); `test:core` uses `platform/memory/memory-key-value-store.ts`.
 *
 * Values must be JSON-serialisable. Not for secrets — those are #327.
 */
export interface IKeyValueStore {
    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: unknown): PromiseLike<void>;
    keys(): readonly string[];
}
