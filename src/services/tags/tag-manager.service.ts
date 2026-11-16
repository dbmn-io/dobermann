// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { APIEndpointManager } from '../../apiEndpointManager';

/**
 * Host-side operations for the Tag Manager modal:
 *   - rename one tag everywhere it appears
 *   - merge multiple source tags into one target
 *   - delete a tag without touching the endpoints it was on
 *
 * Tags are stored as a `string[]` on each endpoint (see zod-schemas.ts).
 * Every operation iterates the endpoint collection and routes mutations
 * through `APIEndpointManager.updateEndpoint()` so the same persistence +
 * reactivity path fires that a manual save would.
 *
 * All inputs are normalised through `normaliseTag` so callers can pass
 * raw user input — the service is responsible for case/whitespace folding
 * before comparing or writing.
 */
import { normaliseTag, normaliseTags } from '../../utils/tag-normalizer';

export interface TagOpSummary {
    endpointsTouched: number;
    /** Final form of the target tag (post-normalisation); empty string on delete. */
    canonical: string;
}

export class TagManagerService {
    constructor(private readonly endpointManager: APIEndpointManager) {}

    /**
     * Map from normalised tag → number of distinct endpoints referencing it.
     * Used by the modal to render the searchable list with usage counts.
     */
    async listTagCounts(): Promise<Array<{ tag: string; count: number }>> {
        const endpoints = await this.endpointManager.getAllEndpoints();
        const counts = new Map<string, number>();
        for (const endpoint of endpoints) {
            if (!Array.isArray(endpoint.tags)) continue;
            const seen = new Set<string>();
            for (const raw of endpoint.tags) {
                const t = normaliseTag(raw);
                if (!t || seen.has(t)) continue;
                seen.add(t);
                counts.set(t, (counts.get(t) ?? 0) + 1);
            }
        }
        return Array.from(counts.entries())
            .map(([tag, count]) => ({ tag, count }))
            .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    }

    /**
     * Replace every occurrence of `from` with `to`. No-op if `from === to`
     * (after normalisation) or if no endpoint carries the source tag.
     */
    async renameTag(from: string, to: string): Promise<TagOpSummary> {
        const src = normaliseTag(from);
        const dst = normaliseTag(to);
        if (!src || !dst) return { endpointsTouched: 0, canonical: '' };
        if (src === dst) return { endpointsTouched: 0, canonical: dst };

        const endpoints = await this.endpointManager.getAllEndpoints();
        let touched = 0;
        for (const endpoint of endpoints) {
            const tags = normaliseTags(endpoint.tags);
            if (!tags.includes(src)) continue;
            const next = normaliseTags(tags.map(t => (t === src ? dst : t)));
            await this.endpointManager.updateEndpoint(endpoint.id, { tags: next }, true);
            touched++;
        }
        return { endpointsTouched: touched, canonical: dst };
    }

    /**
     * Replace every occurrence of any tag in `sources` with `target`. Duplicates
     * across the merge collapse via the normalised-array dedupe.
     */
    async mergeTags(sources: string[], target: string): Promise<TagOpSummary> {
        const dst = normaliseTag(target);
        if (!dst) return { endpointsTouched: 0, canonical: '' };
        const srcSet = new Set(
            (Array.isArray(sources) ? sources : [])
                .map(s => normaliseTag(s))
                .filter((s): s is string => !!s)
        );
        srcSet.delete(dst); // target isn't a source for itself
        if (srcSet.size === 0) return { endpointsTouched: 0, canonical: dst };

        const endpoints = await this.endpointManager.getAllEndpoints();
        let touched = 0;
        for (const endpoint of endpoints) {
            const tags = normaliseTags(endpoint.tags);
            if (!tags.some(t => srcSet.has(t))) continue;
            const next = normaliseTags(tags.map(t => (srcSet.has(t) ? dst : t)));
            await this.endpointManager.updateEndpoint(endpoint.id, { tags: next }, true);
            touched++;
        }
        return { endpointsTouched: touched, canonical: dst };
    }

    /**
     * Remove every occurrence of `tag`. Endpoints are untouched apart from
     * losing the tag — no other field changes.
     */
    async deleteTag(tag: string): Promise<TagOpSummary> {
        const src = normaliseTag(tag);
        if (!src) return { endpointsTouched: 0, canonical: '' };

        const endpoints = await this.endpointManager.getAllEndpoints();
        let touched = 0;
        for (const endpoint of endpoints) {
            const tags = normaliseTags(endpoint.tags);
            if (!tags.includes(src)) continue;
            const next = tags.filter(t => t !== src);
            await this.endpointManager.updateEndpoint(endpoint.id, { tags: next }, true);
            touched++;
        }
        return { endpointsTouched: touched, canonical: '' };
    }
}
