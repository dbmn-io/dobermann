// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { APIEndpointConfig } from '../../apiConfigManager';
import { SystemConfig } from '../../data-loading/system-schema';
import { buildCompactUrlTree, HttpMethod, UrlTreeNode } from '../tree/endpoint-tree-builder';
import * as searchWords from '../../webviews/shared/search-words.js';

export type GroupBy = 'url' | 'method' | 'system' | 'none';

export interface CatalogueFilters {
    systemIds?: string[];
    methods?: HttpMethod[];
    search?: string;
    /** Any of the tags: an endpoint passes if it has one of them (#444: a sign repeated is any of them). */
    tags?: string[];
}

export interface CatalogueViewSpec {
    groupBy: GroupBy;
    filters: CatalogueFilters;
}

/**
 * One node in the rendered catalogue. Leaves carry `endpoints`; internal URL
 * nodes carry only `children` plus methods that terminate at the node itself
 * (URL grouping can have both — e.g. `/api/foo` POST + a `/api/foo/Bulk` child).
 */
export interface CatalogueGroup {
    key: string;
    label: string;
    /** Endpoints attached at this exact group level. */
    endpoints: APIEndpointConfig[];
    /** Nested groups (URL grouping uses this; flat groupings leave it empty). */
    children: CatalogueGroup[];
    /** Total endpoints under this group and its descendants. */
    count: number;
}

export interface GroupedCatalogue {
    groups: CatalogueGroup[];
    /** Endpoints surviving filters, before grouping. */
    totalCount: number;
    view: CatalogueViewSpec;
}

const ALL_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const ORPHAN_SYSTEM_KEY = '__unknown__';
// User-facing label for endpoints with no System. Kept distinct from any real
// System name (the migration's catch-all is "Unsorted") so the truly-unassigned
// bucket never renders as an identical twin of an actual System.
const ORPHAN_SYSTEM_LABEL = 'Unassigned';

export function applyView(
    endpoints: APIEndpointConfig[],
    systems: SystemConfig[],
    view: CatalogueViewSpec
): GroupedCatalogue {
    const filtered = filterEndpoints(endpoints, view.filters);

    let groups: CatalogueGroup[];
    switch (view.groupBy) {
        case 'url':
            groups = groupByUrl(filtered, systems);
            break;
        case 'system':
            groups = groupBySystem(filtered, systems);
            break;
        case 'method':
            groups = groupByMethod(filtered);
            break;
        case 'none':
        default:
            groups = [flatGroup(filtered)];
    }

    return { groups, totalCount: filtered.length, view };
}

export function filterEndpoints(
    endpoints: APIEndpointConfig[],
    filters: CatalogueFilters
): APIEndpointConfig[] {
    const systemIds = filters.systemIds && filters.systemIds.length > 0 ? new Set(filters.systemIds) : null;
    const methods = filters.methods && filters.methods.length > 0 ? new Set(filters.methods) : null;
    // #444: the Hub's word rule (every word, any order, "phrase", -word), shared with catalogue.js;
    // the signs (`#tag`, `@System`, methods) are parsed by the Hub into the other filters
    const words = filters.search ? searchWords.parseWords(filters.search) : null;
    const search = words && (words.include.length > 0 || words.exclude.length > 0) ? words : null;
    const tags = filters.tags && filters.tags.length > 0
        ? filters.tags.map(t => t.trim().toLowerCase())
        : null;

    return endpoints.filter(endpoint => {
        if (systemIds) {
            const sid = endpoint.systemId ?? ORPHAN_SYSTEM_KEY;
            if (!systemIds.has(sid)) return false;
        }
        if (methods && !methods.has(endpoint.method as HttpMethod)) return false;
        if (tags) {
            const epTags = Array.isArray(endpoint.tags)
                ? endpoint.tags.map(t => t.trim().toLowerCase())
                : [];
            if (!tags.some(t => epTags.includes(t))) return false;
        }
        if (search && !searchWords.matches(search, buildSearchHaystack(endpoint))) return false;
        return true;
    });
}

/**
 * Count unique tag occurrences across the given endpoints. Used by the
 * Catalogue filter popover to show usage counts next to each tag.
 *
 * `otherFilters` lets the caller pass the current filter state EXCEPT for
 * `tags` — the count shown next to each tag is "endpoints I'd match if this
 * tag were the only selected tag, with all other filters honoured." This is
 * the same shape as `updateMethodCounts()` uses for method chips.
 */
export function aggregateTagCounts(
    endpoints: APIEndpointConfig[],
    otherFilters: CatalogueFilters = {}
): Map<string, number> {
    const scope = filterEndpoints(endpoints, { ...otherFilters, tags: undefined });
    const counts = new Map<string, number>();
    for (const endpoint of scope) {
        if (!Array.isArray(endpoint.tags)) continue;
        const seen = new Set<string>();
        for (const raw of endpoint.tags) {
            const t = (raw || '').trim().toLowerCase();
            if (!t || seen.has(t)) continue;
            seen.add(t);
            counts.set(t, (counts.get(t) ?? 0) + 1);
        }
    }
    return counts;
}

/**
 * Single lowercase string containing every searchable field on an endpoint.
 * Mirrors `buildSearchHaystack` in `src/webviews/hub/catalogue.js`. Keep both
 * in lock-step — the webview port avoids the TS round-trip per keystroke.
 */
export function buildSearchHaystack(endpoint: APIEndpointConfig): string {
    const parts: Array<string | undefined> = [
        endpoint.name,
        endpoint.path,
        endpoint.method,
        endpoint.description,
        endpoint.body,
        endpoint.bodyWithComments,
        endpoint.folder
    ];
    if (Array.isArray(endpoint.tags)) parts.push(endpoint.tags.join(' '));
    addRecordTokens(parts, endpoint.headers);
    addRecordTokens(parts, endpoint.queryParams);
    addRecordTokens(parts, (endpoint as any).environmentVariables);
    const flavours = (endpoint as any).flavours;
    if (Array.isArray(flavours)) {
        for (const flavour of flavours) {
            if (!flavour) continue;
            parts.push(flavour.name);
            parts.push(flavour.body);
            addRecordTokens(parts, flavour.queryParams);
        }
    }
    return parts.filter(Boolean).join('\n').toLowerCase();
}

function addRecordTokens(parts: Array<string | undefined>, record: unknown): void {
    if (!record || typeof record !== 'object') return;
    for (const key of Object.keys(record as Record<string, unknown>)) {
        parts.push(key);
        const val = (record as Record<string, unknown>)[key];
        if (val == null) continue;
        if (typeof val === 'string') {
            parts.push(val);
            continue;
        }
        if (typeof val === 'object') {
            const v = val as { value?: unknown; defaultValue?: unknown; description?: unknown };
            if (typeof v.value === 'string') parts.push(v.value);
            if (typeof v.defaultValue === 'string') parts.push(v.defaultValue);
            if (typeof v.description === 'string') parts.push(v.description);
        }
    }
}

function groupByUrl(endpoints: APIEndpointConfig[], systems: SystemConfig[]): CatalogueGroup[] {
    // No System wrapper — pre-trim each endpoint's path with its System's
    // trim prefix, then build one URL tree across all of them. Endpoints
    // from different Systems whose trimmed paths share a top segment will
    // collapse into the same group. The user is in control of System scope
    // via the picker; the tree shouldn't impose it as a hierarchy layer.
    const lookup = systemLookupMap(systems);
    const preTrimmed = endpoints.map(endpoint => {
        const trim = (endpoint.systemId && lookup.get(endpoint.systemId)?.treeTrimPrefix) || '';
        const path = endpoint.path || '';
        if (!trim || !path.startsWith(trim)) return endpoint;
        const stripped = path.slice(trim.length);
        return { ...endpoint, path: stripped.startsWith('/') ? stripped : '/' + stripped } as APIEndpointConfig;
    });

    const tree = buildCompactUrlTree(preTrimmed, { trimPrefix: '' });
    const groups: CatalogueGroup[] = [];

    // Endpoints living at the (post-trim) root attach as methods on the tree
    // root; expose each as its own "(root)" leaf so they're still clickable.
    for (const variants of tree.methods.values()) {
        for (const variant of variants) {
            groups.push({
                key: `__root__:${variant.id}`,
                label: '(root)',
                endpoints: [variant],
                children: [],
                count: 1
            });
        }
    }
    for (const child of tree.children.values()) {
        groups.push(urlNodeToGroup(child));
    }
    return groups.sort(compareByLabel);
}

function urlNodeToGroup(node: UrlTreeNode): CatalogueGroup {
    const methodEndpoints: APIEndpointConfig[] = [];
    for (const variants of node.methods.values()) methodEndpoints.push(...variants);

    const children = Array.from(node.children.values())
        .map(urlNodeToGroup)
        .sort(compareByLabel);

    const count = methodEndpoints.length + children.reduce((sum, c) => sum + c.count, 0);
    return {
        key: node.fullPath || node.segment,
        label: node.segment,
        endpoints: methodEndpoints,
        children,
        count
    };
}

function groupBySystem(endpoints: APIEndpointConfig[], systems: SystemConfig[]): CatalogueGroup[] {
    const bySystem = bucketBySystem(endpoints);
    const lookup = systemLookupMap(systems);
    return Array.from(bySystem.entries())
        .map(([systemId, list]) => ({
            key: systemId,
            label: lookup.get(systemId)?.name ?? ORPHAN_SYSTEM_LABEL,
            endpoints: sortEndpoints(list),
            children: [],
            count: list.length
        }))
        .sort(compareByLabel);
}

function groupByMethod(endpoints: APIEndpointConfig[]): CatalogueGroup[] {
    const byMethod = new Map<HttpMethod, APIEndpointConfig[]>();
    for (const e of endpoints) {
        const m = e.method as HttpMethod;
        const list = byMethod.get(m) ?? [];
        list.push(e);
        byMethod.set(m, list);
    }

    return ALL_METHODS
        .filter(m => byMethod.has(m))
        .map(m => ({
            key: m,
            label: m,
            endpoints: sortEndpoints(byMethod.get(m)!),
            children: [],
            count: byMethod.get(m)!.length
        }));
}

function flatGroup(endpoints: APIEndpointConfig[]): CatalogueGroup {
    return {
        key: '__all__',
        label: 'All endpoints',
        endpoints: sortEndpoints(endpoints),
        children: [],
        count: endpoints.length
    };
}

function bucketBySystem(endpoints: APIEndpointConfig[]): Map<string, APIEndpointConfig[]> {
    const bucket = new Map<string, APIEndpointConfig[]>();
    for (const e of endpoints) {
        const sid = e.systemId ?? ORPHAN_SYSTEM_KEY;
        const list = bucket.get(sid) ?? [];
        list.push(e);
        bucket.set(sid, list);
    }
    return bucket;
}

function systemLookupMap(systems: SystemConfig[]): Map<string, SystemConfig> {
    return new Map(systems.map(s => [s.id, s]));
}

function sortEndpoints(endpoints: APIEndpointConfig[]): APIEndpointConfig[] {
    return [...endpoints].sort((a, b) => {
        const byPath = (a.path ?? '').localeCompare(b.path ?? '');
        if (byPath !== 0) return byPath;
        const byMethod = (a.method ?? '').localeCompare(b.method ?? '');
        if (byMethod !== 0) return byMethod;
        return (a.name ?? '').localeCompare(b.name ?? '');
    });
}

function compareByLabel(a: CatalogueGroup, b: CatalogueGroup): number {
    return a.label.localeCompare(b.label);
}

/**
 * Default view: with an active System, filter to it and group by URL; without
 * one, show all Systems as top-level groups.
 */
export function defaultView(activeSystemId: string | undefined): CatalogueViewSpec {
    if (activeSystemId) {
        return { groupBy: 'url', filters: { systemIds: [activeSystemId], methods: [] } };
    }
    return { groupBy: 'system', filters: { methods: [] } };
}
