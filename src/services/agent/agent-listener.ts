// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #374: where a DBMN for VS Code window is listening, as the core sees it. The account's copy
 * of these rows (`user_agents`) is read and written by the Supabase adapter in
 * `src/platform/supabase/agent-discovery.ts`; the core only knows the shape.
 */
export interface AgentListener {
    listenerId: string;
    deviceId: string;
    port: number;
    agentVersion: string;
    updatedAt: string;
}
