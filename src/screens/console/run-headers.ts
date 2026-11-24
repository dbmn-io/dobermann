// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A run's header values, each by its own name, for the Console's Settings tab (James, 2026-11-24:
 * "Remove organization… it should just be whatever headings exist on the environment that we've
 * run against… the ones that we show in the heading should be on this screen").
 *
 * A run keeps the values it was sent with (environmentVariables): a single run its header
 * variables', a batch every variable's. The environment's header says which are headers, in its
 * order. With the environment gone, what the run kept is shown. A run from before kept only its
 * org, as `organization`: it shows as org.
 */
import { headerVariableNames, type VariableBearer } from '../../services/environment/variable-options';

export interface RunHeader {
    name: string;
    value: string;
}

const real = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' && value !== 'Unknown' ? value : undefined;

export function runHeaders(recorded: Record<string, string> | undefined, organization: string | undefined, environment?: VariableBearer): RunHeader[] {
    const kept = recorded ?? {};
    const names = environment ? headerVariableNames(environment) : Object.keys(kept);
    const isOrg = (name: string) => name.toLowerCase() === 'org';
    const headers = names
        .map(name => ({ name, value: real(kept[name]) ?? (isOrg(name) ? real(organization) : undefined) }))
        .filter((h): h is RunHeader => h.value !== undefined);
    const org = real(organization);
    if (org && !headers.some(h => isOrg(h.name))) headers.unshift({ name: 'org', value: org });
    return headers;
}
