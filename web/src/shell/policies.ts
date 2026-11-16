// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The web app's DBMN-configured data, read with the page's Supabase session: the Standard
 * Systems (#415).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { EnvironmentManager } from '../../../src/environmentManager';
import { GlobalSystemsService, wireGlobalSystems, type DbmnSessionAuth } from '../../../src/services/systems/global-systems.service';
import type { SystemManager } from '../../../src/systemManager';
import type { APIEndpointManager } from '../../../src/apiEndpointManager';
import { wireGlobalSystemSwitch } from '../../../src/services/systems/global-system-adoption';
import { SystemOperationsService } from '../../../src/services/systems/system-operations.service';
import { browserDeviceStore } from './browser-stores';

function sessionAuth(client: SupabaseClient): DbmnSessionAuth {
    let token: string | undefined;
    return {
        isAuthenticated: () => true,   // the app only starts signed in
        // Supabase's client refreshes an expiring session itself: getSession hands back a valid one
        ensureValidSession: async () => {
            token = (await client.auth.getSession()).data.session?.access_token;
            return { status: token ? 'success' : 'signed_out' };
        },
        getSession: () => (token ? { accessToken: token } : null)
    };
}

/**
 * #415: the global Systems, configured by DBMN in Supabase, listed with the user's own; an own
 * System named like one of them switched to it, and a System-less environment whose address
 * matches one linked to it (as in VS Code).
 */
export function startGlobalSystems(
    client: SupabaseClient,
    scope: string,
    managers: { systems: SystemManager; endpoints: APIEndpointManager; environments: EnvironmentManager }
): GlobalSystemsService {
    const globalSystems = new GlobalSystemsService(browserDeviceStore(scope), sessionAuth(client));
    wireGlobalSystems(globalSystems, managers.systems);
    wireGlobalSystemSwitch(managers.systems, new SystemOperationsService(managers.systems, managers.endpoints, managers.environments), managers.environments);
    return globalSystems;
}
