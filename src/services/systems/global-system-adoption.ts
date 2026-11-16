// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #415: a user's own System with a global System's name (e.g. an own `acmewms` made before the
 * global one existed) is switched to the global System, without asking (James, 2026-10-23):
 * its endpoints and environments move onto the global System, its own settings on it
 * (SYSTEM_PREFERENCE_FIELDS) are kept as the user's settings for the global System, and the own
 * System goes. As Import and the move to the account already match Systems by name (#290, #342).
 *
 * And an environment with no System whose address matches a global System's pattern
 * (`config.match`) is linked to that System, on every device, as soon as the global Systems
 * load: its sign-in rules then apply (phase 3). An environment the user put on an own System
 * is left alone.
 *
 * Runs whenever the Systems or the environments change: the global ones loaded or refreshed,
 * the catalogue loaded (the account's or this device's), an Import added a System. With
 * nothing to do it does nothing, so it is safe to run again and again.
 */
import type { SystemConfig } from '../../data-loading/system-schema';
import { isGlobalSystem, SYSTEM_PREFERENCE_FIELDS, SystemPreferences } from '../../data-loading/system-schema';
import type { EnvironmentConfig, EnvironmentManager } from '../../environmentManager';
import type { SystemManager } from '../../systemManager';
import type { SystemOperationsService } from './system-operations.service';
import { globalSystemForUrl } from './system-match';

export interface GlobalSystemSwitch {
    from: SystemConfig;
    to: SystemConfig;
}

/** Own Systems named like a global System, each with the global System it switches to. */
export function systemsToSwitch(systems: SystemConfig[]): GlobalSystemSwitch[] {
    const globalByName = new Map(systems.filter(isGlobalSystem).map(s => [s.name.trim().toLowerCase(), s]));
    const switches: GlobalSystemSwitch[] = [];
    for (const system of systems) {
        if (isGlobalSystem(system)) continue;
        const to = globalByName.get(system.name.trim().toLowerCase());
        if (to && to.id !== system.id) switches.push({ from: system, to });
    }
    return switches;
}

/** Switch every own System named like a global one. Returns what was switched. */
export async function switchToGlobalSystems(
    systems: Pick<SystemManager, 'getAllSystems' | 'updateSystem'>,
    operations: Pick<SystemOperationsService, 'mergeSystems'>
): Promise<GlobalSystemSwitch[]> {
    const switches = systemsToSwitch(await systems.getAllSystems());
    for (const { from, to } of switches) {
        // The own System's settings, where the user has none for the global System yet
        const preferences: SystemPreferences = {};
        for (const field of SYSTEM_PREFERENCE_FIELDS) {
            if (from[field] !== undefined && to[field] === undefined) preferences[field] = from[field];
        }
        if (Object.keys(preferences).length) await systems.updateSystem(to.id, preferences);
        const summary = await operations.mergeSystems([from.id], to.id);
        console.log(`[Systems] issue#415 switched own System "${from.name}" (${from.id}) to the global "${to.name}":`
            + ` ${summary.endpointsTouched} endpoint(s), ${summary.environmentsTouched} environment(s)`);
    }
    return switches;
}

export interface EnvironmentLink {
    environment: Pick<EnvironmentConfig, 'id' | 'name' | 'baseUrl'>;
    to: SystemConfig;
}

/** Environments with no System whose address matches a global System, each with that System. */
export function environmentsToLink(
    environments: Array<Pick<EnvironmentConfig, 'id' | 'name' | 'baseUrl' | 'systemId'>>,
    systems: SystemConfig[]
): EnvironmentLink[] {
    const links: EnvironmentLink[] = [];
    for (const environment of environments) {
        if (environment.systemId) continue;
        const to = globalSystemForUrl(environment.baseUrl ?? '', systems);
        if (to) links.push({ environment, to });
    }
    return links;
}

/** Link every System-less environment whose address matches a global System. Returns what was linked. */
export async function linkEnvironmentsToGlobalSystems(
    environments: Pick<EnvironmentManager, 'getAllEnvironments' | 'updateEnvironment'>,
    systems: Pick<SystemManager, 'getAllSystems'>
): Promise<EnvironmentLink[]> {
    const links = environmentsToLink(await environments.getAllEnvironments(), await systems.getAllSystems());
    for (const { environment, to } of links) {
        await environments.updateEnvironment(environment.id, { systemId: to.id });
        console.log(`[Systems] issue#415 linked environment "${environment.name}" (${environment.baseUrl}) to the global System "${to.name}"`);
    }
    return links;
}

/**
 * Switch and link now and whenever the Systems or the environments change. One run at a time;
 * a change during a run runs it once more afterwards (the run's own writes cause one, which
 * then finds nothing to do).
 */
export function wireGlobalSystemSwitch(
    systems: Pick<SystemManager, 'getAllSystems' | 'updateSystem' | 'onSystemsChanged'>,
    operations: Pick<SystemOperationsService, 'mergeSystems'>,
    environments?: Pick<EnvironmentManager, 'getAllEnvironments' | 'updateEnvironment' | 'onEnvironmentsChanged'>
): { dispose(): void } {
    let running = false;
    let again = false;
    const run = async (): Promise<void> => {
        if (running) {
            again = true;
            return;
        }
        running = true;
        try {
            do {
                again = false;
                await switchToGlobalSystems(systems, operations);
                if (environments) await linkEnvironmentsToGlobalSystems(environments, systems);
            } while (again);
        } catch (error) {
            // Left as it was: the next change tries again
            console.warn('[Systems] issue#415 switching to a global System failed:', error);
        } finally {
            running = false;
        }
    };
    const subscriptions = [systems.onSystemsChanged(() => void run())];
    if (environments) subscriptions.push(environments.onEnvironmentsChanged(() => void run()));
    void run();
    return { dispose: () => subscriptions.forEach(s => s.dispose()) };
}
