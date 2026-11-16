// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #362: no secret in a device's plain state. VS Code's own catalogue (`environments` in
 * globalState: signed out, "keep catalogue local only", and the copy left behind after the move
 * to the account, #342) used to hold whole environments, client secrets and keys included. Their
 * secrets now live in the vault under the same key the account catalogue uses
 * (`catalogue-secrets:environment:<id>`, CatalogueState), and the plain copy keeps everything else.
 *
 * - VaultedDeviceStore: the device's store as the managers see it: `environments` reads with its
 *   secrets put back from the vault, and writes without them (the secrets to the vault). Opened
 *   once (`load`) before anything reads it; every other key and the vault pass straight through.
 * - moveDeviceSecrets: the one-time move for the other plain copies (the pre-#342 per-account
 *   device copies, `catalogue:<backend>:<user>:device:environments`).
 *
 * A secret already in the vault wins over a plain copy's (the vault is what this version edits).
 * An older version of the extension reading the plain copy finds the environments without their
 * secrets, and asks for them again; nothing is lost.
 *
 * The move happens ONCE per device (DEVICE_SECRETS_MOVED_KEY). Secrets found in the plain copy
 * after that were put there by an older version still in use on this machine (it shares this
 * state: a marketplace install beside a dev build, or a downgrade). Stripping them again on every
 * start would make that version lose them every time, so its copy is then left as it wrote it;
 * the vault only takes what it lacks. What this version itself saves never has secrets in it.
 */
import type { EnvironmentCollection, EnvironmentConfig } from '../../environmentManager';
import type { IKeyValueStore } from '../../platform/interfaces/key-value-store.interface';
import type { ISecretStore } from '../../platform/interfaces/secret-store.interface';
import type { StoreContext } from '../../platform/interfaces/store-context.interface';
import { environmentSecrets, withEnvironmentSecrets, type EnvironmentSecrets } from './catalogue-safe-form';

/** The vault key for an environment's secrets: the same one CatalogueState uses. */
export const environmentSecretKey = (environmentId: string) => `catalogue-secrets:environment:${environmentId}`;

const ENVIRONMENTS = 'environments';
/** Device state: when this device's plain environments had their secrets moved to the vault. */
export const DEVICE_SECRETS_MOVED_KEY = 'dbmn_device_secrets_moved_at';

type Plain = Record<string, unknown> & {
    oauthConfig?: Record<string, unknown>;
    googleServiceAccountConfig?: Record<string, unknown>;
    headers?: Record<string, { value?: string; secret?: boolean } & Record<string, unknown>>;
    variables?: Record<string, string>;
};

/** The environment with exactly what environmentSecrets takes out of it removed. */
export function withoutEnvironmentSecrets<T extends object>(environment: T): T {
    const secrets = environmentSecrets(environment as unknown as EnvironmentConfig);
    if (!secrets) return environment;
    const env = structuredClone(environment) as unknown as Plain;
    if (secrets.clientSecret && env.oauthConfig) delete env.oauthConfig.clientSecret;
    if (secrets.serviceAccountKey && env.googleServiceAccountConfig) {
        delete env.googleServiceAccountConfig.private_key;
        delete env.googleServiceAccountConfig.private_key_id;
    }
    for (const field of Object.keys(secrets.tokens ?? {})) delete env[field];
    for (const name of Object.keys(secrets.headers ?? {})) if (env.headers?.[name]) env.headers[name] = { ...env.headers[name], value: '' };
    for (const name of Object.keys(secrets.variables ?? {})) if (env.variables) env.variables[name] = '';
    return env as unknown as T;
}

/** An environment's secrets into the vault, unless the vault already has some for it. */
async function vaultOnce(vault: ISecretStore, environment: object): Promise<void> {
    const id = (environment as { id?: string }).id;
    const secrets = environmentSecrets(environment as EnvironmentConfig);
    if (!id || !secrets || await vault.get(environmentSecretKey(id))) return;
    await vault.store(environmentSecretKey(id), JSON.stringify(secrets));
}

export class VaultedDeviceStore implements StoreContext {
    /** `environments` as the managers see it: secrets on. */
    private collection?: EnvironmentCollection;
    /** What the vault holds per environment, so unchanged secrets aren't rewritten. */
    private readonly vaulted = new Map<string, string>();
    private queue: Promise<unknown> = Promise.resolve();

    readonly globalState: StoreContext['globalState'];
    readonly secrets: ISecretStore;

    constructor(private readonly device: Pick<IKeyValueStore, 'get' | 'update'>, vault: ISecretStore) {
        this.secrets = vault;
        this.globalState = {
            get: (<V>(key: string, defaultValue?: V) => key === ENVIRONMENTS
                ? (this.collection === undefined ? defaultValue : structuredClone(this.collection))
                : device.get(key, defaultValue)) as StoreContext['globalState']['get'],
            update: (key: string, value: unknown) => (key === ENVIRONMENTS ? this.save(value as EnvironmentCollection | undefined) : device.update(key, value))
        };
    }

    /**
     * Read the device's environments. The first time on this device, secrets still in the plain
     * copy move to the vault and the copy is rewritten without them; after that, a plain copy
     * that has secrets again is an older version's, and is left alone (see the header).
     */
    async load(): Promise<void> {
        const movedBefore = !!this.device.get<string>(DEVICE_SECRETS_MOVED_KEY);
        if (!movedBefore) await this.device.update(DEVICE_SECRETS_MOVED_KEY, new Date().toISOString());
        const stored = this.device.get<EnvironmentCollection>(ENVIRONMENTS);
        if (!stored) return;
        const environments = stored.environments ?? [];
        for (const environment of environments) await vaultOnce(this.secrets, environment);
        if (!movedBefore && environments.some(environment => environmentSecrets(environment))) {
            await this.device.update(ENVIRONMENTS, { ...stored, environments: environments.map(e => withoutEnvironmentSecrets(e)) });
        }
        const merged: EnvironmentConfig[] = [];
        for (const environment of environments) {
            const raw = await this.secrets.get(environmentSecretKey(environment.id));
            if (raw) this.vaulted.set(environment.id, raw);
            merged.push(withEnvironmentSecrets(withoutEnvironmentSecrets(environment), raw ? JSON.parse(raw) as EnvironmentSecrets : undefined));
        }
        this.collection = { ...stored, environments: merged };
    }

    private save(collection: EnvironmentCollection | undefined): Promise<void> {
        this.collection = collection === undefined ? undefined : structuredClone(collection);
        const write = this.queue.then(async () => {
            const environments = collection?.environments ?? [];
            const kept = new Set<string>();
            for (const environment of environments) {
                kept.add(environment.id);
                const secrets = environmentSecrets(environment);
                const json = secrets ? JSON.stringify(secrets) : undefined;
                if (json === this.vaulted.get(environment.id)) continue;
                if (json) {
                    await this.secrets.store(environmentSecretKey(environment.id), json);
                    this.vaulted.set(environment.id, json);
                } else {
                    await this.secrets.delete(environmentSecretKey(environment.id));
                    this.vaulted.delete(environment.id);
                }
            }
            for (const id of [...this.vaulted.keys()]) {
                if (kept.has(id)) continue;
                await this.secrets.delete(environmentSecretKey(id));   // the environment went: so do its secrets
                this.vaulted.delete(id);
            }
            await this.device.update(ENVIRONMENTS, collection && { ...collection, environments: environments.map(e => withoutEnvironmentSecrets(e)) });
        });
        this.queue = write.catch(() => undefined);
        return write;
    }
}

/**
 * The pre-#342 per-account device copies (`catalogue:<backend>:<user>:device:environments`, by
 * id) kept whole environments: their secrets to the vault, and the copies rewritten without them.
 */
export async function moveDeviceSecrets(device: Pick<IKeyValueStore, 'get' | 'update' | 'keys'>, vault: ISecretStore): Promise<number> {
    let moved = 0;
    for (const key of device.keys()) {
        if (!/^catalogue:.*:device:environments$/.test(key)) continue;
        const copy = device.get<Record<string, Record<string, unknown>>>(key);
        if (!copy || !Object.values(copy).some(item => environmentSecrets(item as unknown as EnvironmentConfig))) continue;
        const cleaned: Record<string, Record<string, unknown>> = {};
        for (const [id, item] of Object.entries(copy)) {
            await vaultOnce(vault, { ...item, id });
            cleaned[id] = withoutEnvironmentSecrets(item);
            if (environmentSecrets(item as unknown as EnvironmentConfig)) moved++;
        }
        await device.update(key, cleaned);
    }
    return moved;
}
