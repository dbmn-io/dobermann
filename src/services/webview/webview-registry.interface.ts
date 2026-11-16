// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * WebviewRegistry Interface
 *
 * Interface for centralized webview management service
 */

import * as vscode from 'vscode';

export interface IWebviewRegistryService {
    /**
     * SINGLETON PATTERN: Register webview that allows only 1 at a time (endpoint/environment)
     */
    registerSingletonWebview(
        type: 'endpoint' | 'environment',
        panel: vscode.WebviewPanel,
        options?: { endpointId?: string; environmentId?: string }
    ): void;

    /**
     * Focus existing singleton webview if it exists
     */
    focusSingletonWebviewIfExists(type: 'endpoint' | 'environment'): boolean;

    /**
     * Get registry statistics for debugging
     */
    getStats(): { total: number; byType: Record<string, number> };
}