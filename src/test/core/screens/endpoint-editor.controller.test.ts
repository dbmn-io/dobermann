// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/** The endpoint editor's host logic with memory ports: what both VS Code and the web app run. */
import { expect } from 'chai';
import * as XLSX from 'xlsx';
import type { APIEndpointConfig } from '../../../apiConfigManager';
import type { EnvironmentConfig } from '../../../environmentManager';
import { endpointTemplateVariables } from '../../../screens/endpoint/data-template';
import { EndpointEditorController, EndpointEditorConfig, tagsInUse } from '../../../screens/endpoint/endpoint-editor.controller';
import { EndpointEditorPorts, EndpointRecords } from '../../../screens/endpoint/endpoint-editor.ports';
import { ScreenSession } from '../../../screens/screen-session';

type Message = Record<string, unknown>;

const CARRIERS = {
    id: 'ep-carriers', name: 'List Carriers', method: 'GET', path: '/carriers', headers: {}, queryParams: {}, body: '', systemId: 'sys-pg'
} as unknown as APIEndpointConfig;

const ACTIVE = { id: 'env-pg', name: 'Training Ground', baseUrl: 'http://127.0.0.1:54321/functions/v1/playground', systemId: 'sys-pg', variables: { org: 'ACME' }, isActive: true } as unknown as EnvironmentConfig;

function memoryEndpoints(seed: APIEndpointConfig[] = []): EndpointRecords & { all: Map<string, APIEndpointConfig> } {
    const all = new Map(seed.map(e => [e.id, e]));
    let next = 1;
    return {
        all,
        getEndpoint: async id => all.get(id),
        addEndpoint: async config => {
            const ep = { ...config, id: `ep-${next++}` } as APIEndpointConfig;
            all.set(ep.id, ep);
            return ep;
        },
        updateEndpoint: async (id, updates) => {
            const ep = { ...all.get(id), ...updates, id } as APIEndpointConfig;
            all.set(id, ep);
            return ep;
        },
        deleteEndpoint: async id => all.delete(id)
    };
}

function editor(endpoints: EndpointRecords, config: EndpointEditorConfig = {}, overrides: Partial<EndpointEditorPorts> = {}) {
    const posted: Message[] = [];
    const events: string[] = [];
    const session = new ScreenSession({ post: m => posted.push(m) }, { openExternal: url => events.push(`open ${url}`) });
    const ports: EndpointEditorPorts = {
        endpoints,
        environments: {
            getActiveEnvironment: async () => ACTIVE,
            getEnvironmentToken: async () => undefined
        },
        systems: {
            getAllSystems: async () => [{ id: 'sys-pg', name: 'playground' }, { id: 'sys-a', name: 'acme' }] as never,
            addSystem: async () => { throw new Error('unused'); }
        },
        confirmDestructive: async () => true,
        toast: { info: m => events.push(`info ${m}`), warn: m => events.push(`warn ${m}`), error: m => events.push(`error ${m}`) },
        readClipboard: async () => '',
        runApi: async ep => { events.push(`run ${ep.id}`); },
        openRunBatch: async ep => { events.push(`batch ${ep.id}`); },
        openEnvironmentWithVariables: async (id, vars) => { events.push(`env ${id} ${vars.join(',')}`); },
        saveFile: async (name, bytes) => { events.push(`file ${name} ${bytes.length > 0}`); return name; },
        host: { close: () => events.push('close'), saved: (ep, wasNew) => events.push(`saved ${ep.id} ${wasNew}`), saveFailed: () => events.push('save failed') },
        ...overrides
    };
    return { controller: new EndpointEditorController(session, ports, config), session, posted, events };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('EndpointEditorController', () => {
    it('an open editor follows the active environment: {{ENV:org}} found once it is chosen (2026-10-10)', async () => {
        let active: EnvironmentConfig | undefined;
        let changed: (() => void) | undefined;
        const { controller, posted } = editor(memoryEndpoints([CARRIERS]), { itemId: CARRIERS.id }, {
            environments: {
                getActiveEnvironment: async () => active,
                getEnvironmentToken: async () => undefined,
                onEnvironmentsChanged: listener => { changed = listener; return { dispose: () => { changed = undefined; } }; }
            }
        });
        await controller.handle({ type: 'getCurrentEnvironment' });
        active = { ...ACTIVE, variables: { org: '840' } } as unknown as EnvironmentConfig;
        changed?.();
        await tick();
        const sent = posted.filter(m => m.type === 'currentEnvironmentData').map(m => (m.environment as { variables?: Record<string, string> }).variables);
        expect(sent.at(-1)).to.deep.equal({ org: '840' });
        controller.dispose();
        expect(changed, 'unsubscribed on close').to.equal(undefined);
    });

    it('opens a new endpoint with the active environment\'s System selected', async () => {
        const e = editor(memoryEndpoints(), { itemId: 'new-1' });
        await e.controller.handle({ type: 'ready' });
        expect(e.posted).to.deep.equal([{ type: 'systemsList', systems: [{ id: 'sys-a', name: 'acme' }, { id: 'sys-pg', name: 'playground' }], selectedSystemId: 'sys-pg' }]);
    });

    it('opens a saved endpoint with its own System (none stays none) and its data', async () => {
        const e = editor(memoryEndpoints([{ ...CARRIERS, systemId: undefined } as APIEndpointConfig]), { itemId: 'ep-carriers' });
        await e.controller.handle({ type: 'ready' });
        expect(e.posted[0].selectedSystemId).to.equal(undefined);
        expect(e.posted[1]).to.include({ type: 'populateEndpointData', body: '' });
    });

    it('opens a duplicate as an id-less COPY draft', async () => {
        const e = editor(memoryEndpoints([CARRIERS]), { itemId: 'new-2', duplicateFromId: 'ep-carriers' });
        await e.controller.handle({ type: 'ready' });
        expect(e.posted[0].selectedSystemId).to.equal('sys-pg');
        const data = e.posted[1] as { endpoint: APIEndpointConfig; isDuplicate: boolean };
        expect(data.isDuplicate).to.equal(true);
        expect(data.endpoint.id).to.equal(undefined);
        expect(data.endpoint.name).to.equal('COPY List Carriers');
    });

    it('saves a draft as a new endpoint, then updates it', async () => {
        const endpoints = memoryEndpoints();
        const e = editor(endpoints, { itemId: 'new-3' });
        const draft = { ...CARRIERS, id: 'new-3' };
        await e.controller.handle({ type: 'saveEndpoint', endpoint: draft });
        expect(e.events).to.deep.equal(['saved ep-1 true']);
        expect(e.posted[0]).to.include({ type: 'endpointSaved' });
        await e.controller.handle({ type: 'saveEndpoint', endpoint: { ...draft, id: 'ep-1', name: 'Carriers' } });
        expect(e.events[1]).to.equal('saved ep-1 false');
        expect(endpoints.all.get('ep-1')?.name).to.equal('Carriers');
    });

    it('refuses an invalid endpoint without saving, and tells the host at once', async () => {
        const endpoints = memoryEndpoints();
        const e = editor(endpoints);
        await e.controller.handle({ type: 'saveEndpoint', endpoint: { ...CARRIERS, path: 'carriers' } });
        expect(String(e.posted[0].error)).to.contain('Endpoint path must start with /');
        expect(e.events).to.deep.equal(['save failed']);
        expect(endpoints.all.size).to.equal(0);
    });

    it('runs the saved endpoint through the host', async () => {
        const e = editor(memoryEndpoints([CARRIERS]), { itemId: 'ep-carriers' });
        await e.controller.handle({ type: 'executeAPIInBackground', endpointId: 'ep-carriers' });
        await e.controller.handle({ type: 'executeAPIInBackground', endpointId: 'gone' });
        expect(e.events).to.deep.equal(['run ep-carriers', 'error Run API failed: Endpoint gone not found']);
    });

    it('deletes after the destructive confirm and closes the editor', async () => {
        const endpoints = memoryEndpoints([CARRIERS]);
        const e = editor(endpoints, { itemId: 'ep-carriers' });
        await e.controller.handle({ type: 'confirmDeleteEndpoint', endpointId: 'ep-carriers', endpointName: 'List Carriers', transactionCount: 0 });
        expect(endpoints.all.size).to.equal(0);
        expect(e.posted).to.deep.equal([{ type: 'endpointDeleted', endpointId: 'ep-carriers' }]);
        expect(e.events).to.deep.equal(['close']);
    });

    it('reports the active environment with its variables', async () => {
        const e = editor(memoryEndpoints());
        await e.controller.handle({ type: 'getCurrentEnvironment' });
        const env = (e.posted[0] as { environment: Record<string, unknown> }).environment;
        expect(env).to.include({ id: 'env-pg', baseUrl: ACTIVE.baseUrl });
        expect(env).not.to.have.property('currentOrg');
        expect(env.variables).to.deep.equal({ org: 'ACME' });
    });

    it('pastes a shared endpoint into a pristine draft, and plain text back as text', async () => {
        const shared = '// Name: Ping\n// Method: GET\n// Path: /ping\n';
        const e = editor(memoryEndpoints());
        await e.controller.handle({ type: 'pasteEndpointText', text: shared, pristineDraft: true, isNewEndpoint: true });
        await e.controller.handle({ type: 'pasteEndpointText', text: 'hello', pristineDraft: true, isNewEndpoint: true });
        expect(e.posted[0]).to.include({ type: 'pastedEndpointData' });
        expect(e.posted[1]).to.deep.equal({ type: 'insertPastedText', text: 'hello' });
    });

    it('asks before a shared endpoint replaces a form with content', async () => {
        const e = editor(memoryEndpoints());
        const done = e.controller.handle({ type: 'pasteEndpointText', text: '// Name: Ping\n// Method: GET\n// Path: /ping\n', pristineDraft: false, isNewEndpoint: false });
        await tick();
        const request = e.posted[0] as { type: string; requestId: string };
        expect(request.type).to.equal('dbmnModalRequest');
        await e.session.handleShared({ type: 'dbmnModalResult', requestId: request.requestId, result: { actionId: 'endpoint', fields: {} } });
        await done;
        expect(e.posted[1]).to.include({ type: 'pastedEndpointData' });
    });

    it('sends missing ENV variables to the environment editor', async () => {
        const e = editor(memoryEndpoints());
        const done = e.controller.handle({ type: 'confirmAddMissingEnvVariables', missingVariables: ['token'], environmentName: 'Training Ground' });
        await tick();
        const request = e.posted[0] as { requestId: string };
        await e.session.handleShared({ type: 'dbmnModalResult', requestId: request.requestId, result: { actionId: 'add', fields: {} } });
        await done;
        expect(e.posted[1]).to.include({ type: 'envVariablesAdded', success: true });
        expect(e.events).to.deep.equal(['env env-pg token', 'info Please set the value(s) for: token']);
    });

    it('says plainly when the host has no test sandbox', async () => {
        const e = editor(memoryEndpoints());
        await e.controller.handle({ type: 'validateTests', testConfigs: [{ name: 't', script: 'x', enabled: true }] });
        expect(e.posted[0]).to.deep.equal({ type: 'testValidationResults', results: [{ name: 't', validation: { isValid: false, error: 'Test scripts run in DBMN for VS Code for now.' } }] });
    });

    it('builds the Create Template workbook from every variable, typed', async () => {
        const ep = { ...CARRIERS, path: '/carriers/{{code}}', body: '{"qty": {{qty:number}}, "on": "{{day:date:dd/MM/yyyy}}", "env": "{{ENV:org}}"}' } as APIEndpointConfig;
        expect(endpointTemplateVariables(ep).map(v => `${v.name}:${v.columnType}`)).to.deep.equal(['qty:number', 'day:date', 'code:string']);
        let saved: Uint8Array | undefined;
        const e = editor(memoryEndpoints([ep]), {}, { saveFile: async (name, bytes) => { saved = bytes; return name; } });
        await e.controller.handle({ type: 'createTemplateSave', endpointId: 'ep-carriers' });
        expect(e.posted[0]).to.deep.equal({ type: 'templateSaveComplete', fileName: 'List_Carriers-template.xlsx' });
        const rows = XLSX.utils.sheet_to_json<string[]>(XLSX.read(saved!, { type: 'array' }).Sheets.Template, { header: 1 });
        expect(rows).to.deep.equal([['qty', 'day', 'code'], [123, '15/01/2026', 'sample']]);
    });
});

describe('Endpoint editor: tags in use (#432)', () => {
    const tagged = (id: string, tags: string[]) => ({ ...CARRIERS, id, tags } as unknown as APIEndpointConfig);

    it('most used first, then A to Z; an endpoint counts a tag once', () => {
        expect(tagsInUse([
            { tags: ['smoke', 'orders'] }, { tags: ['orders', 'orders'] }, { tags: ['billing'] }, { tags: [] }, {}
        ])).to.deep.equal(['orders', 'billing', 'smoke']);
    });

    it('the editor gets them when it opens, and again after a save brings a new one', async () => {
        const records = memoryEndpoints([tagged('ep-1', ['orders']), tagged('ep-2', ['orders', 'smoke'])]);
        const withList = { ...records, getAllEndpoints: async () => Array.from(records.all.values()) };
        const e = editor(withList, { itemId: 'ep-1' });
        await e.controller.handle({ type: 'ready' });
        expect(e.posted.filter(m => m.type === 'tagsList')).to.deep.equal([{ type: 'tagsList', tags: ['orders', 'smoke'] }]);

        e.posted.length = 0;
        await e.controller.handle({ type: 'saveEndpoint', endpoint: { ...tagged('ep-1', ['orders', 'billing']) } });
        const saved = e.posted.findIndex(m => m.type === 'endpointSaved');
        const tags = e.posted.findIndex(m => m.type === 'tagsList');
        expect(saved, JSON.stringify(e.posted.map(m => m.type))).to.be.greaterThan(-1);
        expect(tags, 'after endpointSaved').to.be.greaterThan(saved);
        expect(e.posted[tags]).to.deep.equal({ type: 'tagsList', tags: ['orders', 'billing', 'smoke'] });
    });

    // Found 2026-11-11 writing the web test: an editor already open never heard of a tag saved in
    // another one. The tags field asks again each time it gets focus.
    it('asked again (the tags field got focus), it sends the tags in use now, a tag saved elsewhere included', async () => {
        const records = memoryEndpoints([tagged('ep-1', ['orders']), tagged('ep-2', ['smoke'])]);
        const withList = { ...records, getAllEndpoints: async () => Array.from(records.all.values()) };
        const e = editor(withList, { itemId: 'ep-1' });
        await e.controller.handle({ type: 'ready' });
        records.all.set('ep-2', tagged('ep-2', ['smoke', 'billing'])); // saved in another editor
        e.posted.length = 0;
        await e.controller.handle({ type: 'getTagsList' });
        expect(e.posted).to.deep.equal([{ type: 'tagsList', tags: ['billing', 'orders', 'smoke'] }]);
    });
});
