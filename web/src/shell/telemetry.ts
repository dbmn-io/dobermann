// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The web and desktop apps' usage counter (0.4.1): the same service VS Code uses
 * (dbmn-telemetry.service.ts), so a run counts towards Weekly Usage wherever it ran.
 *
 * - Unsent counts wait in this browser's storage, as VS Code keeps them in its global state,
 *   and go on the next start if the page closes first.
 * - The switch is the account's `dbmn.telemetry.enabled` (Account → Weekly Usage).
 * - The rows say which app sent them: `vscode_version` is `web` or `desktop` (TELEMETRY.md).
 * - The token is the page's own sign-in; signed out, nothing is sent.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { DbmnTelemetryService } from '../../../src/services/dbmn-auth/dbmn-telemetry.service';
import { reportedExtensionVersion } from '../../../src/services/dbmn-backend/backend-config';
import type { IConfiguration } from '../../../src/platform/interfaces/configuration.interface';
import type { SessionRefreshResult } from '../../../src/types/dbmn-auth';
import { browserDeviceStore } from './browser-stores';
import { browserPlatform } from '../../../src/services/dbmn-auth/browser-platform';

export function webTelemetry(client: SupabaseClient, settings: IConfiguration, host: 'web' | 'desktop'): DbmnTelemetryService {
    const telemetry = new DbmnTelemetryService({ globalState: browserDeviceStore('telemetry') }, {
        enabled: () => settings.get<boolean>('dbmn', 'telemetry.enabled', true) !== false,
        client: () => ({
            extensionVersion: reportedExtensionVersion(__DBMN_APP_VERSION__),
            vscodeVersion: host,
            osPlatform: browserPlatform()
        })
    });
    telemetry.setAuthService({
        ensureValidSession: async (): Promise<SessionRefreshResult> => {
            try {
                const session = (await client.auth.getSession()).data.session;
                if (!session) return { status: 'auth_error', httpStatus: 401 };
                return {
                    status: 'success',
                    session: {
                        userId: session.user.id, email: session.user.email ?? '', displayName: '',
                        accessToken: session.access_token, refreshToken: '', expiresAt: session.expires_at ?? 0
                    }
                };
            } catch (error) {
                return { status: 'network_error', error: error instanceof Error ? error.message : String(error) };
            }
        }
    });
    return telemetry;
}
