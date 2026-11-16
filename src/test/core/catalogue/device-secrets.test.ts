// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #362: no secret in a device's plain state. VS Code's own catalogue keeps its environments'
 * secrets in the vault; the plain copies (which older versions read) lose them, once.
 */
import { expect } from 'chai';
import { MemoryKeyValueStore } from '../../../platform/memory/memory-key-value-store';
import type { ISecretStore } from '../../../platform/interfaces/secret-store.interface';
import { DEVICE_SECRETS_MOVED_KEY, environmentSecretKey, moveDeviceSecrets, VaultedDeviceStore, withoutEnvironmentSecrets } from '../../../services/catalogue/device-secrets';
import type { EnvironmentCollection, EnvironmentConfig } from '../../../environmentManager';

class MemoryVault implements ISecretStore {
    readonly values = new Map<string, string>();
    async get(key: string) { return this.values.get(key); }
    async store(key: string, value: string) { this.values.set(key, value); }
    async delete(key: string) { this.values.delete(key); }
}

const oauth = (id: string, secret = 's3cret'): EnvironmentConfig => ({
    id, name: `Env ${id}`, baseUrl: 'https://api.example', authMethod: 'oauth',
    oauthConfig: { clientId: 'app', clientSecret: secret, tokenUrl: '/token' },
    headers: { 'X-Api-Key': { value: 'key-value', enabled: true, secret: true }, Accept: { value: 'json', enabled: true } },
    variables: { tenant: 'acme', password: 'pw' }, secretVariables: ['password']
} as unknown as EnvironmentConfig);

const collection = (...environments: EnvironmentConfig[]): EnvironmentCollection =>
    ({ environments, folders: [], version: '1.2.0' } as unknown as EnvironmentCollection);

const plainText = (device: MemoryKeyValueStore) => JSON.stringify(device.get('environments'));

describe('Device secrets in the vault (#362)', () => {
    it('opening: secrets in the plain copy move to the vault, and the copy is rewritten without them', async () => {
        const device = new MemoryKeyValueStore();
        const vault = new MemoryVault();
        await device.update('environments', collection(oauth('e1')));

        const store = new VaultedDeviceStore(device, vault);
        await store.load();

        const plain = plainText(device);
        expect(plain, 'no client secret').not.to.contain('s3cret');
        expect(plain, 'no secret header value').not.to.contain('key-value');
        expect(plain, 'no secret variable value').not.to.contain('"pw"');
        expect(plain, 'everything else stays').to.contain('acme').and.to.contain('"json"');
        expect(JSON.parse(vault.values.get(environmentSecretKey('e1'))!).clientSecret).to.equal('s3cret');
        // The managers see the whole environment
        const seen = store.globalState.get<EnvironmentCollection>('environments')!.environments[0] as unknown as Record<string, any>;
        expect(seen.oauthConfig.clientSecret).to.equal('s3cret');
        expect(seen.headers['X-Api-Key'].value).to.equal('key-value');
        expect(seen.variables.password).to.equal('pw');
    });

    it('saving: secrets to the vault, the rest to plain state; a deleted environment\'s secrets go', async () => {
        const device = new MemoryKeyValueStore();
        const vault = new MemoryVault();
        const store = new VaultedDeviceStore(device, vault);
        await store.load();

        await store.globalState.update('environments', collection(oauth('e1', 'first'), oauth('e2', 'second')));
        expect(plainText(device)).not.to.contain('first').and.not.to.contain('second');
        expect(JSON.parse(vault.values.get(environmentSecretKey('e2'))!).clientSecret).to.equal('second');

        await store.globalState.update('environments', collection(oauth('e1', 'changed')));
        expect(JSON.parse(vault.values.get(environmentSecretKey('e1'))!).clientSecret).to.equal('changed');
        expect(vault.values.has(environmentSecretKey('e2')), 'e2 deleted: its secrets too').to.equal(false);
        expect(plainText(device)).not.to.contain('changed');
    });

    it('a secret already in the vault wins over a plain copy\'s', async () => {
        const device = new MemoryKeyValueStore();
        const vault = new MemoryVault();
        await vault.store(environmentSecretKey('e1'), JSON.stringify({ clientSecret: 'from-the-vault' }));
        await device.update('environments', collection(oauth('e1', 'stale-plain')));

        const store = new VaultedDeviceStore(device, vault);
        await store.load();

        const seen = store.globalState.get<EnvironmentCollection>('environments')!.environments[0];
        expect(seen.oauthConfig?.clientSecret).to.equal('from-the-vault');
        expect(plainText(device)).not.to.contain('stale-plain');
    });

    it('the move happens once: secrets an older version writes back afterwards stay in its copy', async () => {
        const device = new MemoryKeyValueStore();
        const vault = new MemoryVault();
        await device.update('environments', collection(oauth('e1', 'original')));
        await new VaultedDeviceStore(device, vault).load();
        expect(plainText(device), 'moved the first time').not.to.contain('original');
        expect(device.get<string>(DEVICE_SECRETS_MOVED_KEY)).to.be.a('string');

        // An older version on the same machine (it shares this state) has its secret re-entered,
        // and adds an environment of its own
        await device.update('environments', collection(oauth('e1', 're-entered'), oauth('e2', 'older-only')));
        const next = new VaultedDeviceStore(device, vault);
        await next.load();

        expect(plainText(device), 'its copy is left as it wrote it').to.contain('re-entered').and.to.contain('older-only');
        expect(JSON.parse(vault.values.get(environmentSecretKey('e1'))!).clientSecret, 'the vault keeps its own').to.equal('original');
        expect(JSON.parse(vault.values.get(environmentSecretKey('e2'))!).clientSecret, 'and takes what it lacked').to.equal('older-only');
        // What this version saves never has secrets in it
        await next.globalState.update('environments', collection(oauth('e1', 'saved-here')));
        expect(plainText(device)).not.to.contain('saved-here');
    });

    it('a device with nothing to move is marked too: later plain secrets are an older version\'s', async () => {
        const device = new MemoryKeyValueStore();
        const vault = new MemoryVault();
        await new VaultedDeviceStore(device, vault).load();
        await device.update('environments', collection(oauth('e1', 'older-version')));
        await new VaultedDeviceStore(device, vault).load();
        expect(plainText(device)).to.contain('older-version');
    });

    it('every other key passes straight through', async () => {
        const device = new MemoryKeyValueStore();
        const store = new VaultedDeviceStore(device, new MemoryVault());
        await store.load();
        await store.globalState.update('dbmn_recent_endpoints', ['a']);
        expect(device.get('dbmn_recent_endpoints')).to.deep.equal(['a']);
        expect(store.globalState.get('environments', 'none')).to.equal('none');
    });

    it('the pre-#342 per-account device copies lose their secrets too', async () => {
        const device = new MemoryKeyValueStore();
        const vault = new MemoryVault();
        const { id: _id, ...item } = oauth('e1', 'old-copy') as unknown as Record<string, unknown>;
        await device.update('catalogue:local:user-1:device:environments', { e1: { ...item, isActive: true } });
        await device.update('catalogue:local:user-1:device:endpoints', { x: { sequenceCounter: 4 } });

        expect(await moveDeviceSecrets(device, vault)).to.equal(1);

        expect(JSON.stringify(device.get('catalogue:local:user-1:device:environments'))).not.to.contain('old-copy');
        expect((device.get<Record<string, Record<string, unknown>>>('catalogue:local:user-1:device:environments'))!.e1.isActive).to.equal(true);
        expect(JSON.parse(vault.values.get(environmentSecretKey('e1'))!).clientSecret).to.equal('old-copy');
        expect(device.get('catalogue:local:user-1:device:endpoints'), 'other copies untouched').to.deep.equal({ x: { sequenceCounter: 4 } });
        expect(await moveDeviceSecrets(device, vault), 'once').to.equal(0);
    });

    it('withoutEnvironmentSecrets takes out exactly the secrets', () => {
        const env = withoutEnvironmentSecrets(oauth('e1')) as unknown as Record<string, any>;
        expect(env.oauthConfig).to.deep.equal({ clientId: 'app', tokenUrl: '/token' });
        expect(env.headers.Accept.value).to.equal('json');
        expect(env.headers['X-Api-Key']).to.include({ value: '', secret: true });
        expect(env.variables).to.deep.equal({ tenant: 'acme', password: '' });
    });
});
