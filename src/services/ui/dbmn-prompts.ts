// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * DBMN modal prompts — shared helpers for replacing VS Code's native modals
 * (`vscode.window.showWarningMessage({ modal: true }, ...)`) with the DBMN-
 * branded `DbmnModal` component hosted by the Hub webview.
 *
 * Architecture:
 *   - `HubWebviewManager.registerGlobalBridge()` (see hub-manager.ts) writes
 *     a `dbmnShowModal` function onto `globalThis` whenever the Hub is open.
 *   - Each helper here tries that bridge first. If absent (Hub not loaded —
 *     e.g. legacy sidebar tree, CLI-triggered runs, tests), the helper
 *     falls back to the original VS Code modal so the user is never
 *     stranded without an option.
 *   - All helpers are extension-host-side (no webview-only imports).
 *
 * Don't add cross-cutting state here — keep this module a pure adapter
 * between extension-host call sites and the DbmnModal API.
 */
import { authExpiredModal } from '../environment/auth-gate';
import * as vscode from 'vscode';
import { IDbmnAuthService } from '../dbmn-auth/dbmn-auth.interface';
import { IToastService } from '../notifications/toast.interface';
import { SystemConfig, validateShortIdentifier } from '../../data-loading/system-schema';
import { DbmnModalResult, DbmnModalSpec, ModalHost, modalWaitError } from '../../screens/modal.types';
import { SignInLinkTooSoonError } from '../dbmn-auth/sign-in-link-wait';
import { promptNewSystemInModal, SystemManagerLike } from '../../screens/new-system-prompt';

export type { DbmnModalResult, DbmnModalSpec, ModalHost } from '../../screens/modal.types';
import { ConfirmDestructiveOptions, confirmDestructiveInModal } from '../../screens/confirm-destructive';
export type { SystemManagerLike } from '../../screens/new-system-prompt';

type Bridge = (spec: DbmnModalSpec) => Promise<DbmnModalResult>;

/** Return the global modal bridge if a Hub instance has registered one. */
function tryBridge(): Bridge | undefined {
    return (globalThis as Record<string, unknown>).dbmnShowModal as Bridge | undefined;
}

/** Pick a bridge for ext-host modal prompts. Preference order:
 *   1. An explicit `host` (e.g. an editor WebviewBase) so the modal renders
 *      on top of the surface the user was working in.
 *   2. The global Hub bridge for everything else.
 *   3. None → caller falls back to VS Code's native modal. */
function pickBridge(host?: ModalHost): Bridge | undefined {
    if (host) return (spec: DbmnModalSpec) => host.showModal(spec);
    return tryBridge();
}

// ─── Auth prompts ───────────────────────────────────────────────────────

/**
 * "Authentication token has expired" for a per-environment token (OAuth /
 * dbmn-auth / JWT). Three-way choice: Sign In, Continue (use expired token —
 * for diagnostic testing), Cancel/dismiss.
 *
 * Returns the legacy string ('Sign In' / 'Continue' / undefined) so the
 * existing switch-on-string callers don't have to change.
 */
export async function promptEnvAuthExpired(envName?: string): Promise<'Sign In' | 'Continue' | undefined> {
    // GitHub Issue #396: this is the environment's own sign-in, not the DBMN account. Name
    // the environment and say so — the two can be asked for one after the other.
    const body = envName
        ? `Your sign-in to "${envName}" has expired. That is its own login, separate from your DBMN account. Sign in again, or continue with the expired sign-in.`
        : 'Authentication token has expired. How would you like to proceed?';

    const bridge = tryBridge();
    if (bridge) {
        // The same modal the web app shows (core: auth-gate.ts)
        const result = await bridge(authExpiredModal(envName));
        if (result.actionId === 'sign-in') return 'Sign In';
        if (result.actionId === 'continue') return 'Continue';
        return undefined;
    }

    return await vscode.window.showWarningMessage(
        body,
        { modal: true },
        'Sign In',
        'Continue'
    ) as 'Sign In' | 'Continue' | undefined;
}

/**
 * "DBMN authentication has expired" — for the platform-wide DBMN account
 * session (not per-environment). Two-way: Sign In, Cancel/dismiss. There's
 * no "Continue" because there's no way to proceed without a DBMN session.
 *
 * On Sign In, runs the in-app magic-link flow. Returns true if the user
 * opted to sign in, false if they cancelled.
 */
export async function promptDbmnAuthExpired(
    dbmnAuth: IDbmnAuthService,
    toast: IToastService,
    message?: string,
    host?: ModalHost
): Promise<boolean> {
    const body = message || 'DBMN authentication has expired. Sign in to continue.';

    const bridge = pickBridge(host);
    if (bridge) {
        const result = await bridge({
            title: 'Sign in required',
            body,
            actions: [
                { id: 'cancel',  label: 'Cancel',  variant: 'secondary' },
                { id: 'sign-in', label: 'Sign In', variant: 'primary' }
            ],
            dismissible: true,
            size: 'sm'
        });
        if (result.actionId !== 'sign-in') return false;
        await sendDbmnSignInLinkInApp(dbmnAuth, toast, host);
        return true;
    }

    // No webview anywhere — fall back to a native modal, then surface the
    // sign-in modal once a webview is available. Without any UI surface we
    // can't capture an email, so the user is told to open the Account panel.
    const choice = await vscode.window.showWarningMessage(
        body,
        { modal: true },
        'Sign In'
    );
    if (choice !== 'Sign In') return false;
    toast.info('Open the Dobermann Hub to sign in.');
    return true;
}

/**
 * GitHub Issue #263: single-step in-app sign-in modal.
 *
 * Shows one modal: email field + Cancel + Sign In. Pre-fills the email from
 * the active session (if any), else the persisted `lastEmail` (so the value
 * survives sign-out and token expiry). On submit, calls Supabase OTP with
 * `create_user: true` — same code path covers new-user signup and returning
 * sign-in. On success the modal dismisses and a toast confirms the link was
 * sent; the user clicks the link out of band to complete sign-in.
 */
export async function sendDbmnSignInLinkInApp(
    dbmnAuth: IDbmnAuthService,
    toast: IToastService,
    host?: ModalHost
): Promise<void> {
    const bridge = pickBridge(host);
    if (!bridge) {
        // No bridge anywhere — surface a hint and bail. The browser fallback
        // is gone (issue #263); the in-app modal is now the only sign-in surface.
        toast.warn('Open the Dobermann Hub or Account panel to sign in.');
        return;
    }

    const knownEmail = dbmnAuth.getAuthState().session?.email
        || dbmnAuth.getLastEmail()
        || '';

    // The Sign In action's `onSubmit` runs while the modal stays open with
    // a spinner on the button (DbmnModal handles that). It throws on bad
    // input or send failure; the bridge promise then rejects and we surface
    // the message in a follow-up modal so the user can retry.
    // Issue #396: with an email on record this is someone signing in again, not creating an
    // account — say nothing about new accounts above their own address (it read as if every
    // link made one). Only a machine with no email on record is told how to get an account.
    const signInBody = 'Sign in with your password, or use "Email me a link" if you sign in by email.';
    const body = knownEmail
        ? signInBody
        : `${signInBody} New to DBMN? Enter your email and choose "Email me a link" to create your account.`;

    let sentTo = '';
    let prompt: { actionId: string; fields: Record<string, string> };
    try {
        prompt = await bridge({
            title: 'Sign in to DBMN',
            body,
            fields: [
                {
                    id: 'email',
                    type: 'email',
                    label: 'Email',
                    value: knownEmail,
                    placeholder: 'your@email.com',
                    autoFocus: !knownEmail
                },
                {
                    id: 'password',
                    type: 'password',
                    label: 'Password',
                    value: '',
                    placeholder: 'Your DBMN password',
                    autoFocus: !!knownEmail
                }
            ],
            actions: [
                { id: 'cancel', label: 'Cancel', variant: 'secondary' },
                {
                    // Separate, explicit magic-link button — no adaptive guessing.
                    id: 'magic',
                    label: 'Email me a link',
                    variant: 'secondary',
                    onSubmit: async (fields: Record<string, string>) => {
                        const email = (fields.email || '').trim();
                        if (!email) throw new Error('Please enter an email address.');
                        try {
                            await dbmnAuth.sendMagicLink(email);
                        } catch (error) {
                            // Asked again within the minute: the dialog stays open and counts down
                            if (error instanceof SignInLinkTooSoonError) {
                                throw modalWaitError({ actionId: 'magic', field: 'email', seconds: error.seconds, text: 'A link was just sent. You can ask for another in {seconds}.' });
                            }
                            throw error;
                        }
                        sentTo = email;
                    }
                },
                {
                    // "Sign In" ONLY does password now — it can never email a link.
                    id: 'password',
                    label: 'Sign In',
                    variant: 'primary',
                    onSubmit: async (fields: Record<string, string>) => {
                        const email = (fields.email || '').trim();
                        const password = fields.password || '';
                        if (!email) throw new Error('Please enter an email address.');
                        if (!password) throw new Error('Please enter your password (or use "Email me a link").');
                        await dbmnAuth.authenticateWithPassword(email, password);
                    }
                }
            ],
            dismissible: true,
            size: 'sm'
        });
    } catch (error) {
        const msg = error instanceof Error ? error.message : 'Sign-in failed. Please try again.';
        await bridge({
            title: 'Could not sign in',
            body: msg,
            actions: [{ id: 'ok', label: 'OK', variant: 'primary' }],
            dismissible: true,
            size: 'sm'
        });
        return;
    }

    if (prompt.actionId === 'password') {
        // authenticateWithPassword established the session + fired its own
        // "Signed in" toast via the auth service; nothing more to do here.
        return;
    }
    if (prompt.actionId === 'magic') {
        toast.info(`Sign-in link sent to ${sentTo}. Check your inbox (and spam folder), then click the link to finish signing in.`);
    }
}

// ─── Unsaved-changes prompt ─────────────────────────────────────────────

/**
 * "You have unsaved changes" — three-way: Save, Discard, Cancel/dismiss.
 * Returned by `WebviewBase.showUnsavedChangesDialog`. Cancel comes back as
 * `'cancel'` for both explicit Cancel and X/Escape dismiss.
 */
export async function confirmUnsavedChanges(host?: ModalHost): Promise<'save' | 'discard' | 'cancel'> {
    const body = 'You have unsaved changes. What would you like to do?';

    const bridge = pickBridge(host);
    if (bridge) {
        const result = await bridge({
            title: 'Before we go on…',
            body,
            actions: [
                { id: 'cancel',  label: 'Cancel',           variant: 'secondary' },
                { id: 'discard', label: 'Discard Changes',  variant: 'danger' },
                { id: 'save',    label: 'Save and Continue', variant: 'primary' }
            ],
            dismissible: true,
            // No size cap — the modal grows to fit the action row so the
            // three buttons never wrap. The body text is short enough that
            // unbounded width still feels balanced.
        });
        if (result.actionId === 'save') return 'save';
        if (result.actionId === 'discard') return 'discard';
        return 'cancel';
    }

    const choice = await vscode.window.showWarningMessage(
        body,
        { modal: true },
        'Save and Continue',
        'Discard Changes',
        'Cancel'
    );
    if (choice === 'Save and Continue') return 'save';
    if (choice === 'Discard Changes') return 'discard';
    return 'cancel';
}

// ─── Destructive confirm ────────────────────────────────────────────────

/**
 * "Are you sure?" — yes/no with a danger-styled confirm button.
 * Returns true if confirmed, false if cancelled or dismissed.
 */
export async function confirmDestructive(opts: ConfirmDestructiveOptions): Promise<boolean> {
    const bridge = tryBridge();
    if (bridge) {
        return confirmDestructiveInModal({ showModal: bridge }, opts);
    }

    const confirmLabel = opts.confirmLabel || 'Delete';
    const choice = await vscode.window.showWarningMessage(
        opts.body,
        { modal: true },
        confirmLabel
    );
    return choice === confirmLabel;
}

/**
 * Generic multi-choice prompt. Renders as a DBMN modal when a Hub webview is
 * open (bridge), falling back to a native message with the same action labels
 * as a last resort when nothing is open (e.g. activation-time, no webview yet).
 * Returns the chosen action's `id`, or `undefined` if dismissed/cancelled.
 *
 * Use for host-side decisions that gate logic and can't collapse into a
 * fire-and-forget toast. For plain notifications use `IToastService`.
 */
export async function hostChoice(opts: {
    title?: string;
    body: string;
    actions: Array<{ id: string; label: string; variant?: 'primary' | 'secondary' | 'danger' }>;
}): Promise<string | undefined> {
    const bridge = tryBridge();
    if (bridge) {
        const result = await bridge({
            title: opts.title,
            body: opts.body,
            actions: opts.actions,
            dismissible: true,
            size: 'sm'
        });
        return result.actionId === 'dismiss' ? undefined : result.actionId;
    }

    // Native fallback — last resort when no webview surface exists.
    const choice = await vscode.window.showInformationMessage(
        opts.body,
        ...opts.actions.map(a => a.label)
    );
    return opts.actions.find(a => a.label === choice)?.id;
}

// ─── New System name prompt ─────────────────────────────────────────────

/**
 * Prompt the user for a new System name and create it. Single entry point
 * used by every "Add System" affordance — endpoint editor's System picker,
 * environment editor's System picker, and the Hub's Settings section — so
 * the prompt UX + validation cannot drift between surfaces (it used to be
 * three copy-pasted `vscode.window.showInputBox` calls kept in sync only by
 * a comment; now it's one implementation).
 *
 * Bridge-first: opens a DbmnModal inside the caller's own webview (or the
 * Hub if no `host`), runs `validateShortIdentifier` on submit — invalid
 * input paints inline red text next to the field via the `fieldErrors`
 * path (see dbmn-modal.js paintFieldErrors), duplicates are rejected the
 * same way. Validity is re-checked at submit time so a concurrent create
 * from another surface can't sneak past a stale existingNames snapshot.
 *
 * Native fallback preserved for tree-view / CLI callers where no webview
 * is loaded.
 *
 * @returns the created System, or `undefined` if the user cancelled.
 */
export async function promptForNewSystemName(
    systemManager: SystemManagerLike,
    host?: ModalHost
): Promise<SystemConfig | undefined> {
    const bridge = pickBridge(host);
    if (!bridge) {
        // No modal surface — fall back to VS Code's native input box so
        // headless / activation-time callers still work.
        const existing = await systemManager.getAllSystems();
        const existingNames = new Set(existing.map(s => s.name.toLowerCase()));
        const name = await vscode.window.showInputBox({
            prompt: 'New System name (lowercase, a–z 0–9, max 16)',
            placeHolder: 'e.g. WMS, ERP, Training Ground',
            validateInput: (v: string) => validateShortIdentifier(v, { kind: 'System', existingNames })
        });
        if (!name) return undefined;
        return systemManager.addSystem({ name: name.trim().toLowerCase() });
    }

    return promptNewSystemInModal(systemManager, { showModal: bridge });
}
