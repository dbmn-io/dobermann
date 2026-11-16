// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * WebviewRegistry Service
 *
 * Centralized management of webviews to prevent duplicates and provide
 * consistent behavior for focusing existing webviews vs creating new ones.
 *
 * GitHub Issue #83: Standardize duplicate prevention for individual and batch consoles
 */

import * as vscode from 'vscode';

export interface WebviewRegistryEntry {
    panel: vscode.WebviewPanel;
    type: 'console' | 'endpoint' | 'environment' | 'other';
    executionId?: string;
    endpointId?: string;
    environmentId?: string;
    created: Date;
    disposed: boolean;
}

export class WebviewRegistryService {
    private webviews = new Map<string, WebviewRegistryEntry>();

    /**
     * Register a webview and set up cleanup when disposed
     */
    registerWebview(
        key: string,
        panel: vscode.WebviewPanel,
        type: WebviewRegistryEntry['type'],
        options?: { executionId?: string; endpointId?: string }
    ): void {
        const entry: WebviewRegistryEntry = {
            panel,
            type,
            executionId: options?.executionId,
            endpointId: options?.endpointId,
            created: new Date(),
            disposed: false
        };

        this.webviews.set(key, entry);

        // Clean up when disposed
        panel.onDidDispose(() => {
            entry.disposed = true;
            this.webviews.delete(key);
        });
    }

    /**
     * Get existing webview by key
     */
    getWebview(key: string): vscode.WebviewPanel | null {
        const entry = this.webviews.get(key);
        if (entry && !entry.disposed) {
            return entry.panel;
        }

        // Clean up disposed webview
        if (entry) {
            this.webviews.delete(key);
        }

        return null;
    }

    /**
     * Focus existing webview or return null if it doesn't exist
     */
    focusWebviewIfExists(key: string): boolean {
        const panel = this.getWebview(key);
        if (panel) {
            // Pass no viewColumn so the panel stays in whichever column it
            // was created in. Previously this hardcoded ViewColumn.One,
            // which forcibly relocated the console (created in column 2)
            // into column 1 on top of the Hub when the execution engine
            // re-fired `dbmn.viewTransactionReport` with `focus: true`
            // after completion.
            panel.reveal();
            return true;
        }
        return false;
    }


    /**
     * Get all webviews of a specific type
     */
    getWebviewsByType(type: WebviewRegistryEntry['type']): WebviewRegistryEntry[] {
        return Array.from(this.webviews.values()).filter(entry =>
            entry.type === type && !entry.disposed
        );
    }

    /**
     * Close all webviews of a specific type
     */
    closeWebviewsByType(type: WebviewRegistryEntry['type']): void {
        this.getWebviewsByType(type).forEach(entry => {
            entry.panel.dispose();
        });
    }

    /**
     * Get registry statistics for debugging
     */
    getStats(): { total: number; byType: Record<string, number> } {
        const entries = Array.from(this.webviews.values()).filter(entry => !entry.disposed);
        const byType: Record<string, number> = {};

        entries.forEach(entry => {
            byType[entry.type] = (byType[entry.type] || 0) + 1;
        });

        return {
            total: entries.length,
            byType
        };
    }

    /**
     * SINGLETON PATTERN: For endpoint/environment webviews (only 1 at a time)
     * Close existing webview of same type and register new one
     */
    registerSingletonWebview(
        type: 'endpoint' | 'environment',
        panel: vscode.WebviewPanel,
        options?: { endpointId?: string; environmentId?: string }
    ): void {
        // Close any existing webview of this type
        this.closeWebviewsByType(type);

        const key = `${type}:singleton`;
        this.registerWebview(key, panel, type, options);
    }

    /**
     * Focus existing singleton webview or return false if none exists
     */
    focusSingletonWebviewIfExists(type: 'endpoint' | 'environment'): boolean {
        const key = `${type}:singleton`;
        return this.focusWebviewIfExists(key);
    }

    /**
     * Clean up all disposed webviews
     */
    cleanup(): void {
        const toDelete: string[] = [];

        for (const [key, entry] of this.webviews.entries()) {
            if (entry.disposed) {
                toDelete.push(key);
            }
        }

        toDelete.forEach(key => this.webviews.delete(key));
    }
}