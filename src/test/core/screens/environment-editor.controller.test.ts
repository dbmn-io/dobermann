// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/** The environment editor's host logic with memory ports: what both VS Code and the web app run. */
import { expect } from 'chai';
import type { EnvironmentConfig } from '../../../environmentManager';
import type { SystemConfig } from '../../../data-loading/system-schema';
import { EnvironmentEditorController } from '../../../screens/environment/environment-editor.controller';
import { decodeJwtPayload } from '../../../utils/jwt-payload';
import { EnvironmentEditorPorts, EnvironmentRecords, SystemRecords } from '../../../screens/environment/environment-editor.ports';
import { ScreenSession } from '../../../screens/screen-session';
import type { NewEnvironmentDraft } from '../../../screens/new-environment-prompt';

type Message = Record<string, unknown>;

function memoryEnvironments(seed: EnvironmentConfig[] = []): EnvironmentRecords & { all: Map<string, EnvironmentConfig>; tokens: Map<string, string>; changed(): void } {
    const all = new Map(seed.map(e => [e.id, e]));
    const tokens = new Map<string, string>();
    const listeners = new Set<() => void>();
    const changed = () => { for (const listener of listeners) listener(); };
    let next = 1;
    return {
        all, tokens, changed,
        getEnvironment: async id => all.get(id),
        getActiveEnvironment: async () => [...all.values()].find(e => e.isActive),
        addEnvironment: async config => {
            const env = { ...config, id: `env-${next++}` } as EnvironmentConfig;
            all.set(env.id, env);
            changed();
            return env;
        },
        updateEnvironment: async (id, updates) => {
            const env = { ...all.get(id), ...updates, id } as EnvironmentConfig;
            all.set(id, env);
            changed();
            return env;
        },
        onEnvironmentsChanged: listener => { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; },
        deleteEnvironment: async id => all.delete(id),
        setActiveEnvironment: async id => all.get(id),
        getEnvironmentToken: async id => tokens.get(id),
        setEnvironmentToken: async (id, token) => { tokens.set(id, token); },
        deleteEnvironmentToken: async id => { tokens.delete(id); }
    };
}

function memorySystems(seed: string[]): SystemRecords {
    const systems: SystemConfig[] = seed.map((name, i) => ({ id: `sys-${i + 1}`, name } as SystemConfig));
    return {
        getAllSystems: async () => systems,
        addSystem: async ({ name }) => {
            const system = { id: `sys-${systems.length + 1}`, name } as SystemConfig;
            systems.push(system);
            return system;
        }
    };
}

function editor(environments: EnvironmentRecords, itemId?: string, overrides: Partial<EnvironmentEditorPorts> = {}, draft?: NewEnvironmentDraft) {
    const posted: Message[] = [];
    const toasts: string[] = [];
    const events: string[] = [];
    const session = new ScreenSession({ post: m => posted.push(m) }, { openExternal: url => events.push(`open ${url}`) });
    const ports: EnvironmentEditorPorts = {
        environments,
        systems: memorySystems(['Zeta', 'Alpha']),
        confirmDestructive: async () => true,
        toast: { info: m => toasts.push(m), error: m => toasts.push(`error: ${m}`) },
        host: {
            close: () => events.push('close'),
            saved: (env, wasNew) => events.push(`saved ${env.id} ${wasNew}`)
        },
        ...overrides
    };
    const controller = new EnvironmentEditorController(session, ports, itemId, draft);
    const types = () => posted.map(m => m.type);
    return { controller, session, posted, toasts, events, types };
}

/** An unsigned JWT with these claims. */
function jwt(claims: Record<string, unknown>): string {
    const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${part({ alg: 'none' })}.${part(claims)}.sig`;
}

const PLAYGROUND = { id: 'env-pg', name: 'Training Ground', baseUrl: 'http://127.0.0.1:54321/functions/v1/playground', authMethod: 'jwt', systemId: 'sys-2' } as unknown as EnvironmentConfig;

describe('EnvironmentEditorController', () => {
    it('opens a new environment with the Systems list in name order and nothing selected', async () => {
        const e = editor(memoryEnvironments());
        await e.controller.handle({ type: 'ready' });
        expect(e.posted).to.deep.equal([{ type: 'systemsList', systems: [{ id: 'sys-2', name: 'Alpha' }, { id: 'sys-1', name: 'Zeta' }], selectedSystemId: undefined }]);
    });

    // #415: from the New environment dialog: its System chosen, its URL and a name filled in
    it('opens a new environment on the System and URL the New environment dialog asked for', async () => {
        const e = editor(memoryEnvironments(), undefined, {}, { systemId: 'sys-1', baseUrl: 'https://acme.example.com', name: 'acme' });
        await e.controller.handle({ type: 'ready' });
        expect(e.posted).to.deep.equal([
            { type: 'systemsList', systems: [{ id: 'sys-2', name: 'Alpha' }, { id: 'sys-1', name: 'Zeta' }], selectedSystemId: 'sys-1' },
            { type: 'newEnvironmentDraft', baseUrl: 'https://acme.example.com', name: 'acme' }
        ]);
    });

    it('opens an existing environment: Systems first, then the environment, then its decoded token', async () => {
        const envs = memoryEnvironments([PLAYGROUND]);
        envs.tokens.set('env-pg', jwt({ iss: 'https://acme-auth.example.com/oauth', exp: 4102444800 }));
        const e = editor(envs, 'env-pg');
        await e.controller.handle({ type: 'ready' });
        expect(e.types()).to.deep.equal(['systemsList', 'environmentLoaded', 'tokenDecoded']);
        expect(e.posted[0].selectedSystemId).to.equal('sys-2');
        expect(e.posted[2]).to.include({ isExpired: false, baseUrl: 'https://acme.example.com' });
        expect(e.toasts, 'opening is not a state change: no toasts').to.deep.equal([]);
    });

    it('creates an environment, keeps a JWT given with it, and reports the save to the host', async () => {
        const envs = memoryEnvironments();
        const e = editor(envs);
        await e.controller.handle({ type: 'saveEnvironment', environment: { name: 'Local', baseUrl: 'http://127.0.0.1:1', authMethod: 'jwt', jwtToken: 'abc.def.ghi', systemId: 'sys-1' } });
        expect(e.types()).to.deep.equal(['environmentSaved']);
        expect(e.events).to.deep.equal(['saved env-1 true']);
        expect(envs.tokens.get('env-1')).to.equal('abc.def.ghi');
        expect(e.controller.environmentId).to.equal('env-1');

        await e.controller.handle({ type: 'saveEnvironment', environment: { id: 'env-1', name: 'Local 2' } });
        expect(e.events[1]).to.equal('saved env-1 false');
        expect(envs.all.get('env-1')?.name).to.equal('Local 2');
    });

    it('#415: an environment\'s System is fixed once it has one, whatever the page sends', async () => {
        const envs = memoryEnvironments([{ ...PLAYGROUND }]);
        const e = editor(envs, 'env-pg');
        await e.controller.handle({ type: 'saveEnvironment', environment: { id: 'env-pg', name: 'Renamed', systemId: 'sys-1' } });
        expect(envs.all.get('env-pg')?.systemId).to.equal('sys-2');
        expect(envs.all.get('env-pg')?.name).to.equal('Renamed');

        // A new one saves the System it was given
        await e.controller.handle({ type: 'saveEnvironment', environment: { name: 'New', baseUrl: 'http://127.0.0.1:2', systemId: 'sys-1' } });
        expect(envs.all.get('env-1')?.systemId).to.equal('sys-1');
    });

    it('#424: an existing environment\'s path may change, to make part of it a variable; its host never', async () => {
        const envs = memoryEnvironments([{ ...PLAYGROUND }]);
        const e = editor(envs, 'env-pg');
        const path = 'http://127.0.0.1:54321/functions/{{version}}/playground';
        await e.controller.handle({ type: 'saveEnvironment', environment: { id: 'env-pg', baseUrl: path } });
        expect(envs.all.get('env-pg')?.baseUrl).to.equal(path);

        e.posted.length = 0;
        await e.controller.handle({ type: 'saveEnvironment', environment: { id: 'env-pg', baseUrl: 'https://elsewhere.example.com/functions/v1/playground' } });
        expect(envs.all.get('env-pg')?.baseUrl, 'not saved').to.equal(path);
        expect(e.posted).to.have.length(1);
        expect(e.posted[0]).to.include({ type: 'environmentSaveError' });
        expect(String((e.posted[0] as { error: string }).error)).to.contain("host can't change");
    });

    it('#424: a variable in a new environment\'s host is refused; in its path it saves', async () => {
        const envs = memoryEnvironments();
        const e = editor(envs);
        await e.controller.handle({ type: 'saveEnvironment', environment: { name: 'D365', baseUrl: 'https://{{env}}.operations.example.com', systemId: 'sys-1' } });
        expect(envs.all.size).to.equal(0);
        expect(String((e.posted[0] as { error: string }).error)).to.contain('only be part of the path');
        await e.controller.handle({ type: 'saveEnvironment', environment: { name: 'BC', baseUrl: 'https://api.example.com/v2.0/{{tenant}}', systemId: 'sys-1' } });
        expect([...envs.all.values()].map(env => env.baseUrl)).to.deep.equal(['https://api.example.com/v2.0/{{tenant}}']);
    });

    it('#415: an older environment saved with no System can be given one', async () => {
        const envs = memoryEnvironments([{ ...PLAYGROUND, systemId: undefined }]);
        const e = editor(envs, 'env-pg');
        await e.controller.handle({ type: 'saveEnvironment', environment: { id: 'env-pg', systemId: 'sys-1' } });
        expect(envs.all.get('env-pg')?.systemId).to.equal('sys-1');
    });

    it('reports a failed save to the screen and the host', async () => {
        const envs = memoryEnvironments();
        envs.addEnvironment = async () => { throw new Error('Name is required'); };
        const failures: string[] = [];
        const e = editor(envs, undefined, { host: { close: () => undefined, saveFailed: () => failures.push('failed') } });
        await e.controller.handle({ type: 'saveEnvironment', environment: {} });
        expect(e.posted).to.deep.equal([{ type: 'environmentSaveError', error: 'Name is required' }]);
        expect(failures).to.deep.equal(['failed']);
    });

    it('stores a pasted JWT, takes the base URL from its issuer, and toasts only when expired', async () => {
        const envs = memoryEnvironments([PLAYGROUND]);
        const e = editor(envs, 'env-pg');
        await e.controller.handle({ type: 'submitToken', token: jwt({ iss: 'https://wms-auth.example.com/x', exp: 1 }) });
        expect(envs.all.get('env-pg')?.baseUrl).to.equal('https://wms.example.com');
        expect(e.types()).to.deep.equal(['tokenDecoded', 'dbmnToast']);
        expect(e.posted[1]).to.include({ level: 'warn', message: 'Token has expired but has been stored.' });
    });

    it('refuses a token too short to be a bearer token', async () => {
        const e = editor(memoryEnvironments([PLAYGROUND]), 'env-pg');
        await e.controller.handle({ type: 'submitToken', token: 'short' });
        expect(e.posted).to.deep.equal([{ type: 'tokenError', error: 'Bearer token too short to be valid' }]);
    });

    it('deletes after the destructive confirm, naming linked transactions, then closes', async () => {
        const envs = memoryEnvironments([PLAYGROUND]);
        let asked = '';
        const e = editor(envs, 'env-pg', { confirmDestructive: async ({ body }) => { asked = body; return true; }, countTransactions: async () => 2 });
        await e.controller.handle({ type: 'checkEnvironmentTransactions', environmentId: 'env-pg' });
        expect(e.posted[0]).to.deep.equal({ type: 'transactionCountResponse', count: 2 });
        await e.controller.handle({ type: 'confirmDeleteEnvironment', environmentId: 'env-pg', environmentName: 'Training Ground', transactionCount: 2 });
        expect(asked).to.contain('2 linked transactions');
        expect(envs.all.has('env-pg')).to.equal(false);
        expect(e.posted[1]).to.deep.equal({ type: 'environmentDeleted', environmentId: 'env-pg' });
        expect(e.events).to.deep.equal(['close']);
    });

    it('adds a System from its modal and selects it', async () => {
        const e = editor(memoryEnvironments());
        const done = e.controller.handle({ type: 'createSystem' });
        await new Promise(resolve => setTimeout(resolve, 0));
        const request = e.posted[0] as { requestId: string; spec: { actions: Array<{ id: string; awaitsHostSubmit?: boolean }> } };
        const create = request.spec.actions.find(a => a.awaitsHostSubmit)!;
        await e.session.handleShared({ type: 'dbmnModalActionPending', requestId: request.requestId, actionId: create.id, submitId: 's1', fields: { name: 'puppy' } });
        await e.session.handleShared({ type: 'dbmnModalResult', requestId: request.requestId, result: { actionId: create.id, fields: { name: 'puppy' } } });
        await done;
        const list = e.posted.find(m => m.type === 'systemsList')!;
        expect(list.selectedSystemId).to.equal('sys-3');
    });

    it('says plainly when the host has no OAuth or service accounts', async () => {
        const e = editor(memoryEnvironments([PLAYGROUND]), 'env-pg');
        await e.controller.handle({ type: 'oauthSignIn', environmentId: 'env-pg' });
        await e.controller.handle({ type: 'testServiceAccountAuth', config: {}, scopes: [] });
        expect(e.toasts).to.deep.equal(['error: OAuth sign-in runs in DBMN for VS Code for now.']);
        expect(e.posted[0]).to.include({ type: 'serviceAccountAuthResult', success: false });
    });

    it('decodes base64url JWT payloads, including non-ASCII claims', () => {
        expect(decodeJwtPayload(jwt({ name: 'Zoë', exp: 5 }))).to.deep.equal({ name: 'Zoë', exp: 5 });
        expect(decodeJwtPayload('not.a-jwt.x')).to.equal(null);
    });

    // #344: an environment that runs in DBMN for VS Code is signed in there; the web app shows that
    it('signed in elsewhere (DBMN for VS Code): the editor shows that state, not the browser\'s missing token', async () => {
        const sampleStore = { id: 'env-ss', name: 'Sample Store', baseUrl: 'http://127.0.0.1:54321/functions/v1/sample-store', authMethod: 'oauth', runOn: 'local-agent' } as unknown as EnvironmentConfig;
        let signedIn = false;
        const oauth = {
            signIn: async () => { signedIn = true; },
            signOut: async () => true, refresh: async () => undefined, requestNewToken: async () => undefined,
            hasRefreshToken: async () => false, adoptPastedToken: async () => undefined,
            status: async () => ({ signedIn, where: 'DBMN for VS Code' })
        };
        const e = editor(memoryEnvironments([sampleStore]), 'env-ss', { oauth });
        const statuses = () => e.posted.filter(m => m.type === 'oauthStatusUpdate').map(m => (m.status as { authenticated: boolean; userInfo: string }));

        await e.controller.handle({ type: 'loadEnvironment', environmentId: 'env-ss' });
        expect(statuses().at(-1)).to.include({ authenticated: false, userInfo: 'In DBMN for VS Code' });

        await e.controller.handle({ type: 'oauthSignIn', environmentId: 'env-ss' });
        expect(statuses().at(-1)).to.include({ authenticated: true, userInfo: 'In DBMN for VS Code' });

        signedIn = false;
        await e.controller.handle({ type: 'oauthRequestNewToken', environmentId: 'env-ss' });
        expect(statuses().at(-1), 'New Token: the state is asked of VS Code again').to.include({ authenticated: false, userInfo: 'In DBMN for VS Code' });
        expect(e.toasts).to.deep.equal(['Signed in through DBMN for VS Code.']);
    });

    // #344: the web app never keeps a secret for an environment that runs in DBMN for VS Code
    it('secrets kept elsewhere: a save drops them, whatever the page sent, and this host\'s token goes', async () => {
        const sampleStore = { id: 'env-ss', name: 'Sample Store', baseUrl: 'http://127.0.0.1:54321/functions/v1/sample-store', authMethod: 'oauth', runOn: 'browser',
            oauthConfig: { clientId: 'gd-1', clientSecret: 'old-secret', authorizationUrl: 'a', tokenUrl: 't' } } as unknown as EnvironmentConfig;
        const environments = memoryEnvironments([sampleStore]);
        environments.tokens.set('env-ss', 'browser-token');
        const e = editor(environments, 'env-ss', { secretsElsewhere: env => (env.runOn === 'local-agent' ? 'DBMN for VS Code' : undefined) });

        await e.controller.handle({ type: 'saveEnvironment', environment: { ...sampleStore, runOn: 'local-agent', jwtToken: 'x.y.z',
            oauthConfig: { clientId: 'gd-1', clientSecret: 'typed-in-the-browser', authorizationUrl: 'a', tokenUrl: 't' },
            googleServiceAccountConfig: { client_email: 'sa@example.com', private_key: 'KEY', private_key_id: 'KID' } } });

        const saved = environments.all.get('env-ss') as EnvironmentConfig & { googleServiceAccountConfig?: Record<string, unknown> };
        expect(saved.runOn).to.equal('local-agent');
        expect(saved.oauthConfig).to.deep.equal({ clientId: 'gd-1', authorizationUrl: 'a', tokenUrl: 't' });
        expect(saved.googleServiceAccountConfig).to.deep.equal({ client_email: 'sa@example.com' });
        expect(environments.tokens.has('env-ss'), 'the browser\'s token is gone').to.equal(false);

        // A Browser environment keeps its secret here, as before
        await e.controller.handle({ type: 'saveEnvironment', environment: { ...sampleStore, runOn: 'browser', oauthConfig: { ...sampleStore.oauthConfig!, clientSecret: 'kept' } } });
        expect(environments.all.get('env-ss')?.oauthConfig?.clientSecret).to.equal('kept');
    });

    // 0.4.0: no managed policies. "Run in" and the type are the user's, as saved.
    describe('an environment is just an environment', () => {
        const ERP = { id: 'env-erp', name: 'ERP', baseUrl: 'https://erp.acme.example', authMethod: 'oauth', runOn: 'browser',
            environmentType: 'production', oauthConfig: { clientId: 'erp-1', authorizationUrl: 'a', tokenUrl: 't' } } as unknown as EnvironmentConfig;

        it('opens as stored: no lock, no "managed by"', async () => {
            const e = editor(memoryEnvironments([ERP]), 'env-erp');
            await e.controller.handle({ type: 'loadEnvironment', environmentId: 'env-erp' });
            const loaded = e.posted.find(m => m.type === 'environmentLoaded') as { environment: Record<string, unknown> };
            expect(loaded.environment).to.not.have.property('prodProtect');
            expect(loaded.environment.runOn).to.equal('browser');
            expect(loaded.environment.environmentType).to.equal('production');
        });

        it('saves "Run in" and the type as chosen', async () => {
            const environments = memoryEnvironments([ERP]);
            const e = editor(environments, 'env-erp');
            await e.controller.handle({ type: 'loadEnvironment', environmentId: 'env-erp' });
            await e.controller.handle({ type: 'saveEnvironment', environment: { ...ERP, runOn: 'local-agent', environmentType: 'staging' } });
            const saved = environments.all.get('env-erp');
            expect(saved?.runOn).to.equal('local-agent');
            expect(saved?.environmentType).to.equal('staging');
            expect(e.types()).to.include('environmentSaved');
        });
    });
});

describe('EnvironmentEditorController: #415 client authentication', () => {
    const oauthEnv = (clientAuth?: 'basic' | 'body') => ({
        id: 'env-oa', name: 'Legacy', baseUrl: 'https://acme.sce.manh.com', authMethod: 'oauth', systemId: 'sys-1',
        oauthConfig: { provider: 'custom', authorizationUrl: 'https://acme-auth.sce.manh.com/oauth/authorize', tokenUrl: 'https://acme-auth.sce.manh.com/oauth/token', clientId: 'c', flowType: 'authorization_code', usePKCE: false, ...(clientAuth ? { clientAuth } : {}) }
    }) as unknown as EnvironmentConfig;

    it('an OAuth environment saved before the setting existed shows the choice it has been using', async () => {
        const e = editor(memoryEnvironments([oauthEnv()]), 'env-oa');
        await e.controller.handle({ type: 'ready' });
        const loaded = e.posted.find(m => m.type === 'environmentLoaded')?.environment as EnvironmentConfig;
        expect(loaded.oauthConfig?.clientAuth).to.equal('basic');
    });

    it('an environment\'s own choice is shown as saved, whatever the legacy rule would say', async () => {
        const e = editor(memoryEnvironments([oauthEnv('body')]), 'env-oa');
        await e.controller.handle({ type: 'ready' });
        const loaded = e.posted.find(m => m.type === 'environmentLoaded')?.environment as EnvironmentConfig;
        expect(loaded.oauthConfig?.clientAuth).to.equal('body');
    });

    it('a new environment from a Standard System takes the System\'s default; one without a default says nothing', async () => {
        const standard = { id: 'mawm', name: 'mawm', scope: 'global', createdAt: 0, config: { oauth: { tokenRequest: { clientAuth: 'basic' } } } } as unknown as SystemConfig;
        const plain = { id: 'sys-1', name: 'Own', createdAt: 0 } as SystemConfig;
        const systems: SystemRecords = { getAllSystems: async () => [standard, plain], addSystem: async () => plain };

        const fromStandard = editor(memoryEnvironments(), undefined, { systems }, { systemId: 'mawm', baseUrl: 'https://acme.example', name: 'mawm: acme' });
        await fromStandard.controller.handle({ type: 'ready' });
        expect(fromStandard.posted.find(m => m.type === 'newEnvironmentDraft')).to.include({ clientAuth: 'basic' });

        const fromOwn = editor(memoryEnvironments(), undefined, { systems }, { systemId: 'sys-1', baseUrl: 'https://acme.example', name: 'acme' });
        await fromOwn.controller.handle({ type: 'ready' });
        expect(fromOwn.posted.find(m => m.type === 'newEnvironmentDraft')).to.not.have.property('clientAuth');
    });
});

describe('EnvironmentEditorController: #415 the Standard System\'s sign-in, read live', () => {
    const samplewms = { id: 'samplewms', name: 'samplewms', scope: 'global', createdAt: 0, config: {
        match: '^(?<instance>[a-z0-9-]+)\\.samplewms\\.test$',
        oauth: { authorizeUrl: 'https://{{instance}}-auth.samplewms.test/oauth/authorize', tokenUrl: 'https://{{instance}}-auth.samplewms.test/oauth/token', scopes: ['openid'], pkce: false, flow: 'authorization_code', tokenRequest: { clientAuth: 'basic' } }
    } } as unknown as SystemConfig;
    const systems: SystemRecords = { getAllSystems: async () => [samplewms], addSystem: async () => samplewms };
    const onSystem = { id: 'env-s', name: 'Acme', baseUrl: 'https://acme.samplewms.test', authMethod: 'oauth', systemId: 'samplewms', oauthConfig: { provider: 'custom', clientId: 'c', tokenUrl: 'https://mine.example/token' } } as unknown as EnvironmentConfig;

    it('opens an environment with the System\'s defaults where it has none of its own, and tells the page what the System says', async () => {
        const e = editor(memoryEnvironments([onSystem]), 'env-s', { systems });
        await e.controller.handle({ type: 'ready' });
        const loaded = e.posted.find(m => m.type === 'environmentLoaded')?.environment as EnvironmentConfig;
        expect(loaded.oauthConfig).to.include({ clientId: 'c', authorizationUrl: 'https://acme-auth.samplewms.test/oauth/authorize', tokenUrl: 'https://mine.example/token', clientAuth: 'basic', flowType: 'authorization_code' });
        expect(loaded.oauthConfig).to.not.have.property('system');
        const defaults = e.posted.find(m => m.type === 'oauthDefaults')?.defaults as { systemName: string; authorizationUrl: string };
        expect(defaults).to.include({ systemName: 'samplewms', authorizationUrl: 'https://acme-auth.samplewms.test/oauth/authorize' });
    });

    it('answers the page when the address changes, with nothing for an own System', async () => {
        const e = editor(memoryEnvironments(), undefined, { systems });
        await e.controller.handle({ type: 'resolveOAuthDefaults', baseUrl: 'https://beta.samplewms.test', systemId: 'samplewms' });
        expect(e.posted[0]).to.have.property('type', 'oauthDefaults');
        expect(e.posted[0].defaults).to.include({ tokenUrl: 'https://beta-auth.samplewms.test/oauth/token' });
        await e.controller.handle({ type: 'resolveOAuthDefaults', baseUrl: 'https://beta.samplewms.test', systemId: 'sys-1' });
        expect(e.posted[1].defaults).to.equal(undefined);
    });

    it('saves only the user\'s own OAuth values: what equals the System\'s default is read live from then on', async () => {
        const envs = memoryEnvironments([onSystem]);
        const e = editor(envs, 'env-s', { systems });
        await e.controller.handle({ type: 'saveEnvironment', environment: { ...onSystem, oauthConfig: {
            provider: 'custom', clientId: 'c', authorizationUrl: 'https://acme-auth.samplewms.test/oauth/authorize', tokenUrl: 'https://mine.example/token',
            scopes: ['openid'], flowType: 'authorization_code', usePKCE: false, clientAuth: 'basic', system: { name: 'samplewms' }
        } } });
        expect(envs.all.get('env-s')?.oauthConfig).to.deep.equal({ provider: 'custom', clientId: 'c', tokenUrl: 'https://mine.example/token' });
    });
});

describe('EnvironmentEditorController: #415 a new environment starts with its Standard System\'s default headers', () => {
    const samplewms = { id: 'samplewms', name: 'samplewms', scope: 'global', createdAt: 0, config: {
        defaultHeaders: { Organization: '{{org}}', 'Content-Type': 'application/json' },
        defaultVariables: { org: { showInHeader: true } }
    } } as unknown as SystemConfig;
    const systems: SystemRecords = { getAllSystems: async () => [samplewms], addSystem: async () => samplewms };

    it('fills them in when the page sends none; leaves headers the user set, and an existing environment, alone', async () => {
        const envs = memoryEnvironments();
        const e = editor(envs, undefined, { systems });
        await e.controller.handle({ type: 'saveEnvironment', environment: { name: 'Acme', baseUrl: 'https://acme.samplewms.test', systemId: 'samplewms', authMethod: 'none' } });
        const saved = [...envs.all.values()][0];
        expect(saved.headers).to.deep.equal({ Organization: { value: '{{org}}', enabled: true }, 'Content-Type': { value: 'application/json', enabled: true } });

        const own = memoryEnvironments();
        await editor(own, undefined, { systems }).controller.handle({ type: 'saveEnvironment', environment: { name: 'Mine', baseUrl: 'https://x.samplewms.test', systemId: 'samplewms', authMethod: 'none', headers: { Accept: { value: '*/*', enabled: true } } } });
        expect([...own.all.values()][0].headers).to.deep.equal({ Accept: { value: '*/*', enabled: true } });

        await e.controller.handle({ type: 'saveEnvironment', environment: { ...saved, headers: {} } });
        expect(envs.all.get(saved.id)?.headers, 'an existing environment keeps what the page sent').to.deep.equal({});
    });

    it('#424 and the variables they read: org, empty, in the header; variables the page sent are kept', async () => {
        const envs = memoryEnvironments();
        await editor(envs, undefined, { systems }).controller.handle({ type: 'saveEnvironment', environment: { name: 'Acme', baseUrl: 'https://acme.samplewms.test', systemId: 'samplewms', authMethod: 'none' } });
        const saved = [...envs.all.values()][0];
        expect(saved.variables).to.deep.equal({ org: '' });
        expect(saved.variableSettings).to.deep.equal({ org: { showInHeader: true } });

        const own = memoryEnvironments();
        await editor(own, undefined, { systems }).controller.handle({ type: 'saveEnvironment', environment: { name: 'Mine', baseUrl: 'https://x.samplewms.test', systemId: 'samplewms', authMethod: 'none', variables: { org: 'ACME' } } });
        expect([...own.all.values()][0].variables).to.deep.equal({ org: 'ACME' });
    });
});

describe('EnvironmentEditorController: #424 variable settings', () => {
    it('saves a variable\'s options and header flag beside its value', async () => {
        const envs = memoryEnvironments();
        const e = editor(envs);
        await e.controller.handle({ type: 'saveEnvironment', environment: { name: 'BC', baseUrl: 'https://bc.example', systemId: 'sys-1', authMethod: 'none',
            variables: { company: 'CRONUS' }, variableSettings: { company: { options: ['CRONUS', 'Contoso'], source: 'manual', showInHeader: true } } } });
        const saved = [...envs.all.values()][0];
        expect(saved.variables).to.deep.equal({ company: 'CRONUS' });
        expect(saved.variableSettings).to.deep.equal({ company: { options: ['CRONUS', 'Contoso'], source: 'manual', showInHeader: true } });
    });
});


describe('EnvironmentEditorController: the environment changes under the form', () => {
    const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
    const staging = (): EnvironmentConfig => ({ id: 'env-s', name: 'Staging', baseUrl: 'https://staging.example', environmentType: 'development',
        authMethod: 'none', variables: { org: 'aus' }, variableSettings: { org: { options: ['aus', 'nz'], source: 'manual', showInHeader: true } } } as unknown as EnvironmentConfig);

    // The manager for James, 2026-11-23: "Updated: settings changed" popped up on every unrelated save (a saved search)
    // with an Environment tab open. An environment kept without createdAt is given Date.now() on every read
    // (sanitizeEnvironmentConfig), and lastUsed moves when another environment is picked: neither is a setting
    it('an unrelated save, or a reading that differs only in createdAt or lastUsed, is no change; a real one still is', async () => {
        const environments = memoryEnvironments([staging()]);
        let clock = 1000;
        const read = environments.getEnvironment;
        // (as the manager reads it: createdAt made up afresh on each read, lastUsed moved by picking it elsewhere)
        environments.getEnvironment = async id => { const env = await read(id); return env ? { ...env, createdAt: clock++, lastUsed: clock++ } as EnvironmentConfig : undefined; };
        const { controller, posted } = editor(environments, 'env-s');
        await controller.handle({ type: 'loadEnvironment', environmentId: 'env-s' });
        environments.changed();   // something else saved (a query's saved search, another environment)
        await settle();
        expect(posted.filter(m => m.type === 'environmentChangedElsewhere')).to.deep.equal([]);
        // A real change: still said
        await environments.updateEnvironment('env-s', { variables: { org: 'nz' } });
        await settle();
        const told = posted.find(m => m.type === 'environmentChangedElsewhere') as { changes: string[] } | undefined;
        expect(told?.changes).to.deep.equal(['org is now nz']);
    });

    it('a form with no edits takes the change and says what moved', async () => {
        const environments = memoryEnvironments([staging()]);
        const { controller, session, posted } = editor(environments, 'env-s');
        await controller.handle({ type: 'loadEnvironment', environmentId: 'env-s' });
        // The header picker sets org elsewhere
        await environments.updateEnvironment('env-s', { variables: { org: 'nz' } });
        await settle();
        const told = posted.find(m => m.type === 'environmentChangedElsewhere') as { changes: string[]; stored: EnvironmentConfig } | undefined;
        expect(told?.changes).to.deep.equal(['org is now nz']);
        // The page had no edits: it applied the change, and a save now goes straight through
        await controller.handle({ type: 'environmentChangeApplied', environment: told!.stored });
        posted.length = 0;
        await controller.handle({ type: 'saveEnvironment', environment: { ...told!.stored, description: 'after' } });
        expect(posted.map(m => m.type)).to.include('environmentSaved').and.not.include('dbmnModalRequest');
        expect(environments.all.get('env-s')?.variables).to.deep.equal({ org: 'nz' });
        expect(session, 'session kept').to.be.ok;
    });

    it('a form with edits is asked at save time, and nothing is written over the change', async () => {
        const environments = memoryEnvironments([staging()]);
        const { controller, session, posted, events } = editor(environments, 'env-s');
        await controller.handle({ type: 'loadEnvironment', environmentId: 'env-s' });
        await environments.updateEnvironment('env-s', { variables: { org: 'nz' } });
        await settle();
        // No environmentChangeApplied: the page had edits. The stale form saves with org=aus
        const stale = { ...staging(), description: 'typed meanwhile' };
        const saving = controller.handle({ type: 'saveEnvironment', environment: stale });
        await settle();
        const request = posted.find(m => m.type === 'dbmnModalRequest') as { requestId: string; spec: { title: string; body: string } };
        expect(request.spec.title).to.equal('Changed since you opened it');
        expect(request.spec.body).to.contain('org is now nz');
        await session.handleShared({ type: 'dbmnModalResult', requestId: request.requestId, result: { actionId: 'keep', fields: {} } });
        await saving;
        expect(environments.all.get('env-s')?.variables, 'the store keeps the newer value').to.deep.equal({ org: 'nz' });
        expect(environments.all.get('env-s')?.description).to.equal(undefined);
        expect(events).to.not.include.members(['saved env-s false']);
        expect(posted.map(m => m.type)).to.not.include('environmentSaved');
    });

    it('Reload in that dialog loads the newer environment into the form', async () => {
        const environments = memoryEnvironments([staging()]);
        const { controller, session, posted } = editor(environments, 'env-s');
        await controller.handle({ type: 'loadEnvironment', environmentId: 'env-s' });
        await environments.updateEnvironment('env-s', { name: 'Staging 2' });
        await settle();
        posted.length = 0;
        const saving = controller.handle({ type: 'saveEnvironment', environment: { ...staging(), description: 'x' } });
        await settle();
        const request = posted.find(m => m.type === 'dbmnModalRequest') as { requestId: string };
        await session.handleShared({ type: 'dbmnModalResult', requestId: request.requestId, result: { actionId: 'reload', fields: {} } });
        await saving;
        const loaded = posted.filter(m => m.type === 'environmentLoaded').pop() as { environment: { name: string } } | undefined;
        expect(loaded?.environment.name).to.equal('Staging 2');
        // and after the reload, a save of the fresh form goes through
        posted.length = 0;
        await controller.handle({ type: 'saveEnvironment', environment: { ...environments.all.get('env-s')!, description: 'now fine' } });
        expect(posted.map(m => m.type)).to.include('environmentSaved');
    });

    it('its own save is not a change from elsewhere', async () => {
        const environments = memoryEnvironments([staging()]);
        const { controller, posted } = editor(environments, 'env-s');
        await controller.handle({ type: 'loadEnvironment', environmentId: 'env-s' });
        posted.length = 0;
        await controller.handle({ type: 'saveEnvironment', environment: { ...staging(), description: 'mine' } });
        await settle();
        expect(posted.map(m => m.type)).to.include('environmentSaved').and.not.include('environmentChangedElsewhere');
        // and a second save after it is not asked either
        posted.length = 0;
        await controller.handle({ type: 'saveEnvironment', environment: { ...environments.all.get('env-s')!, description: 'again' } });
        expect(posted.map(m => m.type)).to.include('environmentSaved').and.not.include('dbmnModalRequest');
    });
});
