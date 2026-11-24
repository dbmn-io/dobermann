// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/** The Hub's host logic with the real catalogue managers in memory: what both hosts run. */
import { expect } from 'chai';
import { APIEndpointManager } from '../../../apiEndpointManager';
import { EnvironmentManager } from '../../../environmentManager';
import { SystemManager } from '../../../systemManager';
import { MemoryKeyValueStore } from '../../../platform/memory/memory-key-value-store';
import { memoryStoreContext } from '../../../platform/memory/memory-store-context';
import { catalogueStorageInfo, SAVE_CATALOGUE_PROMPT, WHAT_STAYS_HERE, webCatalogueStorageInfo, type CatalogueStorageInfo } from '../../../services/catalogue/catalogue-location';
import { HubPreferencesService } from '../../../services/hub-preferences/hub-preferences.service';
import { RecentEndpointsService } from '../../../services/recent-endpoints/recent-endpoints.service';
import { HubController } from '../../../screens/hub/hub.controller';
import { HubPorts, HubTab, TabChannel } from '../../../screens/hub/hub.ports';
import { ScreenSession } from '../../../screens/screen-session';

type Message = Record<string, unknown>;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function hub(overrides: Partial<HubPorts> = {}) {
    const context = memoryStoreContext();
    const endpoints = new APIEndpointManager(context);
    const environments = new EnvironmentManager(context);
    const systems = new SystemManager(context);
    const posted: Message[] = [];
    const events: string[] = [];
    const tabs: Record<string, { channel: TabChannel; handled: Message[]; disposed: boolean }> = {};
    const settings = new Map<string, unknown>();
    const session = new ScreenSession({ post: m => posted.push(m) }, { openExternal: () => undefined });
    const tab = (kind: string) => async (config: Record<string, unknown>, channel: TabChannel): Promise<HubTab> => {
        const record = { channel, handled: [] as Message[], disposed: false };
        tabs[channel.tabId] = record;
        return {
            html: `<p>${kind} ${JSON.stringify(config)}</p>`,
            handle: async m => { record.handled.push(m); },
            dispose: () => { record.disposed = true; }
        };
    };
    const ports: HubPorts = {
        endpoints, environments, systems,
        recent: new RecentEndpointsService(new MemoryKeyValueStore()),
        preferences: new HubPreferencesService(new MemoryKeyValueStore()),
        settings: {
            get: <T>(_s: string, key: string, d: T) => (settings.has(key) ? settings.get(key) : d) as T,
            update: async (_s, key, value) => { settings.set(key, value); }
        },
        auth: { isSignedIn: () => true, promptSignIn: async () => { events.push('sign in'); } },
        confirmDestructive: async () => true,
        toast: { info: m => events.push(`info ${m}`), warn: m => events.push(`warn ${m}`), error: m => events.push(`error ${m}`) },
        tabs: { endpoint: tab('endpoint'), environment: tab('environment') },
        runApi: async ep => { events.push(`run ${ep.name}`); },
        ...overrides
    };
    const controller = new HubController(session, ports);
    const of = (type: string) => posted.filter(m => m.type === type);
    return { controller, session, posted, events, tabs, of, endpoints, environments, systems, settings };
}

describe('HubController', () => {
    // GitHub Issue #396: a DBMN session that can no longer refresh looked exactly like a
    // healthy one. The state says so, and the header shows "DBMN sign-in expired".
    it('tells the page when the DBMN sign-in has expired, and only then', async () => {
        const expired = hub({ auth: { isSignedIn: () => true, sessionExpired: () => true, promptSignIn: async () => undefined } });
        await expired.controller.handle({ type: 'ready' });
        expect(expired.of('hubState')[0]).to.include({ isSignedIn: true, dbmnSessionExpired: true });

        const healthy = hub();
        await healthy.controller.handle({ type: 'ready' });
        expect(healthy.of('hubState')[0]).to.include({ isSignedIn: true, dbmnSessionExpired: false });

        const signedOut = hub({ auth: { isSignedIn: () => false, sessionExpired: () => true, promptSignIn: async () => undefined } });
        await signedOut.controller.handle({ type: 'ready' });
        expect(signedOut.of('hubState')[0], 'signed out is its own state').to.include({ isSignedIn: false, dbmnSessionExpired: false });
    });

    it('sends the whole state on ready, and again when the catalogue changes', async () => {
        const h = hub();
        await h.controller.handle({ type: 'ready' });
        expect(h.of('hubState')).to.have.length(1);
        expect(h.of('hubState')[0]).to.include({ isSignedIn: true });
        await h.endpoints.addEndpoint({ name: 'Get Carriers', method: 'GET', path: '/reference/carriers' });
        await tick();
        const last = h.of('hubState').pop() as { endpoints: Array<{ name: string }> };
        expect(last.endpoints.map(e => e.name)).to.deep.equal(['Get Carriers']);
    });

    it('says where the catalogue lives, and saves one kept on this computer to the account when asked (#342)', async () => {
        let where: 'account' | 'device' = 'device';
        const h = hub({ catalogueStorage: { info: () => catalogueStorageInfo(where), saveToAccount: async () => { where = 'account'; } } });
        await h.controller.handle({ type: 'ready' });
        const kept = h.of('hubState').pop()!.catalogueStorage as CatalogueStorageInfo;
        expect(kept).to.include({ where: 'device', label: 'On this computer only', saveLabel: 'Save to my account…' });
        expect(kept.home?.title).to.equal('Your endpoints are only on this computer');
        // What never leaves the machine, wherever saving is offered
        expect(kept.help).to.include(WHAT_STAYS_HERE);

        await h.controller.handle({ type: 'saveCatalogueToAccount' });
        const saved = h.of('hubState').pop()!.catalogueStorage as CatalogueStorageInfo;
        expect(saved).to.include({ where: 'account', label: 'In your DBMN account' });
        expect(saved.saveLabel, 'nothing left to save').to.equal(undefined);
        expect(saved.home, 'no card on Home').to.equal(undefined);
        expect(saved.help).to.include(WHAT_STAYS_HERE);

        // Signed out (or a host without the choice): the row is hidden
        const none = hub();
        await none.controller.handle({ type: 'ready' });
        expect(none.of('hubState')[0].catalogueStorage).to.equal(null);
    });

    it('the web app tells a VS Code user whose catalogue is still on their computer where to save it, and nobody else (#342)', () => {
        const now = Date.parse('2026-10-29T10:00:00Z');
        const yesterday = ['2026-10-28T09:00:00Z'];
        const told = webCatalogueStorageInfo({ seenAt: yesterday, saved: false }, now);
        expect(told).to.include({ where: 'account', label: 'In your DBMN account' });
        expect(told.home?.title).to.equal('Your endpoints from VS Code aren\'t here yet');
        expect(told.home?.text).to.include('Settings → Endpoints → Save to my account…');
        expect(told.home?.button, 'nothing to click here: the save happens in VS Code').to.equal(undefined);
        expect(told.saveLabel, 'and nothing for Settings to offer').to.equal(undefined);
        expect(webCatalogueStorageInfo({ seenAt: yesterday, saved: true }, now).home, 'saved already (or VS Code had nothing)').to.equal(undefined);
        expect(webCatalogueStorageInfo({ seenAt: [], saved: false }, now).home, 'never signed in from VS Code').to.equal(undefined);
        expect(webCatalogueStorageInfo({ seenAt: ['2026-09-01T00:00:00Z'], saved: false }, now).home, 'not seen for a month').to.equal(undefined);
    });

    it('the question at first sign-in is short: why save, what never leaves the machine, both choices (#342)', () => {
        expect(SAVE_CATALOGUE_PROMPT.title).to.equal('Save your endpoints and environments to your DBMN account?');
        expect(SAVE_CATALOGUE_PROMPT.actions.map(action => action.label)).to.deep.equal(['Keep on this computer', 'Save to my account…']);
        expect(SAVE_CATALOGUE_PROMPT.body).to.equal(
            'Your endpoints and environments are backed up for you, and there on any computer you sign in on.\n\n'
            + 'Secrets entered into Environments are never saved to dbmn.io. All data sent to/from your environments stays on this machine.'
        );
    });

    it('a slow refresh never overwrites a newer one (#342: sign-out switching the catalogue)', async () => {
        let releaseFirst: (rows: never[]) => void = () => undefined;
        let holdNext = false;
        const executions = {
            metadata: {
                getAllTransactions: () => {
                    if (!holdNext) return Promise.resolve([]);
                    holdNext = false;
                    return new Promise<never[]>(resolve => { releaseFirst = resolve; });
                },
                onExecutionChanged: { event: () => ({ dispose: () => undefined }) }
            }
        } as unknown as HubPorts['executions'];
        const h = hub({ executions });
        await h.controller.handle({ type: 'ready' });
        holdNext = true;
        const first = h.controller.broadcastState();          // reads the catalogue as it was
        await h.endpoints.addEndpoint({ name: 'After the switch', method: 'GET', path: '/x' });
        await tick();                                         // the newer refresh posts first
        releaseFirst([]);
        await first;
        const last = h.of('hubState').pop() as { endpoints: Array<{ name: string }> };
        expect(last.endpoints.map(e => e.name)).to.deep.equal(['After the switch']);
    });

    // Found 2026-11-12 testing two resumed batches: the header said "2 paused" while one ran. The
    // list was sent 250 ms after the LAST change, and a running batch changes every few ms, so
    // nothing was sent until everything stopped. Now at most every 250 ms, while changes come.
    it('while a batch keeps changing, History and the header are refreshed as it runs, not only once it stops', async () => {
        let fire: () => void = () => undefined;
        const executions = {
            metadata: {
                getAllTransactions: async () => [],
                onExecutionChanged: { event: (listener: () => void) => { fire = listener; return { dispose: () => undefined }; } }
            }
        } as unknown as HubPorts['executions'];
        const h = hub({ executions });
        await h.controller.handle({ type: 'ready' });
        const before = h.of('hubState').length;
        const started = Date.now();
        while (Date.now() - started < 1200) {   // a change every 30 ms for 1.2 s
            fire();
            await new Promise(r => setTimeout(r, 30));
        }
        const during = h.of('hubState').length - before;
        expect(during, 'refreshed while the changes kept coming').to.be.at.least(3);
        await new Promise(r => setTimeout(r, 400));
        expect(h.of('hubState').length - before, 'and once after the last').to.be.greaterThan(during);
    });

    // Public issue 1: a batch's request changes nothing the Hub draws; the batch's own row (and any other run) does
    it('a batch\'s request does not refresh the Hub; a change to a run\'s own row still does', async () => {
        let fire: (execution: unknown) => void = () => undefined;
        const executions = {
            metadata: {
                getAllTransactions: async () => [],
                onExecutionChanged: { event: (listener: (execution: unknown) => void) => { fire = listener; return { dispose: () => undefined }; } }
            }
        } as unknown as HubPorts['executions'];
        const h = hub({ executions });
        await h.controller.handle({ type: 'ready' });
        const before = h.of('hubState').length;
        for (let i = 0; i < 20; i++) fire({ id: `m-${i}`, executionType: 'batch_member', batchId: 'b-1', status: 'completed' });
        await new Promise(r => setTimeout(r, 350));
        expect(h.of('hubState').length - before, 'no refresh for the requests').to.equal(0);
        fire({ id: 'b-1', executionType: 'batch', status: 'completed' });
        await new Promise(r => setTimeout(r, 350));
        expect(h.of('hubState').length - before, 'the batch finishing refreshes').to.equal(1);
    });

    it('#438: a run that ends in error turns its tab to the error status, as the Console footer does', async () => {
        let consoleChannel: TabChannel | undefined;
        const page = (): HubTab => ({ html: '<p>tab</p>', handle: async () => undefined, dispose: () => undefined });
        const h = hub({
            tabs: {
                endpoint: async () => page(),
                environment: async () => page(),
                console: async (_config, channel) => { consoleChannel = channel; return { ...page(), name: 'Get Products' }; }
            }
        });
        await h.controller.openConsoleTab('exec-1', false);
        const last = () => h.of('setTabStatus').at(-1) as { status?: string; progress?: { done: number; total: number } } | undefined;

        consoleChannel!.post({ type: 'status_update', payload: { status: 'running', progress: { completed: 0, total: 1 } } });
        expect(last()?.status).to.equal('running');
        consoleChannel!.post({ type: 'status_update', payload: { status: 'error', progress: { completed: 1, total: 1 } } });
        expect(last()).to.deep.include({ status: 'failed', progress: { done: 1, total: 1 } });

        // A finished batch with some members failed says so too
        await h.controller.openConsoleTab('exec-2', true);
        consoleChannel!.post({ type: 'status_update', payload: { status: 'partial', progress: { completed: 5, total: 5 } } });
        expect(last()?.status).to.equal('partial');
    });

    it('#464: a run renamed (on its Console, or anywhere) renames its open Console tab, and only that tab', async () => {
        let fire: (execution: unknown) => void = () => undefined;
        const executions = {
            metadata: {
                getAllTransactions: async () => [],
                onExecutionChanged: { event: (listener: (execution: unknown) => void) => { fire = listener; return { dispose: () => undefined }; } }
            }
        } as unknown as HubPorts['executions'];
        const page = (): HubTab => ({ html: '<p>tab</p>', handle: async () => undefined, dispose: () => undefined });
        const h = hub({ executions, tabs: { endpoint: async () => page(), environment: async () => page(), console: async () => ({ ...page(), name: 'Put stock' }) } });
        await h.controller.handle({ type: 'ready' });
        await h.controller.openConsoleTab('B', true);
        fire({ id: 'B', endpointName: 'Put stock', status: 'running' });
        expect(h.of('embeddedTabName'), 'the same name: nothing to say').to.have.length(0);
        fire({ id: 'B', endpointName: 'Put stock', batchConfiguration: { name: 'Monday stock' } });
        fire({ id: 'B', endpointName: 'Put stock', batchConfiguration: { name: 'Monday stock' } });
        fire({ id: 'm-1', endpointName: 'Put stock', batchConfiguration: { name: 'Someone else' } });
        expect(h.of('embeddedTabName')).to.deep.equal([{ type: 'embeddedTabName', tabId: 'console:B', name: 'Monday stock' }]);
    });

    it('#437: a batch starting on its own leaves an open Console where it is; asked for, it is brought forward', async () => {
        const page = (): HubTab => ({ html: '<p>tab</p>', handle: async () => undefined, dispose: () => undefined });
        const h = hub({ tabs: { endpoint: async () => page(), environment: async () => page(), console: async () => ({ ...page(), name: 'Batch B' }) } });
        await h.controller.openConsoleTab('B', true);
        expect(h.of('mountEmbeddedTab')).to.have.length(1);
        // The first batch stopped, so the queued one starts: the user stays on the tab they're on
        await h.controller.openConsoleTab('B', true, false);
        expect(h.of('focusEmbeddedTab'), 'not brought forward').to.have.length(0);
        await h.controller.openConsoleTab('B', true);
        expect(h.of('focusEmbeddedTab')[0]).to.include({ tabId: 'console:B' });
    });

    it('#470: a batch that starts takes its Run Batch tab\'s place: one tab, the Console in the same slot, Run Batch gone', async () => {
        const disposed: string[] = [];
        const page = (kind: string): HubTab => ({ html: `<p>${kind}</p>`, handle: async () => undefined, dispose: () => { disposed.push(kind); } });
        // What Review showed at Execute goes to the Console, so it opens on the same Requests, search, scroll and pick
        const review = { tab: 'requests' as const, search: 'WOOF', scrollTop: 240, selected: 7 };
        let carried: unknown;
        const h = hub({ tabs: {
            endpoint: async () => page('endpoint'), environment: async () => page('environment'),
            batch: async () => ({ ...page('batch'), handoff: () => review }),
            console: async () => ({ ...page('console'), name: 'Items 24 Nov', endpointId: endpoint.id, carryOn: (r: unknown) => { carried = r; } })
        } });
        const endpoint = await h.endpoints.addEndpoint({ name: 'Items', method: 'POST', path: '/items', body: '{"id":"{{id}}"}' });
        await h.controller.handle({ type: 'openBatchAsTab', endpointId: endpoint.id });
        expect(h.of('mountEmbeddedTab').map(m => m.tabId)).to.deep.equal([`batch:${endpoint.id}`]);

        // The engine opens the run's Console once the batch has really started (not brought forward: #437)
        await h.controller.openConsoleTab('B1', true, false);
        const mounted = h.of('mountEmbeddedTab').at(-1)!;
        expect(mounted).to.include({ tabId: 'console:B1', tabType: 'batchConsole', name: 'Items 24 Nov', replaces: `batch:${endpoint.id}` });
        // The page swaps in place: no separate close of the Run Batch tab (that would drop its slot first)
        expect(h.of('closeEmbeddedTabFromHost'), 'no close: the page swaps').to.have.length(0);
        expect(disposed, 'the Run Batch screen is disposed').to.deep.equal(['batch']);
        expect(carried, 'the Console opens where Review was').to.deep.equal(review);

        // No way back: Run Batch for that endpoint again is a fresh one, a new tab, not the old screen
        await h.controller.handle({ type: 'openBatchAsTab', endpointId: endpoint.id });
        expect(h.of('mountEmbeddedTab').at(-1)).to.include({ tabId: `batch:${endpoint.id}`, tabType: 'batch' });
        expect(h.of('mountEmbeddedTab').at(-1)).to.not.have.property('replaces');
    });

    it('#470: a Console with no Run Batch tab open for its endpoint opens as its own tab, as before', async () => {
        const page = (): HubTab => ({ html: '<p>tab</p>', handle: async () => undefined, dispose: () => undefined });
        const h = hub({ tabs: { endpoint: async () => page(), environment: async () => page(), console: async () => ({ ...page(), name: 'Run', endpointId: 'ep-gone' }) } });
        await h.controller.openConsoleTab('B2', true, false);
        expect(h.of('mountEmbeddedTab')).to.have.length(1);
        expect(h.of('mountEmbeddedTab')[0]).to.not.have.property('replaces');
    });

    it('History: Resume asks what the Console\'s Resume asks, and resumes with the answer (#335)', async () => {
        const resumed: unknown[] = [];
        const executions = {
            metadata: {
                getAllTransactions: async () => [],
                onExecutionChanged: { event: () => ({ dispose: () => undefined }) },
                getExecution: async () => ({ id: 'B', status: 'cancelled', batchConfiguration: { stopOnFirstError: true } }),
                getBatchMemberExecutions: async () => [{ status: 'completed' }, { status: 'error' }, { status: 'cancelled' }, { status: 'cancelled' }]
            },
            resume: async (id: string, choice: unknown) => { resumed.push([id, choice]); }
        } as unknown as HubPorts['executions'];
        const h = hub({ executions });
        const answer = async (actionId: string, fields: Record<string, string>) => {
            while (!h.of('dbmnModalRequest').length) await tick();
            const request = h.of('dbmnModalRequest').pop() as { requestId: string; spec: { title: string; fields: Array<{ id: string; label: string; value: string }> } };
            h.posted.length = 0;
            await h.session.handleShared({ type: 'dbmnModalResult', requestId: request.requestId, result: { actionId, fields } });
            return request.spec;
        };
        const resume = () => h.controller.handle({ type: 'transactionAction', action: 'resume', id: 'B', isBatch: true, status: 'cancelled' });

        let done = resume();
        await answer('cancel', {});
        await done;
        expect(resumed, 'closed: not resumed').to.deep.equal([]);

        done = resume();
        const spec = await answer('resume', { errorMode: 'stop', retryFailed: 'no', retryCutOff: 'yes' });
        await done;
        await tick();
        expect(spec.title).to.equal('Resume Batch');
        expect(spec.fields.map(f => [f.id, f.label, f.value])).to.deep.equal([
            ['errorMode', 'On error', 'stop'],
            ['retryFailed', 'Failed transactions', 'no'],
            ['retryCutOff', 'Cut-off transactions', 'yes']
        ]);
        expect(resumed).to.deep.equal([['B', { stopOnFirstError: true, retryFailed: false, retryCutOff: true }]]);
    });

    it('History: Cancel on a running batch asks first (#335); Pause instead pauses; paused, it cancels without asking', async () => {
        const calls: string[] = [];
        const executions = {
            metadata: { getAllTransactions: async () => [], onExecutionChanged: { event: () => ({ dispose: () => undefined }) } },
            pause: async (id: string) => { calls.push(`pause ${id}`); },
            cancel: async (id: string) => { calls.push(`cancel ${id}`); }
        } as unknown as HubPorts['executions'];
        const h = hub({ executions });
        const answer = async (actionId: string) => {
            while (!h.of('dbmnModalRequest').length) await tick();
            const request = h.of('dbmnModalRequest').pop() as { requestId: string; spec: { title: string; actions: Array<{ label: string }> } };
            h.posted.length = 0;
            await h.session.handleShared({ type: 'dbmnModalResult', requestId: request.requestId, result: { actionId, fields: {} } });
            return request.spec;
        };
        const cancel = (status: string) => h.controller.handle({ type: 'transactionAction', action: 'cancel', id: 'B', isBatch: true, status });

        let done = cancel('running');
        const spec = await answer('keep');
        await done;
        expect(spec.title).to.equal('Cancel this batch?');
        expect(spec.actions.map(a => a.label)).to.deep.equal(['Keep running', 'Pause instead', 'Cancel batch']);
        expect(calls, 'Keep running').to.deep.equal([]);

        done = cancel('running');
        await answer('pause');
        await done;
        done = cancel('running');
        await answer('cancel');
        await done;
        expect(calls).to.deep.equal(['pause B', 'cancel B']);

        await cancel('paused');
        expect(h.of('dbmnModalRequest'), 'nothing in flight: no question').to.have.length(0);
        expect(calls.pop()).to.equal('cancel B');
    });

    it('New Endpoint from Clipboard: mounts a draft tab and pastes once its page is listening', async () => {
        const h = hub();
        await h.controller.handle({ type: 'addEndpoint', fromClipboard: true });
        const mount = h.of('mountEmbeddedTab')[0] as { tabId: string; name: string; html: string };
        expect(mount.name).to.equal('New Endpoint');
        expect(mount.tabId).to.match(/^endpoint:new-/);
        await h.controller.handle({ type: '__embeddedFromTab__', tabId: mount.tabId, payload: { type: '__embeddedReady__' } });
        expect(h.tabs[mount.tabId].handled).to.deep.equal([{ type: 'pasteEndpointFromClipboard' }]);
    });

    it('routes a tab\'s messages to its screen, and its screen\'s messages into the tab', async () => {
        const h = hub();
        await h.controller.openEnvironmentTab(undefined);
        const tabId = (h.of('mountEmbeddedTab')[0] as { tabId: string }).tabId;
        await h.controller.handle({ type: '__embeddedFromTab__', tabId, payload: { type: 'saveEnvironment', environment: {} } });
        expect(h.tabs[tabId].handled).to.deep.equal([{ type: 'saveEnvironment', environment: {} }]);
        h.tabs[tabId].channel.post({ type: 'environmentSaved' });
        expect(h.posted.pop()).to.deep.equal({ type: '__embeddedToTab__', tabId, payload: { type: 'environmentSaved' } });
    });

    // A new environment's tab keeps its draft id once saved: the Hub is told which it holds, so
    // Rename in the list knows it is open there (with changes not saved, it waits for them)
    it('a new environment\'s tab, saved, tells the Hub which environment it now holds', async () => {
        const h = hub();
        await h.controller.openEnvironmentTab(undefined);
        const tabId = (h.of('mountEmbeddedTab')[0] as { tabId: string }).tabId;
        expect(tabId).to.match(/^environment:new-/);
        const env = await h.environments.addEnvironment({ name: 'Puppy School', baseUrl: 'http://127.0.0.1:54321/functions/v1/playground' });
        h.tabs[tabId].channel.post({ type: 'environmentSaved', environment: { id: env.id } });
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(h.of('embeddedTabName').at(-1)).to.deep.include({ tabId, name: 'Puppy School', savedId: env.id });
    });

    it('a page\'s close control inside a tab closes the tab (tabs are always full width, #349)', async () => {
        const h = hub();
        await h.controller.openEnvironmentTab(undefined);
        const tabId = (h.of('mountEmbeddedTab')[0] as { tabId: string }).tabId;
        await h.controller.handle({ type: '__embeddedFromTab__', tabId, payload: { type: 'closeWebview' } });
        expect(h.of('closeEmbeddedTabFromHost')).to.deep.equal([{ type: 'closeEmbeddedTabFromHost', tabId }]);
        expect(h.tabs[tabId].disposed).to.equal(true);
    });

    // #415: Add Environment asks for the System first, then the URL; the editor opens with both
    it('Add Environment asks for the System and URL first, then opens the editor with them', async () => {
        const h = hub();
        h.systems.setGlobalSystems({
            getAll: () => [{ id: 'samplewms', name: 'samplewms', scope: 'global', createdAt: 0, config: { match: '\\.samplewms\\.test$' } }],
            onChanged: () => ({ dispose: () => undefined })
        });
        const adding = h.controller.handle({ type: 'addEnvironment' });
        await tick();
        const request = h.of('dbmnModalRequest')[0] as { requestId: string; spec: { title: string } };
        expect(request.spec.title).to.equal('New environment');
        expect(h.of('mountEmbeddedTab'), 'no editor before the dialog').to.have.length(0);
        const fields = { system: '', baseUrl: 'https://acme.samplewms.test' };
        await h.session.handleShared({ type: 'dbmnModalActionPending', requestId: request.requestId, submitId: 's1', actionId: 'continue', fields });
        await tick();
        expect(h.of('dbmnModalActionResult')[0]).to.include({ success: true });
        await h.session.handleShared({ type: 'dbmnModalResult', requestId: request.requestId, result: { actionId: 'continue', fields } });
        await adding;
        const mount = h.of('mountEmbeddedTab')[0] as { html: string; name: string };
        expect(mount.name).to.equal('New Environment');
        expect(mount.html).to.include('"draft":{"systemId":"samplewms","baseUrl":"https://acme.samplewms.test","name":"samplewms: acme"}');
    });

    it('Add Environment with a URL an environment already has: moved to the chosen System, and opened', async () => {
        const h = hub();
        const erp = await h.systems.addSystem({ name: 'erp' });
        const wms = await h.systems.addSystem({ name: 'wms' });
        const existing = await h.environments.addEnvironment({ name: 'acme-dev', baseUrl: 'https://acme.example.com/', systemId: erp.id });
        const adding = h.controller.handle({ type: 'addEnvironment' });
        await tick();
        const request = h.of('dbmnModalRequest')[0] as { requestId: string };
        const fields = { system: wms.id, baseUrl: 'https://ACME.example.com' };
        await h.session.handleShared({ type: 'dbmnModalActionPending', requestId: request.requestId, submitId: 's1', actionId: 'continue', fields });
        await tick();
        await h.session.handleShared({ type: 'dbmnModalResult', requestId: request.requestId, result: { actionId: 'continue', fields } });
        await tick();
        const warning = h.of('dbmnModalRequest')[1] as { requestId: string; spec: { title: string; body: string } };
        expect(warning.spec.title).to.equal('This URL already has an environment');
        expect(warning.spec.body).to.equal('"acme-dev" already uses this URL, under erp. You chose wms. Move it to wms, open it as it is, or add a new one for this URL.');
        await h.session.handleShared({ type: 'dbmnModalResult', requestId: warning.requestId, result: { actionId: 'move', fields: {} } });
        await adding;
        expect((await h.environments.getEnvironment(existing.id))?.systemId).to.equal(wms.id);
        const mount = h.of('mountEmbeddedTab')[0] as { refId: string; name: string };
        expect(mount).to.include({ refId: existing.id, name: 'acme-dev' });
    });

    it('Add Environment cancelled opens nothing', async () => {
        const h = hub();
        const adding = h.controller.handle({ type: 'addEnvironment' });
        await tick();
        const { requestId } = h.of('dbmnModalRequest')[0] as { requestId: string };
        await h.session.handleShared({ type: 'dbmnModalResult', requestId, result: { actionId: 'cancel', fields: {} } });
        await adding;
        expect(h.of('mountEmbeddedTab')).to.have.length(0);
    });

    it('a saved draft is found again: the catalogue focuses its tab instead of opening another', async () => {
        const h = hub();
        await h.controller.handle({ type: 'addEndpoint' });
        const draft = (h.of('mountEmbeddedTab')[0] as { tabId: string }).tabId;
        const saved = await h.endpoints.addEndpoint({ name: 'Ping', method: 'GET', path: '/ping' });
        h.tabs[draft].channel.post({ type: 'endpointSaved', endpoint: saved });
        await h.controller.handle({ type: 'openEndpointAsTab', endpointId: saved.id });
        expect(h.of('mountEmbeddedTab')).to.have.length(1);
        expect(h.of('focusEmbeddedTab')[0]).to.include({ tabId: draft, refId: draft.slice('endpoint:'.length), name: 'Ping' });
    });

    it('a deleted endpoint closes its own tab', async () => {
        const h = hub();
        const ep = await h.endpoints.addEndpoint({ name: 'Ping', method: 'GET', path: '/ping' });
        await h.controller.handle({ type: 'openEndpointAsTab', endpointId: ep.id });
        const tabId = `endpoint:${ep.id}`;
        h.tabs[tabId].channel.post({ type: 'endpointDeleted', endpointId: ep.id });
        expect(h.of('closeEmbeddedTabFromHost')).to.deep.equal([{ type: 'closeEmbeddedTabFromHost', tabId }]);
        expect(h.tabs[tabId].disposed).to.equal(true);
    });

    it('switches the active environment', async () => {
        const h = hub();
        const env = await h.environments.addEnvironment({ name: 'Puppy School', baseUrl: 'http://127.0.0.1:54321/functions/v1/playground' });
        await h.controller.handle({ type: 'setActiveEnvironment', environmentId: env.id });
        expect((await h.environments.getActiveEnvironment())?.id).to.equal(env.id);
        expect(h.of('hubState').pop()).to.include({ activeEnvironmentId: env.id });
    });

    it('runs from the catalogue row', async () => {
        const h = hub();
        const ep = await h.endpoints.addEndpoint({ name: 'Get Carriers', method: 'GET', path: '/reference/carriers' });
        await h.controller.handle({ type: 'runEndpoint', endpointId: ep.id });
        expect(h.events).to.deep.equal(['run Get Carriers']);
        expect(h.of('swapResult')).to.deep.equal([{ type: 'swapResult', ok: true, endpointId: ep.id }]);
    });

    it('creates a System from the Hub\'s modal', async () => {
        const h = hub();
        const done = h.controller.handle({ type: 'createSystem' });
        await tick();
        const request = h.of('dbmnModalRequest')[0] as { requestId: string };
        await h.session.handleShared({ type: 'dbmnModalActionPending', requestId: request.requestId, actionId: 'create', submitId: 's', fields: { name: 'dbmn' } });
        // As the screen does: close the modal only once the host's submit has succeeded
        while (!h.of('dbmnModalActionResult').length) await tick();
        expect(h.of('dbmnModalActionResult')[0]).to.include({ success: true });
        await h.session.handleShared({ type: 'dbmnModalResult', requestId: request.requestId, result: { actionId: 'create', fields: { name: 'dbmn' } } });
        await done;
        expect((await h.systems.getAllSystems()).map(s => s.name)).to.deep.equal(['dbmn']);
        expect(h.of('systemCreated')).to.have.length(1);
    });

    it('writes only the settings the Hub shows, coerced', async () => {
        const h = hub();
        await h.controller.handle({ type: 'setDbmnSetting', key: 'execution.maxCsvRows', value: '250.7' });
        await h.controller.handle({ type: 'setDbmnSetting', key: 'execution.criticalErrorCodes', value: [401, 'x', 99, 503] });
        await h.controller.handle({ type: 'setDbmnSetting', key: 'anything.else', value: true });
        expect([...h.settings.entries()]).to.deep.equal([['execution.maxCsvRows', 250], ['execution.criticalErrorCodes', [401, 503]]]);
    });

    it('signed out, Run Batch opens like anything else: no sign-in is needed to run (#418)', async () => {
        let asked = false;
        const h = hub({ auth: { isSignedIn: () => false, promptSignIn: async () => { asked = true; } } });
        const endpoint = await h.endpoints.addEndpoint({ name: 'Items', method: 'POST', path: '/items', body: '{"id":"{{id}}"}' });
        const batch = async (config: Record<string, unknown>, channel: TabChannel): Promise<HubTab> => ({ html: `<p>batch ${JSON.stringify(config)}</p>`, handle: async () => undefined, dispose: () => undefined });
        (h.controller as unknown as { ports: HubPorts }).ports.tabs.batch = batch as never;
        await h.controller.handle({ type: 'openBatchAsTab', endpointId: endpoint.id });
        expect(asked).to.equal(false);
        expect(h.of('mountEmbeddedTab').map(m => m.tabType)).to.deep.equal(['batch']);
    });

    it('keeps the strip for next time; Home offers to re-open it, and Re-open restores it, skipping drafts (#348)', async () => {
        let saved: unknown;
        const h = hub({ tabSnapshots: { peek: () => undefined, take: () => undefined, save: async s => { saved = s; } } });
        const env = await h.environments.addEnvironment({ name: 'Local', baseUrl: 'http://127.0.0.1:1' });
        await h.controller.handle({ type: 'hubTabsSnapshot', tabs: [{ type: 'environment', refId: env.id, name: 'Local' }, { type: 'endpoint', refId: 'new-1' }], activeTabId: `environment:${env.id}` });
        await h.controller.pageClosed();
        expect(saved).to.deep.equal({ tabs: [{ type: 'environment', refId: env.id, name: 'Local' }, { type: 'endpoint', refId: 'new-1' }], activeTabId: `environment:${env.id}` });

        const again = hub({ environments: h.environments, tabSnapshots: { peek: () => saved as never, take: () => saved as never, save: async () => undefined } });
        await again.controller.handle({ type: 'ready' });
        expect(again.of('mountEmbeddedTab'), 'nothing reopens by itself').to.have.length(0);
        expect(again.of('hubHomeInfo')[0]).to.deep.include({ reopen: { count: 1, names: ['Local'] } });

        await again.controller.handle({ type: 'reopenTabs' });
        expect(again.of('mountEmbeddedTab').map(m => m.tabId)).to.deep.equal([`environment:${env.id}`]);
        expect(again.of('focusEmbeddedTab')[0]).to.include({ tabId: `environment:${env.id}` });
    });

    it('a session that never held a tab leaves last session\'s strip on offer (#348)', async () => {
        let saves = 0;
        const h = hub({ tabSnapshots: { peek: () => undefined, take: () => undefined, save: async () => { saves++; } } });
        await h.controller.handle({ type: 'hubTabsSnapshot', tabs: [], activeTabId: null });
        await h.controller.pageClosed();
        expect(saves).to.equal(0);
    });
});

describe('HubController: #424 header variables', () => {
    it('the header shows each variable the environment puts there, and the picker sets one', async () => {
        const h = hub();
        const env = await h.environments.addEnvironment({ name: 'BC Sandbox', baseUrl: 'https://api.businesscentral.example', variables: { company: '' },
            variableSettings: { company: { options: ['CRONUS', 'Contoso'], showInHeader: true } } });
        await h.controller.handle({ type: 'ready' });
        const state = h.of('hubState').pop() as { environments: Array<{ id: string; headerVariables: unknown }> };
        const shown = state.environments.find(e => e.id === env.id)!;
        expect(shown.headerVariables).to.deep.equal([{ name: 'company', value: '', options: ['CRONUS', 'Contoso'] }]);

        await h.controller.handle({ type: 'setEnvironmentVariable', environmentId: env.id, name: 'company', value: 'Contoso' });
        expect((await h.environments.getEnvironment(env.id))?.variables).to.deep.equal({ company: 'Contoso' });
        expect((await h.environments.getActiveEnvironment())?.id, 'picking a value activates the environment').to.equal(env.id);
        const after = h.of('hubState').pop() as { environments: Array<{ id: string; headerVariables: Array<{ value: string }> }> };
        expect(after.environments.find(e => e.id === env.id)!.headerVariables[0].value).to.equal('Contoso');
    });

    it('the header\'s Add asks for a value, adds it to the typed options and picks it', async () => {
        const h = hub();
        const env = await h.environments.addEnvironment({ name: 'BC Sandbox', baseUrl: 'https://api.businesscentral.example', variables: { company: 'CRONUS' },
            variableSettings: { company: { options: ['CRONUS'], showInHeader: true } } });
        const done = h.controller.handle({ type: 'addVariableOption', environmentId: env.id, name: 'company' });
        await tick();
        const request = h.of('dbmnModalRequest')[0] as { requestId: string; spec: { title: string } };
        expect(request.spec.title).to.equal('Add company');
        await h.session.handleShared({ type: 'dbmnModalResult', requestId: request.requestId, result: { actionId: 'add', fields: { value: ' Fabrikam ' } } });
        await done;
        const saved = await h.environments.getEnvironment(env.id);
        expect(saved?.variableSettings?.company?.options).to.deep.equal(['CRONUS', 'Fabrikam']);
        expect(saved?.variables).to.deep.equal({ company: 'Fabrikam' });
        expect((await h.environments.getActiveEnvironment())?.id).to.equal(env.id);
        const after = h.of('hubState').pop() as { environments: Array<{ id: string; headerVariables: Array<{ value: string; options: string[] }> }> };
        expect(after.environments.find(e => e.id === env.id)!.headerVariables[0]).to.include({ value: 'Fabrikam' });
    });

    it('an org is an ordinary variable: in the header only when the environment puts it there, options as typed', async () => {
        const h = hub();
        const plain = await h.environments.addEnvironment({ name: 'Plain', baseUrl: 'https://acme.samplewms.test', variables: { org: 'ACM-APAC-DEV' } });
        const shown = await h.environments.addEnvironment({ name: 'Shown', baseUrl: 'https://acme2.samplewms.test', variables: { org: 'ACM-APAC-DEV' },
            variableSettings: { org: { showInHeader: true } } });
        await h.controller.handle({ type: 'ready' });
        const state = h.of('hubState').pop() as { environments: Array<{ id: string; headerVariables: Array<{ name: string; value: string; options: string[] }> }> };
        expect(state.environments.find(e => e.id === plain.id)!.headerVariables, 'not put in the header: not there').to.deep.equal([]);
        expect(state.environments.find(e => e.id === shown.id)!.headerVariables).to.deep.equal([{ name: 'org', value: 'ACM-APAC-DEV', options: [] }]);

        // Add builds the list, as for any variable
        await h.environments.addVariableOption(shown.id, 'org', 'ACM-EU-DEV');
        const saved = await h.environments.getEnvironment(shown.id);
        expect(saved?.variableSettings?.org).to.deep.equal({ showInHeader: true, options: ['ACM-EU-DEV'] });
        expect(saved?.variables?.org).to.equal('ACM-EU-DEV');
    });
});

describe('HubController: a header pick is drawn at once (2026-11-13)', () => {
    // James, on the 0.4.0 build: adding an organisation from the header was "ridiculously slow…
    // it doesn't show any feedback". With the catalogue in the account, the save is a round trip
    // to the server, and the header waited for it (and for a rebuild of the whole Hub).
    function gated<T extends object>(target: T, method: keyof T) {
        let open!: () => void;
        const gate = new Promise<void>(resolve => { open = resolve; });
        const original = (target[method] as unknown as (...a: unknown[]) => Promise<unknown>).bind(target);
        (target as Record<keyof T, unknown>)[method] = async (...args: unknown[]) => { await gate; return original(...args); };
        return { open };
    }

    it('Add: the new option, its label and the pick are in the header before the save lands', async () => {
        const h = hub();
        const env = await h.environments.addEnvironment({ name: 'Sample Staging', baseUrl: 'https://staging.samplewms.test', variables: { org: 'ACM-APAC-DEV' },
            variableSettings: { org: { options: ['ACM-APAC-DEV'], showInHeader: true } } });
        await h.environments.setActiveEnvironment(env.id);
        const save = gated(h.environments, 'addVariableOption');
        const done = h.controller.handle({ type: 'addVariableOption', environmentId: env.id, name: 'org' });
        await tick();
        const request = h.of('dbmnModalRequest')[0] as { requestId: string };
        h.posted.length = 0;
        void h.session.handleShared({ type: 'dbmnModalResult', requestId: request.requestId, result: { actionId: 'add', fields: { value: '880-DEV', label: 'Brisbane' } } });
        await tick();

        const picked = h.of('headerVariablesPicked');
        expect(picked, 'drawn while the save is still going').to.deep.equal([{ type: 'headerVariablesPicked', environmentId: env.id,
            headerVariables: [{ name: 'org', value: '880-DEV', options: ['ACM-APAC-DEV', '880-DEV'], labels: { '880-DEV': 'Brisbane' } }] }]);
        expect(h.of('hubState'), 'the full state waits for the save').to.deep.equal([]);

        save.open();
        await done;
        const after = h.of('hubState').pop() as { environments: Array<{ id: string; headerVariables: unknown }> };
        expect(after.environments.find(e => e.id === env.id)!.headerVariables).to.deep.equal(picked[0].headerVariables);
    });

    it('picking an option: drawn at once too; a failed save says so and puts the header back', async () => {
        const h = hub();
        const env = await h.environments.addEnvironment({ name: 'Sample Staging', baseUrl: 'https://staging.samplewms.test', variables: { org: 'A' },
            variableSettings: { org: { options: ['A', 'B'], showInHeader: true } } });
        await h.environments.setActiveEnvironment(env.id);
        h.environments.setVariable = async () => { throw new Error('The account could not be reached'); };
        await h.controller.handle({ type: 'setEnvironmentVariable', environmentId: env.id, name: 'org', value: 'B' });
        const types = h.posted.map(m => m.type).filter(t => t !== '__embeddedToTab__');
        expect(types.slice(0, 1)).to.deep.equal(['headerVariablesPicked']);
        expect(h.of('setActiveEnvironmentError')).to.deep.equal([{ type: 'setActiveEnvironmentError', error: 'The account could not be reached' }]);
        const after = h.of('hubState').pop() as { environments: Array<{ id: string; headerVariables: Array<{ value: string }> }> };
        expect(after.environments.find(e => e.id === env.id)!.headerVariables[0].value, 'back to what is stored').to.equal('A');
    });

    // James, on 0.4.0 (2026-11-16): changing environment is "annoyingly SLOW", about 5 s the
    // first time, under 2 s after. The header waited for the save and a rebuild of the Hub.
    it('switching environment: drawn at once, before it is saved', async () => {
        const h = hub();
        const first = await h.environments.addEnvironment({ name: 'Sample Dev', baseUrl: 'https://dev.samplewms.test' });
        const second = await h.environments.addEnvironment({ name: 'Sample Prod', baseUrl: 'https://prod.samplewms.test', environmentType: 'production' });
        await h.environments.setActiveEnvironment(first.id);
        await h.controller.handle({ type: 'ready' });
        h.posted.length = 0;
        const save = gated(h.environments, 'setActiveEnvironment');
        const done = h.controller.handle({ type: 'setActiveEnvironment', environmentId: second.id });
        await tick();

        expect(h.of('activeEnvironmentPicked'), 'drawn while the save is still going').to.deep.equal([{ type: 'activeEnvironmentPicked', environmentId: second.id }]);
        expect(h.of('hubState'), 'the full state waits for the save').to.deep.equal([]);

        save.open();
        await done;
        expect(h.of('hubState').pop()).to.include({ activeEnvironmentId: second.id });
    });

    it('switching environment: a failed save says so and puts the header back', async () => {
        const h = hub();
        const first = await h.environments.addEnvironment({ name: 'Sample Dev', baseUrl: 'https://dev.samplewms.test' });
        const second = await h.environments.addEnvironment({ name: 'Sample Prod', baseUrl: 'https://prod.samplewms.test' });
        await h.environments.setActiveEnvironment(first.id);
        h.environments.setActiveEnvironment = async () => { throw new Error('Could not save'); };
        await h.controller.handle({ type: 'setActiveEnvironment', environmentId: second.id });
        expect(h.of('activeEnvironmentPicked')).to.have.length(1);
        expect(h.of('setActiveEnvironmentError')).to.deep.equal([{ type: 'setActiveEnvironmentError', error: 'Could not save' }]);
        expect(h.of('hubState').pop(), 'back to what is stored').to.include({ activeEnvironmentId: first.id });
    });

    it('History: the state carries the newest runs and how many there are; asked, every run comes', async () => {
        const runs = Array.from({ length: 1_200 }, (_, i) => ({ id: `run-${i}`, executionType: 'individual', status: 'completed', endpointName: `E${i}` }));
        const executions = {
            metadata: {
                getAllTransactions: async () => runs,
                getExecution: async () => null,
                onExecutionChanged: { event: () => ({ dispose: () => undefined }) }
            }
        } as unknown as HubPorts['executions'];
        const h = hub({ executions });
        await h.controller.handle({ type: 'ready' });
        await tick();
        const state = h.of('hubState').pop() as { transactions: unknown[]; transactionsTotal: number };
        expect(state.transactions).to.have.length(500);
        expect(state.transactionsTotal).to.equal(1_200);
        await h.controller.handle({ type: 'historyAll' });
        const all = h.of('historyAll').pop() as { transactions: Array<{ id: string }> };
        expect(all.transactions).to.have.length(1_200);
        expect(all.transactions[1_199].id).to.equal('run-1199');
    });

    it('An old saved compare is a query: listed as one, opened as one on Views (a reopened tab too), its notice said once', async () => {
        const { saveCompare, getCompare } = await import('../../../services/compare/compare-store');
        const { listQueries } = await import('../../../services/query/query-store');
        const state = new MemoryKeyValueStore();
        const run = (n: number) => ({ kind: 'result' as const, endpointId: 'ep-1', view: 'Default', executionId: `run-${n}`, isBatch: false, environment: 'QA', executedAt: '2026-11-10T00:00:00Z' });
        await saveCompare(state, { id: 'cmp-old', name: 'Morning stock', sources: [run(0), run(1)], createdAt: '2026-11-10T00:00:00Z', setup: { keyColumns: ['sku'], compareColumns: ['qty'], relaxedColumns: ['qty'], join: 'full' } });
        const opened: Array<Record<string, unknown>> = [];
        const h = hub({
            compares: { state: () => state },
            tabs: {
                endpoint: async () => ({ html: '', handle: async () => undefined, dispose: () => undefined }),
                environment: async () => ({ html: '', handle: async () => undefined, dispose: () => undefined }),
                compare: async (config: Record<string, unknown>) => { opened.push(config); return { html: '<p>query</p>', handle: async () => undefined, dispose: () => undefined }; }
            }
        });
        await h.controller.handle({ type: 'ready' });
        // Listed: the query, not the old compare (which is kept)
        const listed = h.of('hubState').at(-1) as { compares: Array<{ id: string }>; queries: Array<{ id: string; name: string; fromCompare?: string }> };
        expect(listed.compares).to.deep.equal([]);
        const made = listed.queries.find(q => q.fromCompare === 'cmp-old')!;
        expect(made.name).to.equal('Morning stock');
        expect(getCompare(state, 'cmp-old')).to.not.equal(undefined);
        // Opened by its old id (the list's old link, a reopened tab): the query's tab, its notice said once
        await h.controller.handle({ type: 'openCompare', compareId: 'cmp-old' });
        expect(opened.map(o => o.compareId)).to.deep.equal([made.id]);
        expect(h.of('mountEmbeddedTab').at(-1)).to.include({ tabType: 'compare', refId: made.id });
        expect(h.events.filter(e => e.includes('Relaxed matching is gone'))).to.have.length(1);
        expect(listQueries(state).find(q => q.id === made.id)?.notice).to.equal(undefined);
        // Made once: opening again makes no second query
        await h.controller.handle({ type: 'openCompare', compareId: 'cmp-old' });
        expect(listQueries(state).filter(q => q.fromCompare === 'cmp-old')).to.have.length(1);
    });

    it('Rename from the Reporting list: a report not open is renamed by the same rules as its tab', async () => {
        const { createQuery, getQuery } = await import('../../../services/query/query-store');
        const state = new MemoryKeyValueStore();
        const h = hub({ compares: { state: () => state } });
        await h.controller.handle({ type: 'ready' });
        const first = await createQuery(state);
        const second = await createQuery(state);
        // Cleaned: one line, single spaces, trimmed
        await h.controller.handle({ type: 'renameReport', compareId: first.id, name: '  Stock\twith   products \n' });
        expect(getQuery(state, first.id)?.name).to.equal('Stock with products');
        // No two reports share a name: refused, said, and the name stays
        await h.controller.handle({ type: 'renameReport', compareId: second.id, name: 'stock WITH products' });
        expect(getQuery(state, second.id)?.name).to.equal(second.name);
        expect(h.events.some(e => e.startsWith('warn ') && e.includes('already called'))).to.equal(true);
        // Too long: cut to the limit
        await h.controller.handle({ type: 'renameReport', compareId: second.id, name: 'x'.repeat(50) });
        expect(getQuery(state, second.id)?.name).to.equal('x'.repeat(30));
        // The list hears the new names
        expect(h.of('hubState').length).to.be.greaterThan(1);
    });

    it('Lookup tables on the Reporting list: new opens its tab, listed with the queries, renamed, copied, deleted', async () => {
        const { LookupTablesStore } = await import('../../../services/lookup-tables/lookup-tables');
        const state = new MemoryKeyValueStore();
        const opened: Array<Record<string, unknown>> = [];
        const h = hub({
            compares: { state: () => state },
            tabs: {
                endpoint: async () => ({ html: '', handle: async () => undefined, dispose: () => undefined }),
                environment: async () => ({ html: '', handle: async () => undefined, dispose: () => undefined }),
                lookup: async (config, channel) => {
                    opened.push({ ...config, tabId: channel.tabId });
                    return { html: '<p>lookup</p>', handle: async () => undefined, dispose: () => undefined, rename: async (name: string) => { await new LookupTablesStore(state).rename(String(config.id), name); } };
                }
            }
        });
        await h.controller.handle({ type: 'ready' });
        await h.controller.handle({ type: 'newLookup' });
        const store = new LookupTablesStore(state);
        const [made] = await store.list();
        expect(made.name).to.equal('Lookup table');
        expect(opened.map(o => o.tabId)).to.deep.equal([`lookup:${made.id}`]);
        expect(h.of('mountEmbeddedTab').at(-1)).to.include({ tabType: 'lookup', refId: made.id, name: 'Lookup table' });
        // The Hub's state lists it (its columns and how many rows), for the Reporting list
        const listed = (h.of('hubState').at(-1) as { lookupTables: Array<{ id: string; rows: number }> }).lookupTables;
        expect(listed.map(t => [t.id, t.rows])).to.deep.equal([[made.id, 0]]);
        // Open again: the same tab, focused; Query's lookup.open the same
        await h.controller.handle({ type: 'lookup.open', id: made.id });
        expect(opened).to.have.length(1);
        expect(h.of('focusEmbeddedTab').at(-1)).to.include({ tabId: `lookup:${made.id}` });
        // Renamed from the list while open: its screen keeps the name
        await h.controller.handle({ type: 'renameReport', compareId: made.id, name: 'Unit codes' });
        expect((await store.get(made.id))?.name).to.equal('Unit codes');
        // Duplicated: a copy, opened
        await h.controller.handle({ type: 'duplicateLookup', id: made.id });
        const copy = (await store.list()).find(t => t.id !== made.id)!;
        expect(copy.name).to.equal('Unit codes copy');
        expect(opened.map(o => o.tabId)).to.include(`lookup:${copy.id}`);
        // Delete, one or with the reports selected: gone, its tab closed
        await h.controller.handle({ type: 'deleteCompares', compareIds: [copy.id] });
        await h.controller.handle({ type: 'deleteLookup', id: made.id });
        expect(await store.list()).to.deep.equal([]);
        // A deleted table asked for: said so, no tab
        await h.controller.handle({ type: 'openLookup', id: made.id });
        expect(h.events.some(e => e === 'warn This lookup table has been deleted.')).to.equal(true);
    });

    it('Rename from the Hub\'s lists: endpoints and environments by their own rules; not over an open editor', async () => {
        const h = hub();
        await h.controller.handle({ type: 'ready' });
        const a = await h.endpoints.addEndpoint({ name: 'Get orders', method: 'GET', path: '/orders' } as never);
        const b = await h.endpoints.addEndpoint({ name: 'Get items', method: 'GET', path: '/items' } as never);
        await h.controller.handle({ type: 'renameEndpoint', endpointId: a.id, name: '  Get   open\torders ' });
        expect((await h.endpoints.getAllEndpoints()).find(e => e.id === a.id)?.name).to.equal('Get open orders');
        // Another endpoint's name: refused, said, kept
        await h.controller.handle({ type: 'renameEndpoint', endpointId: b.id, name: 'Get open orders' });
        expect((await h.endpoints.getAllEndpoints()).find(e => e.id === b.id)?.name).to.equal('Get items');
        expect(h.events.some(e => e.startsWith('warn ') && e.includes('already exists'))).to.equal(true);
        // Open in its editor (the list refuses first when it has changes not saved): renamed, and the editor told
        await h.controller.handle({ type: 'openEndpointAsTab', endpointId: b.id });
        await h.controller.handle({ type: 'renameEndpoint', endpointId: b.id, name: 'Get every item' });
        expect((await h.endpoints.getAllEndpoints()).find(e => e.id === b.id)?.name).to.equal('Get every item');
        expect(h.of('renamedOpen').at(-1)).to.include({ tabId: `endpoint:${b.id}`, name: 'Get every item' });

        const env = await h.environments.addEnvironment({ name: 'Test', baseUrl: 'https://test.example.com' } as never);
        await h.controller.handle({ type: 'renameEnvironment', environmentId: env.id, name: 'Test (Sydney)' });
        expect((await h.environments.getAllEnvironments()).find(e => e.id === env.id)?.name).to.equal('Test (Sydney)');
    });

    it('Logs: its rail item opens one tab; asked again with a search, that tab searches', async () => {
        const page = (): HubTab => ({ html: '<p>tab</p>', handle: async () => undefined, dispose: () => undefined });
        const searched: string[] = [];
        let built = 0;
        const h = hub({ tabs: { endpoint: async () => page(), environment: async () => page(), logs: async () => { built++; return { ...page(), search: (t: string) => { searched.push(t); } }; } } });
        await h.controller.handle({ type: 'openLogs' });
        await h.controller.handle({ type: 'openLogs', search: '@level=error' });
        expect(built).to.equal(1);
        expect(searched).to.deep.equal(['@level=error']);
        expect(h.of('mountEmbeddedTab').map(m => [m.tabType, m.name])).to.deep.equal([['logs', 'Logs']]);
    });

    // Measured 2026-11-16: reading the history takes ~70 ms for 3,000 runs and ~220 ms for 10,000
    // (sql.js, this laptop), and a switch read it twice: once for its own refresh and once for
    // the environments-changed event. A switch doesn't change the history.
    // The history is read once and kept by the app's one run list (DatabaseAdapter, run-list-cache.test.ts), not by
    // the Hub: every refresh asks for it (cheap while nothing changed), so a run or a delete shows at the next one
    it('History comes from the app\'s one run list on every refresh: a switch, a run changing, a delete', async () => {
        let reads = 0;
        let fire: () => void = () => undefined;
        const executions = {
            metadata: {
                getAllTransactions: async () => { reads++; return []; },
                getExecution: async () => null,
                deleteExecutions: async () => 1,
                onExecutionChanged: { event: (listener: () => void) => { fire = listener; return { dispose: () => undefined }; } }
            }
        } as unknown as HubPorts['executions'];
        const h = hub({ executions });
        h.settings.set('ui.confirmTransactionDeletion', false);
        const first = await h.environments.addEnvironment({ name: 'Sample Dev', baseUrl: 'https://dev.samplewms.test' });
        const second = await h.environments.addEnvironment({ name: 'Sample Prod', baseUrl: 'https://prod.samplewms.test' });
        await h.controller.handle({ type: 'ready' });
        await tick();
        const afterReady = reads;
        expect(afterReady, 'the page gets the history when it opens').to.be.greaterThan(0);

        await h.controller.handle({ type: 'setActiveEnvironment', environmentId: second.id });
        await h.controller.handle({ type: 'setActiveEnvironment', environmentId: first.id });
        await tick();
        expect(h.of('hubState').pop(), 'the page still gets its History').to.have.property('transactions');

        const beforeRun = reads;
        fire();                                              // a run changed
        await new Promise(r => setTimeout(r, 300));
        expect(reads, 'a run changed the history: asked again').to.be.greaterThan(beforeRun);

        const beforeDelete = reads;
        await h.controller.handle({ type: 'bulkDeleteTransactions', ids: ['tx-1'] });
        expect(reads, 'deleted from History: asked again').to.be.greaterThan(beforeDelete);
    });

    it('the Hub\'s state reads the environments once, however many there are', async () => {
        const h = hub();
        for (let i = 0; i < 30; i++) {
            await h.environments.addEnvironment({ name: `Env ${i}`, baseUrl: `https://e${i}.samplewms.test`, variables: { org: 'A' },
                variableSettings: { org: { options: ['A'], showInHeader: true } } });
        }
        let reads = 0;
        const all = h.environments.getAllEnvironments.bind(h.environments);
        h.environments.getAllEnvironments = async () => { reads++; return all(); };
        await h.controller.initialState();
        expect(reads, `read ${reads} times for 30 environments`).to.be.at.most(3);
    });
});
