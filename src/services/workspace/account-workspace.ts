// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #344: a DBMN workspace as recorded on the user's account (its marker's id, the folder's name
 * and path, and the device), as the core sees it. The account's rows (`user_workspaces`) are
 * read and written by the Supabase adapter in `src/platform/supabase/account-workspaces.ts`.
 */
export interface AccountWorkspace {
    workspaceId: string;
    deviceId: string;
    name: string;
    path: string;
    updatedAt: string;
}
