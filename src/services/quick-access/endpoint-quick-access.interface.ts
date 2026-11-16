// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Endpoint Quick Access Service Interface
 * Provides QuickPick-based search and execution for API endpoints
 */

import * as vscode from 'vscode';
import { APIEndpointConfig } from '../../data-loading/types';

/**
 * QuickPick item with endpoint metadata
 */
export interface EndpointQuickPickItem extends vscode.QuickPickItem {
    /** Unique endpoint identifier */
    endpointId: string;
    /** Full endpoint configuration */
    endpoint: APIEndpointConfig;
    /** Folder name if endpoint is organized in folder */
    folderName?: string;
}

/**
 * User action selection from QuickPick
 */
// GitHub Issue #232: Simplified — 'batch' removed, 'run' now auto-detects
export type QuickAccessAction = 'run' | 'edit' | 'cancelled';

/**
 * Result of QuickPick interaction
 */
export interface QuickAccessResult {
    /** Selected endpoint (undefined if cancelled) */
    endpoint?: APIEndpointConfig;
    /** User-selected action */
    action: QuickAccessAction;
}

/**
 * Service for quick endpoint search and access
 */
export interface IEndpointQuickAccessService {
    /**
     * Show QuickPick dialog for endpoint selection with action buttons
     * @returns Selected endpoint and action, or cancelled status
     */
    showQuickPick(): Promise<QuickAccessResult>;
}
