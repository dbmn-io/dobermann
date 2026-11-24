// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The endpoint editor's host logic (endpoint/endpoint.js and the data transformer), shared by
 * VS Code and the web app. Moved from EndpointWebviewManager (#343).
 */
import type { APIEndpointConfig } from '../../apiConfigManager';
import type { TestConfig } from '../../data-loading/javascript-test-runner';
import { TemplateParser } from '../../data-loading/template-parser';
import { validateAPIEndpointConfig } from '../../data-loading/zod-schemas';
import { CSVSortingService } from '../../services/csv-sorting/csv-sorting.service';
import { parseSharedEndpointText } from '../../webviews/endpoint/shared-endpoint-parser';
import type { Disposable } from '../../platform/events';
import { decodeJwtPayload } from '../../utils/jwt-payload';
import { promptNewSystemInModal } from '../new-system-prompt';
import type { ScreenSession } from '../screen-session';
import { buildTemplateWorkbook, endpointTemplateVariables } from './data-template';
import { EndpointEditorPorts, TestPreviewSample } from './endpoint-editor.ports';
import { refreshTemplateLookups } from '../../data-loading/template-lookups';

export interface EndpointEditorConfig {
    /** The endpoint being edited; a `new-*` id (or none) for a draft. */
    itemId?: string;
    /** Duplicate: open a draft copied from this endpoint. */
    duplicateFromId?: string;
}

const NOT_A_SHARED_ENDPOINT = "Clipboard doesn't look like a DBMN endpoint. Use Copy to Share on a saved endpoint " +
    '(or copy a shared DBMN Endpoint card) and try again.';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export class EndpointEditorController {
    private readonly templateParser = new TemplateParser();
    private readonly csvSorting = new CSVSortingService();
    private systemsChanged?: Disposable;
    private environmentsChanged?: Disposable;

    constructor(
        private readonly session: ScreenSession,
        private readonly ports: EndpointEditorPorts,
        private readonly config: EndpointEditorConfig
    ) {}

    get endpointId(): string | undefined {
        return this.config.itemId;
    }

    async handle(msg: Record<string, unknown>): Promise<void> {
        const endpointId = typeof msg.endpointId === 'string' ? msg.endpointId : undefined;
        switch (msg.type) {
            case 'ready':
                await this.onReady();
                break;
            case 'saveEndpoint':
                await this.saveEndpoint(msg.endpoint);
                break;
            case 'getSavedTags':
                // #432: Manage Tags changed tags; the editor shows the endpoint's as saved now
                await this.postSavedTags(endpointId);
                break;
            case 'getTagsList':
                // #432: the tags field got focus; a tag saved in another editor since is offered too
                await this.broadcastTags();
                break;
            case 'saveEndpointError':
                // The screen's own checks (JSON syntax, name, path) stopped the save
                this.ports.host.saveFailed?.();
                break;
            case 'getEndpointData':
                await this.getEndpointData(endpointId);
                break;
            case 'createSystem':
                await this.createSystem();
                break;
            case 'closeWebview':
                this.ports.host.close();
                break;
            case 'windowMaximize':
                this.ports.host.maximize?.();
                break;
            case 'validationError':
                this.ports.toast.warn(String(msg.message));
                break;
            // Webview-origin feedback → the editor's own DbmnToast overlay
            case 'showSuccess':
            case 'showInfo':
            case 'showError':
            case 'showWarning':
                this.session.post({ type: 'dbmnToast', level: { showSuccess: 'success', showInfo: 'info', showError: 'error', showWarning: 'warn' }[msg.type], message: msg.message });
                break;
            // GitHub Issue #164: Paste Endpoint (copy is handled in the screen)
            case 'pasteEndpointFromClipboard':
                await this.pasteFromClipboard();
                break;
            // Issue #291: Ctrl+V into a field: the screen already holds the text
            case 'pasteEndpointText':
                await this.pasteEndpointText(typeof msg.text === 'string' ? msg.text : '', msg.pristineDraft === true, msg.isNewEndpoint === true);
                break;
            case 'validateTests':
                this.validateTests(msg.testConfigs as TestConfig[]);
                break;
            case 'runTestsPreview':
                await this.runTestsPreview(msg.testConfigs as TestConfig[], msg.sampleData as TestPreviewSample);
                break;
            case 'analyzeTemplate':
                this.analyzeTemplate(msg.template as string);
                break;
            case 'getCurrentEnvironment':
                await this.currentEnvironment();
                // An editor opened before the environment was chosen (or loaded, or changed) used
                // to keep that first answer: {{ENV:org}} "not found" while org was set (2026-10-10)
                this.environmentsChanged ??= this.ports.environments.onEnvironmentsChanged?.(() => { void this.currentEnvironment(); });
                break;
            case 'executeAPIInBackground':
                if (endpointId) await this.runApi(endpointId);
                break;
            case 'checkEndpointTransactions':
                if (endpointId) await this.checkTransactions(endpointId);
                break;
            case 'confirmDeleteEndpoint':
                if (endpointId && typeof msg.endpointName === 'string' && typeof msg.transactionCount === 'number') {
                    await this.confirmDelete(endpointId, msg.endpointName, msg.transactionCount);
                }
                break;
            case 'openRunBatchWebview':
                if (endpointId) await this.openRunBatch(endpointId);
                break;
            // GitHub Issue #165: ENV variables the template uses but the environment lacks
            case 'confirmAddMissingEnvVariables':
                if (Array.isArray(msg.missingVariables)) {
                    await this.confirmAddMissingEnvVariables(msg.missingVariables as string[], msg.environmentId as string | undefined, msg.environmentName as string | undefined);
                }
                break;
            case 'openEnvironmentForEmptyVars':
                await this.openEnvironmentForEmptyVars((msg.emptyVariables ?? []) as string[], msg.environmentId as string | undefined, msg.environmentName as string | undefined);
                break;
            // GitHub Issue #188: pasted headers the environment doesn't have
            case 'confirmPasteHeaders':
                if (Array.isArray(msg.missingHeaders)) {
                    await this.confirmPasteHeaders(msg.missingHeaders as Array<{ key: string; value: string; enabled: boolean }>);
                }
                break;
            // GitHub Issue #148: CSV sorting for nested arrays
            case 'analyzeNestedArraySorting':
                this.analyzeNestedArraySorting(msg.templateBody as string, msg.mappedColumns as string[], msg.csvContent as string, msg.variableToColumn as Record<string, string> | undefined);
                break;
            case 'getSortingExplanation':
                this.session.post({ type: 'sortingExplanation', explanation: this.csvSorting.getSortingExplanation(msg.sortColumns as string[], msg.arrayPaths as string[]) });
                break;
            // GitHub Issue #230: Create Template
            case 'createTemplateSave':
                if (endpointId) await this.createTemplate(endpointId);
                break;
        }
    }

    /** The screen loaded: Systems, then the endpoint (or a duplicate's copy). */
    async onReady(): Promise<void> {
        // A duplicate's System comes from the original, not the unsaved new tab
        await this.broadcastSystemsList(this.config.duplicateFromId || this.config.itemId);
        this.ensureSystemsChangedSubscription();
        await this.broadcastTags();

        if (this.config.duplicateFromId) {
            // An id-less endpoint is a fresh draft to the screen, marked dirty so Save is enabled
            const source = await this.ports.endpoints.getEndpoint(this.config.duplicateFromId);
            if (source) {
                this.session.post({ type: 'populateEndpointData', endpoint: { ...source, id: undefined, name: 'COPY ' + source.name }, body: source.body || '', isDuplicate: true });
            }
            return;
        }
        if (this.config.itemId) {
            const endpoint = await this.ports.endpoints.getEndpoint(this.config.itemId);
            if (endpoint) {
                this.session.post({ type: 'populateEndpointData', endpoint, body: endpoint.body || '' });
            }
        }
    }

    dispose(): void {
        this.systemsChanged?.dispose();
        this.systemsChanged = undefined;
        this.environmentsChanged?.dispose();
        this.environmentsChanged = undefined;
    }

    private async saveEndpoint(data: unknown): Promise<void> {
        const validation = data ? validateAPIEndpointConfig(data) : { success: false, errors: undefined, data: undefined };
        if (!validation.success || !validation.data) {
            this.session.post({ type: 'endpointSaveError', error: data ? `Validation failed: ${validation.errors?.join(', ')}` : 'No endpoint data provided' });
            // Resolve the save at once, so a waiting tab switch aborts now rather than timing out
            this.ports.host.saveFailed?.();
            return;
        }
        const endpoint = validation.data;
        try {
            // By id only: names can repeat. A draft's id (new-*, NEW, …) isn't stored, so it's an add.
            const existing = endpoint.id ? await this.ports.endpoints.getEndpoint(endpoint.id) : undefined;
            const saved = existing
                ? await this.ports.endpoints.updateEndpoint(existing.id, endpoint)
                : await this.ports.endpoints.addEndpoint(endpoint);
            this.config.itemId = saved.id;
            this.ports.host.saved?.(saved, !existing);
            this.session.post({ type: 'endpointSaved', endpoint: saved });
            await this.broadcastTags(); // a new tag is offered from now on
        } catch (error) {
            this.session.post({ type: 'endpointSaveError', error: message(error) });
            this.ports.host.saveFailed?.();
        }
    }

    private async getEndpointData(endpointId: string | undefined): Promise<void> {
        try {
            const endpoint = endpointId ? await this.ports.endpoints.getEndpoint(endpointId) : undefined;
            this.session.post(endpoint ? { type: 'endpointData', endpoint } : { type: 'endpointDataError', error: 'Endpoint not found' });
        } catch (error) {
            this.session.post({ type: 'endpointDataError', error: message(error) });
        }
    }

    private async postSavedTags(endpointId: string | undefined): Promise<void> {
        const endpoint = endpointId ? await this.ports.endpoints.getEndpoint(endpointId).catch(() => undefined) : undefined;
        if (endpoint) this.session.post({ type: 'savedTags', tags: Array.isArray(endpoint.tags) ? endpoint.tags : [] });
    }

    /** #432: the tags already in use on endpoints, most used first, for suggestions as one is typed. */
    private async broadcastTags(): Promise<void> {
        if (!this.ports.endpoints.getAllEndpoints) return;
        try {
            this.session.post({ type: 'tagsList', tags: tagsInUse(await this.ports.endpoints.getAllEndpoints()) });
        } catch {
            // No list: tags are still typed as before, without suggestions
        }
    }

    /**
     * Systems for the picker. An endpoint in storage shows its own System (possibly none: a
     * phantom default would hide it from the Hub's System filter). A draft (no id, or a `new-*`
     * id not saved yet) defaults to the active environment's System, and keeps it on save.
     */
    private async broadcastSystemsList(endpointId?: string): Promise<void> {
        const systems = this.ports.systems;
        if (!systems) return;
        try {
            const all = (await systems.getAllSystems()).slice().sort((a, b) => a.name.localeCompare(b.name));
            const existing = endpointId ? await this.ports.endpoints.getEndpoint(endpointId) : undefined;
            const selectedSystemId = existing
                ? existing.systemId
                : (await this.ports.environments.getActiveEnvironment())?.systemId;
            this.session.post({ type: 'systemsList', systems: all.map(s => ({ id: s.id, name: s.name, ...(s.scope ? { scope: s.scope } : {}) })), selectedSystemId });
        } catch {
            // No Systems yet: the editor stays usable with an empty dropdown
        }
    }

    private ensureSystemsChangedSubscription(): void {
        if (this.systemsChanged || !this.ports.systems?.onSystemsChanged) return;
        this.systemsChanged = this.ports.systems.onSystemsChanged(() => { void this.broadcastSystemsList(this.config.itemId); });
    }

    private async createSystem(): Promise<void> {
        const systems = this.ports.systems;
        if (!systems) return;
        try {
            const created = await promptNewSystemInModal(systems, this.session);
            if (!created) return;
            const all = (await systems.getAllSystems()).slice().sort((a, b) => a.name.localeCompare(b.name));
            this.session.post({ type: 'systemsList', systems: all.map(s => ({ id: s.id, name: s.name, ...(s.scope ? { scope: s.scope } : {}) })), selectedSystemId: created.id });
        } catch (error) {
            this.ports.toast.error(`Add System failed: ${message(error)}`);
        }
    }

    private async pasteFromClipboard(): Promise<void> {
        let text: string;
        try {
            text = await this.ports.readClipboard();
        } catch (error) {
            console.error('[EndpointEditor] Error reading from clipboard:', error);
            this.ports.toast.error('Failed to read from clipboard');
            return;
        }
        const parsed = parseSharedEndpointText(text);
        if (parsed) {
            this.session.post({ type: 'pastedEndpointData', endpoint: parsed });
            // (#473: a body that came through without its line breaks and couldn't be read back for certain)
            if (parsed.warning) this.ports.toast.warn(parsed.warning);
        } else {
            this.ports.toast.warn(NOT_A_SHARED_ENDPOINT);
        }
    }

    /**
     * Issue #291: text pasted into a field that looks like a shared endpoint. Not one → back as
     * plain text (never swallow a paste). A pristine draft → straight onto the form. Otherwise ask.
     */
    private async pasteEndpointText(text: string, pristineDraft: boolean, isNewEndpoint: boolean): Promise<void> {
        const parsed = parseSharedEndpointText(text);
        if (!parsed) {
            this.session.post({ type: 'insertPastedText', text });
            return;
        }
        if (pristineDraft) {
            this.session.post({ type: 'pastedEndpointData', endpoint: parsed });
            if (parsed.warning) this.ports.toast.warn(parsed.warning);
            return;
        }
        const label = [parsed.method, parsed.path].filter(Boolean).join(' ');
        const what = parsed.name ? `"${parsed.name}" (${label})` : label;
        const consequence = isNewEndpoint
            ? 'Pasting it as an endpoint fills in this form, replacing the name, method, path and body you have entered.'
            : 'Pasting it as an endpoint replaces this saved endpoint\'s name, method, path and body — nothing changes until you Save.';
        const result = await this.session.showModal({
            title: 'Paste as endpoint?',
            body: `The clipboard looks like a shared DBMN endpoint: ${what}.\n\n${consequence}\n\nOr paste it as plain text into the field you were in.`,
            actions: [
                { id: 'text', label: 'Paste as text', variant: 'secondary' },
                { id: 'endpoint', label: 'Paste as Endpoint', variant: 'primary' }
            ],
            dismissible: true,
            size: 'sm'
        });
        if (result.actionId === 'endpoint') {
            this.session.post({ type: 'pastedEndpointData', endpoint: parsed });
            if (parsed.warning) this.ports.toast.warn(parsed.warning);
        } else if (result.actionId === 'text') {
            this.session.post({ type: 'insertPastedText', text });
        }
        // Dismissed → nothing pasted, which is what Escape means
    }

    private validateTests(tests: TestConfig[]): void {
        const runner = this.ports.tests;
        this.session.post({
            type: 'testValidationResults',
            results: tests.map(test => ({
                name: test.name,
                validation: runner ? runner.validate(test.script) : { isValid: false, error: 'Test scripts run in DBMN for VS Code for now.' }
            }))
        });
    }

    private async runTestsPreview(tests: TestConfig[], sample: TestPreviewSample): Promise<void> {
        const runner = this.ports.tests;
        const results = runner
            ? await runner.preview(tests.filter(t => t.enabled), sample)
            : tests.filter(t => t.enabled).map(t => ({ testName: t.name, success: false, error: 'Test scripts run in DBMN for VS Code for now.' }));
        this.session.post({ type: 'testPreviewResults', results });
    }

    private analyzeTemplate(template: string): void {
        let variables: unknown[] = [];
        let arrays: unknown[] = [];
        try {
            if (template && template.trim() !== '') {
                const analysis = this.templateParser.parseTemplate(template);
                if (analysis.isValid) {
                    variables = analysis.variables || [];
                    arrays = analysis.arrays || [];
                }
            }
        } catch {
            // Unparseable template: no variables
        }
        this.session.post({ type: 'templateAnalysisResults', variables, arrays });
    }

    /**
     * The lookup tables' names and columns, for the template editor's list / lookup types: its
     * predictive text offers them, and it marks a table or column that isn't there.
     */
    private async postLookupTables(): Promise<void> {
        try {
            const tables = await refreshTemplateLookups();
            this.session.post({ type: 'lookupTables', tables: tables.map(t => ({ name: t.name, columns: t.columns.map(c => c.name) })) });
        } catch { /* the editor works without them */ }
    }

    private async currentEnvironment(): Promise<void> {
        const none = (name: string) => this.session.post({ type: 'currentEnvironmentData', environment: { id: null, name, baseUrl: null } });
        try {
            const active = await this.ports.environments.getActiveEnvironment();
            if (!active) {
                none('No Active Environment');
                return;
            }
            let baseUrl = active.baseUrl;
            if (!baseUrl) {
                // No Base URL: a JWT's issuer names the API
                const token = await this.ports.environments.getEnvironmentToken(active.id);
                const iss = token ? decodeJwtPayload<{ iss?: unknown }>(token)?.iss : undefined;
                if (typeof iss === 'string') baseUrl = iss.replace(/-auth$/, '');
            }
            const variables: Record<string, string> = { ...(active.variables || {}) };
            void this.postLookupTables();
            this.session.post({
                type: 'currentEnvironmentData',
                environment: {
                    id: active.id,
                    name: active.name,
                    baseUrl: baseUrl || null,
                    parallelProcessing: active.parallelProcessing || { enabled: false, maxConcurrency: 1 },
                    headers: active.headers || undefined,
                    variables: Object.keys(variables).length > 0 ? variables : undefined
                }
            });
        } catch (error) {
            console.error('Error getting current environment:', error);
            none('Error Loading Environment');
        }
    }

    private async runApi(endpointId: string): Promise<void> {
        try {
            const endpoint = await this.ports.endpoints.getEndpoint(endpointId);
            if (!endpoint) throw new Error(`Endpoint ${endpointId} not found`);
            await this.ports.runApi(endpoint);
        } catch (error) {
            console.error('[EndpointEditor] Run API failed:', error);
            this.ports.toast.error(`Run API failed: ${message(error)}`);
        }
    }

    private async checkTransactions(endpointId: string): Promise<void> {
        let count = 0;
        try {
            count = (await this.ports.countTransactions?.(endpointId)) ?? 0;
        } catch (error) {
            console.error('[EndpointEditor] Error checking endpoint transactions:', error);
        }
        this.session.post({ type: 'transactionCountResponse', count });
    }

    private async confirmDelete(endpointId: string, name: string, transactionCount: number): Promise<void> {
        const body = transactionCount > 0
            ? `⚠️ WARNING: This endpoint has ${transactionCount} recorded transaction${transactionCount === 1 ? '' : 's'}.\n\nDeleting "${name}" will not delete the transaction history.\n\nThis action cannot be undone. Are you sure?`
            : `Are you sure you want to delete "${name}"?\n\nThis action cannot be undone.`;
        if (!await this.ports.confirmDestructive({ title: 'Delete endpoint?', body, confirmLabel: 'Delete' })) return;
        try {
            if (!await this.ports.endpoints.deleteEndpoint(endpointId)) throw new Error('Endpoint not found');
            this.session.post({ type: 'endpointDeleted', endpointId });
            if (this.config.itemId === endpointId) this.ports.host.close();
        } catch (error) {
            this.session.post({ type: 'endpointDeleteError', error: message(error) });
        }
    }

    private async openRunBatch(endpointId: string): Promise<void> {
        try {
            const endpoint = await this.ports.endpoints.getEndpoint(endpointId);
            if (!endpoint) {
                this.ports.toast.error(`Endpoint not found: ${endpointId}`);
                return;
            }
            await this.ports.openRunBatch(endpoint);
        } catch (error) {
            this.ports.toast.error(`Failed to open Run Batch: ${message(error)}`);
        }
    }

    private async confirmAddMissingEnvVariables(variables: string[], environmentId?: string, environmentName?: string): Promise<void> {
        const list = variables.join(', ');
        const result = await this.session.showModal({
            title: 'Missing environment variables',
            body: `Template uses ENV variables not set in ${environmentName || 'current environment'}: ${list}\n\nWould you like to add them now?`,
            actions: [
                { id: 'cancel', label: 'Cancel', variant: 'secondary' },
                { id: 'add', label: 'Add Variables', variant: 'primary' }
            ],
            dismissible: true,
            size: 'sm'
        });
        if (result.actionId !== 'add') return;
        try {
            const id = environmentId || (await this.ports.environments.getActiveEnvironment())?.id;
            if (!id) {
                this.ports.toast.error('No active environment selected. Please select an environment first.');
                return;
            }
            // Not saved: the environment editor adds them as unsaved rows, for the user to fill in and save
            this.session.post({ type: 'envVariablesAdded', success: true, addedCount: variables.length, variables, proceedWithBatch: false });
            await this.ports.openEnvironmentWithVariables(id, variables);
            this.ports.toast.info(`Please set the value(s) for: ${list}`);
        } catch (error) {
            this.session.post({ type: 'envVariablesAdded', success: false, error: message(error) });
        }
    }

    private async openEnvironmentForEmptyVars(variables: string[], environmentId?: string, environmentName?: string): Promise<void> {
        if (environmentId) {
            await this.ports.openEnvironmentWithVariables(environmentId, variables);
        }
        this.ports.toast.warn(`Please set value(s) for: ${variables.join(', ')} in ${environmentName || 'current environment'}`);
    }

    private async confirmPasteHeaders(headers: Array<{ key: string; value: string; enabled: boolean }>): Promise<void> {
        const count = headers.length;
        const result = await this.session.showModal({
            title: 'Headers not in environment',
            body: `${count} header${count > 1 ? 's' : ''} from the pasted template ${count > 1 ? 'are' : 'is'} not in the current active environment: ${headers.map(h => h.key).join(', ')}\n\nThey can be added directly to this endpoint.`,
            actions: [
                { id: 'learn-more', label: 'Learn More', variant: 'secondary' },
                { id: 'add', label: 'Add to Endpoint', variant: 'primary' }
            ],
            dismissible: true,
            size: 'sm'
        });
        if (result.actionId === 'add') {
            this.session.post({ type: 'addPastedHeaders', headers });
        } else if (result.actionId === 'learn-more') {
            this.session.openExternal('https://dbmn.io/docs/endpoints/#headers');
        }
    }

    private analyzeNestedArraySorting(templateBody: string, mappedColumns: string[], csvContent: string, variableToColumn?: Record<string, string>): void {
        try {
            const analysis = this.csvSorting.analyzeNestedArrayRequirements(templateBody, mappedColumns, variableToColumn);
            if (!analysis.requiresSorting || analysis.sortColumns.length === 0) {
                this.session.post({ type: 'sortingAnalysisResult', requiresSorting: false });
                return;
            }
            const check = this.csvSorting.isDataSorted(csvContent, analysis.sortColumns);
            this.session.post({
                type: 'sortingAnalysisResult',
                requiresSorting: true,
                isSorted: check.isSorted,
                sortColumns: analysis.sortColumns,
                arrayPaths: analysis.arrayPaths,
                explanation: analysis.explanation,
                firstUnsortedRow: check.firstUnsortedRow,
                unsortedSample: check.unsortedSample
            });
        } catch (error) {
            console.error('[EndpointEditor] Error analyzing nested array sorting:', error);
            this.session.post({ type: 'sortingAnalysisResult', requiresSorting: false, error: message(error) });
        }
    }

    private async createTemplate(endpointId: string): Promise<void> {
        try {
            const endpoint = await this.ports.endpoints.getEndpoint(endpointId);
            if (!endpoint) {
                this.session.post({ type: 'templateError', error: 'Endpoint not found' });
                return;
            }
            const variables = endpointTemplateVariables(endpoint);
            if (variables.length === 0) {
                this.session.post({ type: 'templateError', error: 'No template variables found in this endpoint' });
                return;
            }
            const name = `${(endpoint.name || 'template').replace(/[^a-zA-Z0-9\-_]/g, '_')}-template.xlsx`;
            const fileName = await this.ports.saveFile(name, buildTemplateWorkbook(variables), { Excel: ['xlsx'] });
            if (fileName) {
                this.session.post({ type: 'templateSaveComplete', fileName });
            }
        } catch (error) {
            this.session.post({ type: 'templateError', error: `Failed to save template: ${message(error)}` });
        }
    }
}

/** #432: the tags on these endpoints, most used first, then A to Z. */
export function tagsInUse(endpoints: Array<{ tags?: string[] }>): string[] {
    const counts = new Map<string, number>();
    for (const endpoint of endpoints) {
        for (const tag of new Set(endpoint.tags ?? [])) {
            if (typeof tag === 'string' && tag.trim()) counts.set(tag, (counts.get(tag) ?? 0) + 1);
        }
    }
    return Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([tag]) => tag);
}
