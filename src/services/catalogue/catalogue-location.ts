// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Where a VS Code user's API Catalogue lives (#342): in their DBMN account, or, by their own
 * choice, on this computer only. The words every screen uses for that choice are here, so the
 * prompt, Home and Settings say the same thing.
 *
 * Kept short on purpose (the user's wording, 2026-10-11): one sentence on why to save, and the
 * two facts people worry about. Keeping the catalogue on this computer is a real, remembered
 * choice, not a postponement; the account is still the recommended place.
 */

/** Why save it to the account. */
const WHY_SAVE = 'Your endpoints and environments are backed up for you, and there on any computer you sign in on.';

/** What never leaves the machine. One wording for every screen. */
export const WHAT_STAYS_HERE =
    'Secrets entered into Environments are never saved to dbmn.io. All data sent to/from your environments stays on this machine.';

/** Asked once, at the first DBMN sign-in on a computer that has a catalogue of its own. */
export const SAVE_CATALOGUE_PROMPT = {
    title: 'Save your endpoints and environments to your DBMN account?',
    body: `${WHY_SAVE}\n\n${WHAT_STAYS_HERE}`,
    actions: [
        { id: 'keep', label: 'Keep on this computer', variant: 'secondary' as const },
        { id: 'save', label: 'Save to my account…', variant: 'primary' as const }
    ]
};

/** Said once, after "Keep on this computer". */
export const KEPT_ON_DEVICE_MESSAGE =
    'Your endpoints and environments stay on this computer. Nothing was saved to your DBMN account. You can save them there any time from Settings.';

/** Where the catalogue is, for Settings and Home. `card` only while Home should encourage saving. */
export interface CatalogueStorageInfo {
    where: 'account' | 'device' | 'offline';
    label: string;
    help: string;
    /** The button that saves a device-only catalogue to the account. */
    saveLabel?: string;
    /** #427, signed out: the button that removes the account's catalogue from this computer. */
    removeLabel?: string;
    /** A card on Home. `button` saves the catalogue to the account; absent, the card only informs. */
    home?: { title: string; text: string; button?: string };
}

/**
 * What the web app knows about DBMN for VS Code on this account: when each of its windows last
 * announced itself (`user_agents`, 0.3.2+), and whether a VS Code catalogue was saved to the
 * account (`catalog_migrations`: a row, even an empty one, means VS Code had nothing left to save).
 */
export interface VsCodeCatalogueSignals {
    /** `updated_at` of each VS Code listener the account knows (ISO strings). */
    seenAt: string[];
    saved: boolean;
}

/** A VS Code seen this long ago still counts as this user's. */
const VS_CODE_SEEN_WITHIN_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The web app is always on the account's catalogue. One case gets a card on Home: DBMN for VS
 * Code has signed in on this account within a month and its catalogue is still on that computer
 * (the question closed, or "Keep on this computer"). The card says where to save it, in VS Code;
 * nobody else sees it, and it goes by itself once VS Code records the save.
 */
export function webCatalogueStorageInfo(signals: VsCodeCatalogueSignals, nowMs: number = Date.now()): CatalogueStorageInfo {
    const seen = signals.seenAt.some(at => nowMs - Date.parse(at) < VS_CODE_SEEN_WITHIN_MS);
    if (!seen || signals.saved) return catalogueStorageInfo('account');
    return {
        ...catalogueStorageInfo('account'),
        home: {
            title: 'Your endpoints from VS Code aren\'t here yet',
            text: 'Save them from DBMN for VS Code: Settings → Endpoints → Save to my account… Your endpoints and environments then show here too.'
        }
    };
}

export function catalogueStorageInfo(where: 'account' | 'device'): CatalogueStorageInfo {
    if (where === 'account') {
        return { where, label: 'In your DBMN account', help: `${WHY_SAVE} ${WHAT_STAYS_HERE}` };
    }
    return {
        where,
        label: 'On this computer only',
        help: `Not backed up, and not on your other computers. Save it to your DBMN account to have both. ${WHAT_STAYS_HERE}`,
        saveLabel: 'Save to my account…',
        home: {
            title: 'Your endpoints are only on this computer',
            text: 'Save them to your DBMN account: backed up for you, and there on any computer you sign in on.',
            button: 'Save to my account…'
        }
    };
}

/**
 * While this computer's endpoints and environments go to the account, after the copy is written
 * (`what` is describeCatalogueCount's "67 endpoints and 8 environments"). Home's card and Settings
 * say so, with no button, so the move doesn't look like nothing happened (James, 2026-11-13).
 */
export function savingCatalogueStorageInfo(what: string): CatalogueStorageInfo {
    return {
        where: 'device',
        label: 'Saving to your DBMN account…',
        help: `Saving ${what} to your DBMN account. Keep VS Code open until it says they're saved.`,
        home: {
            title: 'Saving your endpoints to your DBMN account…',
            text: `${what}. The copy is saved; keep VS Code open until it says they're in your account.`
        }
    };
}

/**
 * #427: signed out, with this computer's copy of the account's catalogue: you keep working on it,
 * and `waiting` changes go to the account at the next sign-in.
 */
export function offlineCatalogueStorageInfo(waiting: number): CatalogueStorageInfo {
    const pending = waiting === 0 ? '' : ` ${waiting} ${waiting === 1 ? 'change is' : 'changes are'} waiting.`;
    return {
        where: 'offline',
        label: 'On this computer, from your DBMN account',
        help: `You're signed out, so changes stay here and go to your account when you sign in again.${pending}`,
        removeLabel: 'Remove from this computer'
    };
}

/** Asked before the account's catalogue is removed from this computer. */
export function removeCopyPrompt(waiting: number) {
    const lost = waiting === 0 ? '' : ` The ${waiting === 1 ? 'change' : `${waiting} changes`} you made while signed out ${waiting === 1 ? 'is' : 'are'} lost.`;
    return {
        title: 'Remove your endpoints and environments from this computer?',
        body: `Your endpoints and environments stay in your DBMN account. Secrets entered on this computer are deleted.${lost}`,
        actions: [
            { id: 'cancel', label: 'Cancel', variant: 'secondary' as const },
            { id: 'remove', label: 'Remove', variant: 'danger' as const }
        ]
    };
}
