// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import * as vscode from 'vscode';
import { APIEndpointManager } from '../../apiEndpointManager';
import { normaliseTag, normaliseTags } from '../../utils/tag-normalizer';

/**
 * One-off migration that copies each endpoint's legacy `folder` value into its
 * `tags[]` array. Runs once when {@link MIGRATION_FLAG_KEY} is absent from
 * globalState; after a successful run the flag is set.
 *
 * Rules
 * -----
 *  - **Append, do not overwrite.** If a user already has tags, the migrated
 *    folder value is added alongside (deduped after normalisation).
 *  - **Normalise both sides.** Existing tags + the folder value go through
 *    the same `trim + lowercase` rule so case-variants collapse.
 *  - **Leave `folder` intact.** The field is deprecated but kept on the
 *    schema for backwards compat; deleting it adds risk for zero gain.
 */
export const MIGRATION_FLAG_KEY = 'dbmn.folderToTagsMigration.v1.completed';

export interface FolderToTagsSummary {
    ran: boolean;
    endpointsTouched: number;
    tagsAdded: number;
    /** Total endpoints in the collection at the time of the run. */
    endpointsTotal: number;
    /** Endpoints that had a non-empty `folder` value, regardless of whether
     *  the tag was already present. Useful for diagnosing "nothing happened" — if
     *  this is zero, the migration had no source data. */
    endpointsWithFolder: number;
    /** Up to 10 representative `folder` values seen during the run (post-
     *  normalisation), so the user can sanity-check what would have migrated. */
    sampleFolders: string[];
    reason?: string;
}

export class FolderToTagsMigrationService {
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly endpointManager: APIEndpointManager
    ) {}

    async migrateIfNeeded(): Promise<FolderToTagsSummary> {
        const alreadyRan = this.context.globalState.get<boolean>(MIGRATION_FLAG_KEY);
        if (alreadyRan) {
            return {
                ran: false,
                endpointsTouched: 0,
                tagsAdded: 0,
                endpointsTotal: 0,
                endpointsWithFolder: 0,
                sampleFolders: [],
                reason: 'already-completed'
            };
        }

        const summary = await this.run();
        await this.context.globalState.update(MIGRATION_FLAG_KEY, true);
        return summary;
    }

    /**
     * Force a re-run regardless of the migration flag. Intended for tests.
     */
    async runForced(): Promise<FolderToTagsSummary> {
        return this.run();
    }

    private async run(): Promise<FolderToTagsSummary> {
        const endpoints = await this.endpointManager.getAllEndpoints();
        const endpointsTotal = endpoints.length;
        if (endpointsTotal === 0) {
            return {
                ran: true,
                endpointsTouched: 0,
                tagsAdded: 0,
                endpointsTotal: 0,
                endpointsWithFolder: 0,
                sampleFolders: [],
                reason: 'no-data'
            };
        }

        let endpointsTouched = 0;
        let tagsAdded = 0;
        let endpointsWithFolder = 0;
        const sampleFolders: string[] = [];

        for (const endpoint of endpoints) {
            const folderTag = normaliseTag(endpoint.folder ?? '');
            if (!folderTag) continue;

            endpointsWithFolder++;
            if (sampleFolders.length < 10 && !sampleFolders.includes(folderTag)) {
                sampleFolders.push(folderTag);
            }

            const existing = normaliseTags(endpoint.tags);
            if (existing.includes(folderTag)) continue;

            const next = [...existing, folderTag];
            await this.endpointManager.updateEndpoint(endpoint.id, { tags: next }, true);
            endpointsTouched++;
            tagsAdded++;
        }

        return {
            ran: true,
            endpointsTouched,
            tagsAdded,
            endpointsTotal,
            endpointsWithFolder,
            sampleFolders
        };
    }
}
