// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { APIEndpointConfig } from '../../apiConfigManager';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * A node in the URL-segment tree rendered into the endpoint tree view.
 *
 *  - `segment` is the visible label. Auto-compacted chains use a slash-joined label
 *    such as `dcinventory/api/dcinventory/inventory` so the user sees one row
 *    instead of four for prefix noise.
 *  - `children` are sub-segments keyed by their compacted segment label.
 *  - `methods` are the HTTP methods that terminate here. Each method may map to
 *    multiple endpoints — these are the variants surfaced in the Body dropdown.
 *  - `fullPath` is the original (un-trimmed) URL path of this node, useful for
 *    debugging and for opening the endpoint editor in a path context.
 */
export interface UrlTreeNode {
    segment: string;
    fullPath: string;
    children: Map<string, UrlTreeNode>;
    methods: Map<HttpMethod, APIEndpointConfig[]>;
}

export interface BuildTreeOptions {
    /** Path prefix to strip from each endpoint's path before building the tree. */
    trimPrefix?: string;
    /** Maximum nesting depth. Segments beyond this are joined into the leaf node. */
    maxDepth?: number;
}

/**
 * Build a URL-segment tree from a flat list of endpoints. The result is then
 * usually passed through {@link compactSingleChildChains}.
 */
export function buildUrlTree(
    endpoints: APIEndpointConfig[],
    options: BuildTreeOptions = {}
): UrlTreeNode {
    const maxDepth = options.maxDepth ?? 4;
    const root: UrlTreeNode = {
        segment: '',
        fullPath: '',
        children: new Map(),
        methods: new Map()
    };

    for (const endpoint of endpoints) {
        const segments = pathSegmentsAfterTrim(endpoint.path, options.trimPrefix);
        if (segments.length === 0) {
            // The endpoint lives at the (post-trim) root. Attach as a method leaf on the root.
            addMethod(root, endpoint);
            continue;
        }

        let node = root;
        const visibleCount = Math.min(segments.length, maxDepth);
        for (let i = 0; i < visibleCount; i++) {
            const isLastVisible = i === visibleCount - 1;
            // If we're at the depth cap and there are more segments to come, join the rest
            // into this final visible segment so nothing is lost from the label.
            const label = (isLastVisible && segments.length > maxDepth)
                ? segments.slice(i).join('/')
                : segments[i];
            const fullPath = '/' + segments.slice(0, i + 1).join('/');
            let child = node.children.get(label);
            if (!child) {
                child = { segment: label, fullPath, children: new Map(), methods: new Map() };
                node.children.set(label, child);
            }
            node = child;
        }
        addMethod(node, endpoint);
    }

    return root;
}

/**
 * VS Code "compact folders" style: where a node has exactly one child and no method
 * leaves of its own, merge the node label with its child. Repeats until every
 * remaining intermediate node either branches or carries methods.
 *
 * The root node is never collapsed into a child — root always remains the empty anchor.
 */
export function compactSingleChildChains(node: UrlTreeNode): UrlTreeNode {
    const compactedChildren = new Map<string, UrlTreeNode>();
    for (const child of node.children.values()) {
        const compacted = compactSingleChildChains(child);
        compactedChildren.set(compacted.segment, compacted);
    }

    if (
        node.segment !== '' &&
        node.methods.size === 0 &&
        compactedChildren.size === 1
    ) {
        const [onlyChild] = [...compactedChildren.values()];
        return {
            segment: `${node.segment}/${onlyChild.segment}`,
            fullPath: onlyChild.fullPath,
            children: onlyChild.children,
            methods: onlyChild.methods
        };
    }

    return {
        segment: node.segment,
        fullPath: node.fullPath,
        children: compactedChildren,
        methods: node.methods
    };
}

/**
 * Build and compact in one call. The vast majority of callers want both steps.
 */
export function buildCompactUrlTree(
    endpoints: APIEndpointConfig[],
    options: BuildTreeOptions = {}
): UrlTreeNode {
    return compactSingleChildChains(buildUrlTree(endpoints, options));
}

/**
 * Walk a URL tree node and return every endpoint reachable from it — methods
 * attached to the node itself plus everything in every descendant. Used by
 * the "Assign group to System" command to collect the bulk-update set when
 * the user right-clicks a URL-segment row.
 */
export function collectEndpointsInSubtree(node: UrlTreeNode): import('../../apiConfigManager').APIEndpointConfig[] {
    const out: import('../../apiConfigManager').APIEndpointConfig[] = [];
    for (const variants of node.methods.values()) out.push(...variants);
    for (const child of node.children.values()) out.push(...collectEndpointsInSubtree(child));
    return out;
}

function pathSegmentsAfterTrim(path: string, trimPrefix?: string): string[] {
    let working = path;
    if (trimPrefix && trimPrefix.length > 0 && working.startsWith(trimPrefix)) {
        working = working.slice(trimPrefix.length);
    }
    return working.split('/').filter(Boolean);
}

function addMethod(node: UrlTreeNode, endpoint: APIEndpointConfig): void {
    const list = node.methods.get(endpoint.method) ?? [];
    list.push(endpoint);
    node.methods.set(endpoint.method, list);
}
