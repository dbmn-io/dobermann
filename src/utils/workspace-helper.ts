// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { DATA_DIR } from '../services/workspace/workspace-layout';
import * as vscode from 'vscode';

/**
 * Workspace utility functions to provide backward compatibility
 * while supporting Dobermann's independent workspace management
 */

/**
 * Get the Dobermann workspace folder - uses only the dedicated Dobermann workspace
 * @returns The workspace URI or null if not configured
 */
export function getDobermannWorkspaceFolder(): vscode.Uri | null {
    // Get the Dobermann workspace manager from global scope
    const workspaceManager = (global as any).dobermannWorkspaceManager;
    
    if (workspaceManager && workspaceManager.isWorkspaceAvailable()) {
        return workspaceManager.getWorkspaceUri();
    }
    
    return null;
}

/**
 * Get the Dobermann workspace folder, creating default if not available
 * @returns Promise<vscode.Uri> - The workspace URI
 * @throws Error if no workspace can be established
 */
export async function ensureDobermannWorkspaceFolder(): Promise<vscode.Uri> {
    // Try to get existing workspace
    let workspaceUri = getDobermannWorkspaceFolder();
    
    if (workspaceUri) {
        return workspaceUri;
    }
    
    // Try to get the workspace manager and create default workspace
    const workspaceManager = (global as any).dobermannWorkspaceManager;
    
    if (workspaceManager) {
        // Try to initialize/create default workspace if not available
        await workspaceManager.initialize();
        workspaceUri = workspaceManager.getWorkspaceUri();
        if (workspaceUri) {
            return workspaceUri;
        }
    }
    
    // Last resort error message with helpful instructions
    throw new Error(
        'No Dobermann workspace folder available. Please use the "DBMN: Select Workspace Folder" command to configure a dedicated folder for Dobermann files.'
    );
}

/**
 * Legacy compatibility function - replace calls to check workspaceFolders
 * @returns Promise<vscode.Uri> - The workspace URI
 * @throws Error with user-friendly message if no workspace available
 */
export async function requireWorkspaceFolder(): Promise<vscode.Uri> {
    return ensureDobermannWorkspaceFolder();
}

/**
 * Check if Dobermann workspace is available
 * @returns boolean
 */
export function isAnyWorkspaceAvailable(): boolean {
    return getDobermannWorkspaceFolder() !== null;
}

/**
 * Get a subdirectory within the Dobermann workspace
 * @param subPath - The subdirectory path relative to the workspace's .dbmn folder
 * @returns Promise<vscode.Uri> - The subdirectory URI
 */
export async function getDobermannSubDirectory(subPath: string): Promise<vscode.Uri> {
    const workspaceManager = (global as any).dobermannWorkspaceManager;
    
    if (workspaceManager && workspaceManager.isWorkspaceAvailable()) {
        return workspaceManager.getSubDirectory(subPath);
    }
    
    // Fallback to ensuring workspace then creating subdirectory
    const workspaceUri = await ensureDobermannWorkspaceFolder();
    const dobermannDir = vscode.Uri.joinPath(workspaceUri, DATA_DIR);
    const subDir = vscode.Uri.joinPath(dobermannDir, subPath);
    
    try {
        await vscode.workspace.fs.createDirectory(subDir);
    } catch (error) {
        // Directory might already exist
    }
    
    return subDir;
}