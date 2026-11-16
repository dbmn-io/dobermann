// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Home's "New in vX.Y.Z" (#348) outside VS Code: this build's release notes are a file beside
 * the pages (/release-notes.json: the dev server writes it, and so does the desktop build), and
 * the version this installation ran before is kept on the device, as VS Code keeps it in
 * globalState. No file, or one that isn't release notes: no card.
 */
import type { IKeyValueStore } from '../../../src/platform/interfaces/key-value-store.interface';
import { whatsNewFromReleaseNotes, type WhatsNew } from '../../../src/services/release-notes/whats-new';

const RELEASE_NOTES_URL = '/release-notes.json';
/** The key DBMN for VS Code uses (hub-manager.ts). */
const BASELINE_KEY = 'dbmn.home.whatsNewBaseline.v1';

export async function loadWhatsNew(device: Pick<IKeyValueStore, 'get' | 'update'>): Promise<WhatsNew | null> {
    try {
        const response = await fetch(RELEASE_NOTES_URL);
        if (!response.ok) return null;
        const { whatsNew, baseline } = whatsNewFromReleaseNotes(await response.json(), device.get(BASELINE_KEY));
        if (baseline) await device.update(BASELINE_KEY, baseline);
        return whatsNew;
    } catch {
        return null;
    }
}
