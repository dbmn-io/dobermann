// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #415: a new environment asks for its System first, then its base URL (James, 2026-10-23), so
 * a Standard (global) System's configuration can apply from the start. Then the environment
 * editor opens with both filled in, and a name from the URL. Core: the Hub in both hosts.
 *
 * - The Standard Systems are listed first, then the user's own, then "+ Add new System…".
 * - A URL that matches a Standard System (its `config.match`) picks it when none was chosen.
 *   One that matches a different Standard System from the one chosen asks which to use: nothing
 *   switches without the user seeing it.
 * - With no Standard Systems loaded yet, it says they arrive from DBMN when online (#418: no sign-in needed).
 * - A URL an environment already has warns, and offers that one (James, 2026-10-25). Only a
 *   warning: two environments on one URL can differ in sign-in or settings, so "Add another"
 *   stays. When the existing one is on a different System from the one chosen, it can be moved
 *   to it: the one way a saved environment's System changes, asked for in so many words.
 */
import { SystemConfig, isGlobalSystem } from '../data-loading/system-schema';
import { globalSystemForUrl, suggestEnvironmentName, urlHost } from '../services/systems/system-match';
import { baseUrlProblem, isSameBaseUrl } from '../utils/environment-url';
import { DbmnModalSpec, ModalHost } from './modal.types';
import { promptNewSystemInModal } from './new-system-prompt';

/** What the environment editor opens with. */
export interface NewEnvironmentDraft {
    systemId: string;
    baseUrl: string;
    name: string;
}

/** An environment that already has the URL, opened instead (and first moved to `moveToSystemId`). */
export interface ExistingEnvironmentChoice {
    openEnvironmentId: string;
    moveToSystemId?: string;
}

/** The environments already there, as far as the URL check needs them. */
export interface KnownEnvironment {
    id: string;
    name: string;
    baseUrl?: string;
    systemId?: string;
}

export const ADD_NEW_SYSTEM = '__new__';
export const STANDARD_SYSTEMS = 'Standard Systems';
export const YOUR_SYSTEMS = 'Your Systems';
/** #418: the Standard Systems need no sign-in; when none are listed they have not arrived yet. */
export const STANDARD_SYSTEMS_NOT_LOADED = 'The Standard Systems have not loaded yet; they arrive from DBMN when you are online.';

type Fields = Record<string, string>;
type FieldError = Error & { fieldErrors?: Record<string, string> };

function fieldError(field: string, message: string): FieldError {
    const error = new Error(message) as FieldError;
    error.fieldErrors = { [field]: message };
    return error;
}

/** The System choices: Standard Systems, then the user's own, each by name; then Add. */
export function systemOptions(systems: SystemConfig[]): Array<{ value: string; label: string; group?: string }> {
    const byName = (a: SystemConfig, b: SystemConfig) => a.name.localeCompare(b.name);
    const standard = systems.filter(isGlobalSystem).sort(byName);
    const own = systems.filter(s => !isGlobalSystem(s)).sort(byName);
    return [
        { value: '', label: '-- Select System --' },
        ...standard.map(s => ({ value: s.id, label: s.name, group: STANDARD_SYSTEMS })),
        ...own.map(s => ({ value: s.id, label: s.name, group: standard.length ? YOUR_SYSTEMS : undefined })),
        { value: ADD_NEW_SYSTEM, label: '+ Add new System…' }
    ];
}

/** @returns the System and URL to open the editor with, or undefined if the user cancelled. */
export async function promptNewEnvironmentInModal(
    systemManager: { getAllSystems(): Promise<SystemConfig[]>; addSystem(config: { name: string }): Promise<SystemConfig> },
    host: ModalHost,
    options: { environments?: KnownEnvironment[] } = {}
): Promise<NewEnvironmentDraft | ExistingEnvironmentChoice | undefined> {
    const systems = await systemManager.getAllSystems();
    const hasStandard = systems.some(isGlobalSystem);
    let chosen: { systemId: string; baseUrl: string } | undefined;

    const result = await host.showModal({
        title: 'New environment',
        body: !hasStandard
            ? `Choose its System, then the address of its API. ${STANDARD_SYSTEMS_NOT_LOADED}`
            : 'Choose its System, then the address of its API.',
        fields: [
            { id: 'system', type: 'select', label: 'System', value: '', options: systemOptions(systems), autoFocus: true },
            { id: 'baseUrl', type: 'text', label: 'Base URL', placeholder: 'e.g. https://api.example.com' }
        ],
        actions: [
            { id: 'cancel', label: 'Cancel', variant: 'secondary' },
            {
                id: 'continue',
                label: 'Continue',
                variant: 'primary',
                onSubmit: async (fields: Fields) => {
                    const baseUrl = (fields.baseUrl || '').trim();
                    // #424: a variable may be part of the path, never the host
                    const variableProblem = baseUrl.includes('{{') ? baseUrlProblem(baseUrl) : undefined;
                    if (variableProblem) throw fieldError('baseUrl', variableProblem);
                    if (!urlHost(baseUrl)) throw fieldError('baseUrl', 'Enter the full address, starting https://');
                    const systemId = fields.system || globalSystemForUrl(baseUrl, systems)?.id || '';
                    if (!systemId) throw fieldError('system', 'Pick a System, or + Add new System…');
                    chosen = { systemId, baseUrl };
                }
            }
        ],
        dismissible: true,
        size: 'sm',
        help: { doc: 'environments', title: 'New environment' }
    });
    if (result.actionId !== 'continue' || !chosen) return undefined;

    let { systemId } = chosen;
    const { baseUrl } = chosen;

    // The URL belongs to a different Standard System from the one chosen: ask, never switch quietly
    const matched = globalSystemForUrl(baseUrl, systems);
    if (matched && matched.id !== systemId) {
        const picked = systemId === ADD_NEW_SYSTEM ? 'a new System' : `"${systems.find(s => s.id === systemId)?.name ?? systemId}"`;
        const answer = await host.showModal({
            title: `Use ${matched.name}?`,
            body: `This address looks like a ${matched.name} environment. ${matched.name} is a standard System, set up by DBMN.`,
            actions: [
                { id: 'keep', label: `Keep ${picked}`, variant: 'secondary' },
                { id: 'use', label: `Use ${matched.name}`, variant: 'primary' }
            ],
            dismissible: true,
            size: 'sm'
        });
        if (answer.actionId === 'use') systemId = matched.id;
        else if (answer.actionId !== 'keep') return undefined;
    }

    let systemName = systems.find(s => s.id === systemId)?.name ?? '';
    const existing = (options.environments ?? []).filter(env => isSameBaseUrl(env.baseUrl, baseUrl));
    if (existing.length) {
        const choice = await askAboutExisting(existing, systemId, systems, host);
        if (!choice) return undefined;
        if (choice.action === 'open') return { openEnvironmentId: choice.environmentId };
        if (choice.action === 'move') {
            let moveTo = systemId;
            if (moveTo === ADD_NEW_SYSTEM) {
                const created = await promptNewSystemInModal(systemManager, host);
                if (!created) return undefined;
                moveTo = created.id;
            }
            return { openEnvironmentId: choice.environmentId, moveToSystemId: moveTo };
        }
    }

    if (systemId === ADD_NEW_SYSTEM) {
        const created = await promptNewSystemInModal(systemManager, host);
        if (!created) return undefined;
        systemId = created.id;
        systemName = created.name;
    }

    return { systemId, baseUrl, name: suggestEnvironmentName(baseUrl, systemName) };
}

type ExistingAnswer = { action: 'open' | 'move'; environmentId: string } | { action: 'add' };

/**
 * The URL is taken: open the environment that has it (the default), move it to the System just
 * chosen when that differs, or add another anyway. Several with the URL: pick which one.
 */
async function askAboutExisting(
    existing: KnownEnvironment[], systemId: string, systems: SystemConfig[], host: ModalHost
): Promise<ExistingAnswer | undefined> {
    const systemName = (id?: string) => (id && systems.find(s => s.id === id)?.name) || 'no System';
    const chosenName = systemId === ADD_NEW_SYSTEM ? 'a new System' : systemName(systemId);
    const differs = existing.some(env => env.systemId !== systemId);
    const one = existing.length === 1 ? existing[0] : undefined;

    // The buttons are one word each; the message names the environment and the Systems
    const another = 'or add a new one for this URL.';
    let body: string;
    if (one && one.systemId === systemId) {
        body = `You already have "${one.name}" for this URL. Open it, ${another}`;
    } else if (one) {
        body = `"${one.name}" already uses this URL, under ${systemName(one.systemId)}. You chose ${chosenName}. `
            + `Move it to ${chosenName}, open it as it is, ${another}`;
    } else {
        body = `You already have ${existing.length} environments for this URL. You chose ${chosenName}. `
            + `Pick one to ${differs ? 'move or open' : 'open'}, ${another}`;
    }

    // Closing the modal (its ✕, or Escape) cancels
    const actions: DbmnModalSpec['actions'] = [{ id: 'add', label: 'New', variant: 'secondary' }];
    if (differs) actions.push({ id: 'move', label: 'Move', variant: 'secondary' });
    actions.push({ id: 'open', label: 'Open', variant: 'primary' });

    const answer = await host.showModal({
        title: 'This URL already has an environment',
        body,
        fields: one ? undefined : [{
            id: 'environment',
            type: 'radio',
            value: existing[0].id,
            options: existing.map(env => ({ value: env.id, label: env.name, description: systemName(env.systemId) }))
        }],
        actions,
        dismissible: true,
        size: 'sm'
    });
    if (answer.actionId === 'add') return { action: 'add' };
    if (answer.actionId !== 'open' && answer.actionId !== 'move') return undefined;
    const environmentId = one ? one.id : (answer.fields.environment || existing[0].id);
    // Moving one that is already on the chosen System is just opening it
    const picked = existing.find(env => env.id === environmentId);
    if (answer.actionId === 'move' && picked?.systemId !== systemId) return { action: 'move', environmentId };
    return { action: 'open', environmentId };
}
