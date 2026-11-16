// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The one network call the badge service makes: `get_my_badges()`.
 * It takes no user id — the server answers for the bearer of the token and nobody else.
 */
import { getBackend } from '../dbmn-backend/backend-config';

export async function fetchMyBadges(accessToken: string): Promise<unknown> {
    const response = await fetch(`${getBackend().apiUrl}/rest/v1/rpc/get_my_badges`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'apikey': getBackend().anonKey,
            'Content-Type': 'application/json'
        },
        body: '{}'
    });
    if (!response.ok) {
        throw new Error(`get_my_badges failed: ${response.status}`);
    }
    return response.json();
}
