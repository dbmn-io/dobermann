// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Production execution guard (GitHub Issue #273)
 *
 * A standard "you are about to hit PRODUCTION" confirmation for any execution
 * that fires live requests. Triggered purely by the active environment's
 * `environmentType === 'production'` flag — there is no separate on/off setting.
 * A user who finds the prompt noisy changes that environment's type instead.
 *
 * The user can suppress the warning for a short window (15 / 30 / 60 minutes)
 * from within the modal. Suppression is deliberately kept in an in-memory,
 * per-environment map: it is ephemeral by nature, needs no persistence, and
 * keeps us off `vscode`-scoped storage on the portability path (see
 * docs/portability/spa-migration.md). A window reload resumes warnings, which
 * is the safe default for a production guard.
 *
 * Extension-host-side only. The modal is rendered by DbmnModal via the shared
 * bridge (Hub-global, or an explicit `host` webview) — see dbmn-prompts.ts.
 */
import type { DbmnModalSpec, DbmnModalResult, ModalHost } from '../../screens/modal.types';

/** Minimal shape this guard needs from an environment. Structural so callers
 *  can pass their concrete `EnvironmentConfig` without a hard dependency. */
export interface ProductionGuardEnv {
    id: string;
    name: string;
    environmentType?: string;
}

type Bridge = (spec: DbmnModalSpec) => Promise<DbmnModalResult>;

/** Suppression expiry (epoch ms) keyed by environment id. Module-level so the
 *  window is shared across every call site (Run API, batch, …) regardless of
 *  which service instance drives the execution. */
const suppressedUntil = new Map<string, number>();

/** The suppress-duration choices offered in the modal (minutes). */
const SUPPRESS_OPTIONS: Array<{ value: string; label: string }> = [
    { value: '0', label: 'Warn me every time' },
    { value: '15', label: "Don't warn again for 15 minutes" },
    { value: '30', label: "Don't warn again for 30 minutes" },
    { value: '60', label: "Don't warn again for 60 minutes" }
];

/** True when the environment is flagged as production. */
export function isProductionEnvironment(env: ProductionGuardEnv | undefined | null): boolean {
    return env?.environmentType === 'production';
}

/** True while a live suppression window is active for this environment. */
function isSuppressed(envId: string): boolean {
    const until = suppressedUntil.get(envId);
    if (until == null) return false;
    if (Date.now() >= until) {
        suppressedUntil.delete(envId);
        return false;
    }
    return true;
}

/** Suppress the production warning for `minutes` for this environment. */
function suppress(envId: string, minutes: number): void {
    if (minutes > 0) {
        suppressedUntil.set(envId, Date.now() + minutes * 60_000);
    }
}

/** Clear any active suppression (used by tests / env deletion cleanup). */
export function clearProductionSuppression(envId?: string): void {
    if (envId) {
        suppressedUntil.delete(envId);
    } else {
        suppressedUntil.clear();
    }
}

/**
 * Gate a live execution against a production environment.
 *
 * Returns `true` when the caller may proceed:
 *   - non-production environment → always proceeds (no prompt)
 *   - production but within an active suppression window → proceeds silently
 *   - production and confirmed → proceeds, applying any chosen suppression
 *
 * Returns `false` only when the user cancels/dismisses the confirmation.
 *
 * @param env    active environment (needs id, name, environmentType)
 * @param action human label for what is about to run, e.g. "Run API"
 * @param host   optional modal host so the prompt renders over that webview
 *               (e.g. the Run Batch panel) instead of the Hub
 */
export async function confirmProductionExecution(
    env: ProductionGuardEnv,
    action: string,
    host?: ModalHost
): Promise<boolean> {
    if (!isProductionEnvironment(env)) return true;
    if (isSuppressed(env.id)) return true;

    const bridge: Bridge | undefined = host
        ? (spec) => host.showModal(spec)
        : ((globalThis as Record<string, unknown>).dbmnShowModal as Bridge | undefined);

    // No modal surface at all (headless/CLI) — fail safe by proceeding rather
    // than dead-ending the execution. A production environment being executed
    // headlessly is an explicit, deliberate action.
    if (!bridge) return true;

    const result = await bridge({
        title: 'Production environment',
        body: `You are about to run "${action}" against the PRODUCTION environment "${env.name}".`
            + ' This sends live requests to production. Continue?',
        fields: [{
            id: 'suppress',
            type: 'radio',
            label: 'Warning frequency',
            value: '0',
            options: SUPPRESS_OPTIONS
        }],
        actions: [
            { id: 'cancel', label: 'Cancel', variant: 'secondary' },
            { id: 'execute', label: 'Execute on production', variant: 'danger' }
        ],
        dismissible: true,
        size: 'sm'
    });

    if (result.actionId !== 'execute') return false;

    const minutes = parseInt(result.fields.suppress || '0', 10);
    if (!Number.isNaN(minutes)) suppress(env.id, minutes);
    return true;
}
