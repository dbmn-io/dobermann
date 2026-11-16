// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #344: the user's DBMN workspaces on their account. VS Code records the one it uses (its
 * marker's id, the folder's name and path, and the device); the web app reads them to suggest
 * the folder and to check a picked folder's marker. No data: ids, names and paths.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { settled } from './settled';
import type { AccountWorkspace } from '../../services/workspace/account-workspace';

export type { AccountWorkspace };

export async function recordWorkspace(client: SupabaseClient, workspace: Omit<AccountWorkspace, 'updatedAt'>): Promise<void> {
    const { error } = await settled(() => client.from('user_workspaces').upsert({
        workspace_id: workspace.workspaceId,
        device_id: workspace.deviceId,
        name: workspace.name,
        path: workspace.path,
        updated_at: new Date().toISOString()
    }, { onConflict: 'owner_user_id,workspace_id,device_id' }));
    if (error) throw new Error(`Could not record the workspace: ${error.message}`);
}

/** Most recently used first. */
export async function accountWorkspaces(client: SupabaseClient): Promise<AccountWorkspace[]> {
    const { data, error } = await settled(() => client.from('user_workspaces')
        .select('workspace_id, device_id, name, path, updated_at')
        .order('updated_at', { ascending: false }));
    if (error) throw new Error(`Could not read the workspaces: ${error.message}`);
    return ((data ?? []) as Array<Record<string, string>>).map(row => ({
        workspaceId: row.workspace_id, deviceId: row.device_id, name: row.name, path: row.path, updatedAt: row.updated_at
    }));
}
