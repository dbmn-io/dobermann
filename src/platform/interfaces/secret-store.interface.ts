// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #327: secrets (environment tokens), kept apart from ordinary state. Shaped like
 * `vscode.SecretStorage`, so the VS Code shell passes `context.secrets` straight in; the web
 * shell keeps them in the browser, never in the catalogue.
 */
export interface ISecretStore {
    get(key: string): PromiseLike<string | undefined>;
    store(key: string, value: string): PromiseLike<void>;
    delete(key: string): PromiseLike<void>;
}
