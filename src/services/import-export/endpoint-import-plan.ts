// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Endpoint create/update planning for import.
 *
 * Endpoint names are unique across an install (APIEndpointManager.addEndpoint),
 * but an export can hold two endpoints with the same name in different folders,
 * and the install may already use a name in another folder. Either used to throw
 * at import on the clashing endpoint and abandon everything after it.
 *
 * An imported endpoint UPDATES an existing endpoint with the same folder+name,
 * otherwise CREATES. A name that's already taken is renamed "<name> (<folder>)"
 * ("Root" for no folder), numbered if that's taken too. The rename is
 * deterministic, so re-importing the same file updates the renamed endpoint
 * rather than adding another copy.
 *
 * Pure logic — no vscode APIs.
 */

import { APIEndpointConfig } from '../../apiConfigManager';
import { ImportItem } from './import-export.service.interface';

export function planEndpointImports(
    endpoints: APIEndpointConfig[],
    existingEndpoints: APIEndpointConfig[]
): ImportItem[] {
    const takenNames = new Set(existingEndpoints.map(e => e.name.toLowerCase()));
    // Existing endpoints an earlier item in this file already updates
    const claimedIds = new Set<string>();

    return endpoints.map(endpoint => {
        const item = planEndpoint(endpoint, existingEndpoints, takenNames, claimedIds);
        takenNames.add(item.importItem.name.toLowerCase());
        if (item.existingItem) claimedIds.add(item.existingItem.id);
        return item;
    });
}

function planEndpoint(
    endpoint: APIEndpointConfig,
    existingEndpoints: APIEndpointConfig[],
    takenNames: Set<string>,
    claimedIds: Set<string>
): ImportItem {
    const folder = endpoint.folder || '';
    const findExisting = (name: string): APIEndpointConfig | undefined => existingEndpoints.find(e =>
        !claimedIds.has(e.id) &&
        e.name.toLowerCase() === name.toLowerCase() &&
        (e.folder || '') === folder
    );

    const label = folder || 'Root';
    let name = endpoint.name;
    for (let attempt = 1; !findExisting(name) && takenNames.has(name.toLowerCase()); attempt++) {
        name = `${endpoint.name} (${attempt === 1 ? label : `${label} ${attempt}`})`;
    }

    const existing = findExisting(name);
    const item: ImportItem = {
        type: 'endpoint',
        importItem: name === endpoint.name ? endpoint : { ...endpoint, name },
        action: existing ? 'update' : 'create',
        selected: true
    };
    if (existing) item.existingItem = existing;
    if (name !== endpoint.name) item.renamedFrom = endpoint.name;
    return item;
}
