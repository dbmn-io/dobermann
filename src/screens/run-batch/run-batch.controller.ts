// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Run Batch Webview
 *
 * Dedicated webview for batch execution via CSV upload.
 * Moved from endpoint webview modal to standalone webview (GitHub Issue #98).
 * Extends WebviewBase for consistent lifecycle management.
 */

import type { APIEndpointConfig } from '../../apiConfigManager';
import { executeSummary, threadChoices } from './execute-summary';
import { cleanExecuteChoices, type ExecuteChoices } from './execute-choices';
import { cleanReviewHandoff, type ReviewHandoff } from './review-handoff';
import { ChainHandoff } from '../../services/chain/chain-types';
import type { ScreenSession } from '../screen-session';
import type { RunBatchPorts } from './run-batch.ports';
import type { EnvironmentConfig } from '../../environmentManager';
import type { SourceFormat, TargetDataType } from '../../services/format-converter/source-format.interface';
import type { WebviewConfig, WebviewMessage } from '../../webviews/shared/types';
import { encodeBase64Fields, calculateJsonSize, formatFileSize } from '../../utils/encoding';
import { validateNonJsonTemplate } from '../../data-loading/json-template-parser';
import { BatchTemplateVariable, extractBatchTemplateVariables } from '../../webviews/run-batch/batch-template-variables';
// GitHub Issue #148: CSV sorting for nested arrays
import { CSVSortingService } from '../../services/csv-sorting/csv-sorting.service';
import { SupportedFormat } from '../../services/format-converter/format-converter.interface';
import { ICSVSortingService } from '../../services/csv-sorting/csv-sorting.interface';
import { convertValueBySourceFormat, applySourceFormatConversions } from '../../utils/source-format-converter';
import { BatchStartFailure, bulkLoadFailure, describeBatchStartFailure, reportBatchStartFailure } from '../../webviews/run-batch/bulk-load-result';
import { applyProductionChoice, confirmProductionExecution, isProductionEnvironment, productionGuardFor } from '../../services/ui/production-guard.service';
import { ensureHeaderVariables } from '../../services/environment/header-variable-check';
import { countNestedCalls, groupingColumnsForPreview } from '../../webviews/run-batch/nested-call-count';
import { createDefaultDataLoadingConfig } from '../../data-loading/zod-schemas';
import { planBatch, BatchPlan, PlanRequest } from '../../data-loading/batch-plan';
import { QueryParamRepetitionConfig } from '../../services/transaction-preparation/helpers/query-param-repetition.helper';
import { stripJsonCommentsSafe } from '../../utils/json-comment-stripper';
import * as templateRenameScript from '../../webviews/shared/template-rename.js';
import { sharedScript } from '../../utils/shared-script';
import { JsonGenerator } from '../../data-loading/json-generator';
import { ArrayRepetitionHelper } from '../../services/transaction-preparation/helpers/array-repetition.helper';
import { TemplateParser } from '../../data-loading/template-parser';
import { lookupTablesNamed, refreshTemplateLookups, templateUsesLookups } from '../../data-loading/template-lookups';
const TemplateRename = sharedScript<typeof templateRenameScript>(templateRenameScript, 'TemplateRename');
// GitHub Issue #226: Centralised column-mismatch detection (testable utility)
import {
    detectDelimiter as csvDetectDelimiter,
    parseCSVLine as csvParseLine,
    parseCSVContent as csvParseContent,
    detectColumnMismatches as csvDetectColumnMismatches,
    CsvDelimiter
} from '../../utils/csv-mismatch';

export interface RunBatchConfig extends WebviewConfig {
    endpointId: string;
    endpointName: string;
    endpoint: any; // Full endpoint configuration
    /** GitHub Issue #247: rows chained from a Console, loaded into Step 1. */
    chain?: ChainHandoff;
}

export interface RunBatchMessage extends WebviewMessage {
    type: 'processCSVFile' | 'validateColumnMappings' | 'executeBatch' | 'closeWebview' | 'requestTemplateLookups' |
    'showSuccessMessage' | 'showErrorMessage' | 'showError' | 'showWarning' | 'requestEndpointConfig' | 'executeBulkLoadCommand' |
    'getEndpointTemplate' | 'generateJsonPreview' | 'generateBulkJson' | 'verifyCSV' |
    'getCurrentEnvironment' |
    'validateWorkspaceForBatch' | 'openFileDialog' | 'detectFileFormat' | 'convertFileFormat' |
    'parseCSVForModal' | 'verifyCSVCompatibility' | 'applyTypeTransformations' |
    'saveEndpoint' | 'generateExecutionJson' |
    // GitHub Issue #135: Coercion validation
    'validateSampleCoercion' | 'validateFullCoercion' |
    // GitHub Issue #148: CSV sorting for nested arrays
    'analyzeNestedArraySorting' | 'getSortingExplanation' |
    // GitHub Issue #223: Excel sheet arrays (skip CSV round-trip)
    'getExcelSheetAsArrays' |
    // Shared window controls (min/max/close cluster)
    'windowMaximize' |
    // GitHub Issue #247: "Chained from …" link
    'openChainSource' |
    // #470: Execute pressed on Review: its confirmation's data, answered as runBatch.executeConfirm
    'runBatch.executeAsk';

    // CSV file upload
    fileData?: string;
    fileName?: string;
    fileFormat?: string; // 'csv', 'xlsx', 'tsv', 'txt'

    // CSV verification
    csvData?: string | string[][]; // Can be raw CSV string or parsed array

    // CSV parsing
    parsedData?: {
        headers: string[];
        rows: string[][];
    };
    /** GitHub Issue #308: the URL query-parameter repetition settings, as Execute sends them. */
    queryParamRepetition?: QueryParamRepetitionConfig;
    /** GitHub Issue #307: "Update Endpoint Template" — old variable name → new, applied after the batch runs. */
    templateRenames?: Record<string, string>;
    /** GitHub Issue #247: set on Execute while Step 1 still holds the chained rows. */
    chainSourceExecutionId?: string;
    /** #470: what Review showed at Execute (ReviewHandoff), for the Console that takes this tab's place. */
    review?: unknown;
    /** #470: the choices made in Execute's confirmation (absent: an older page, which confirms by the modals). */
    confirm?: ExecuteChoices;
    /** Every row, sent when parsedData is only a preview sample — "Total API calls" counts these. */
    countData?: {
        headers: string[];
        rows: string[][];
    } | null;
    headers?: string[];
    totalRows?: number;

    // Column mapping
    mappings?: Array<{
        variable: string;
        column: string | null;
        dataType: string;
        sourceFormat?: string;  // GitHub Issue #135: Source format for type coercion
    }>;
    templateVariables?: Array<{
        name: string;
        mappedTo: string | null;
        dataType: string;
    }>;

    // Batch configuration
    batchName?: string;
    sourceType?: 'file' | 'paste';
    sourceFileName?: string;
    sourceSheetName?: string;
    sheetName?: string; // GitHub Issue #223: For getExcelSheetAsArrays

    // Execution options
    parallelProcessing?: {
        enabled: boolean;
        maxConcurrency: number;
    };

    // Query param repetition (GitHub Issue #108)
    repeatableQueryParam?: {
        enabled: boolean;
        paramKey: string;
        pattern: string;
        separator: string;
        maxUrlLength: number;
        maxPerRequest: number | null;
    };

    // Type transformations (GitHub Issue #106)
    columnTypes?: Record<string, string>;

    // File format conversion options
    fileSize?: number;
    options?: any;

    // Execution payload
    endpointId?: string;
    jsonData?: any[];

    // Endpoint configuration (for save operations)
    endpoint?: any;

    // Array configuration for JSON preview (GitHub Issue #106)
    uiArrayConfig?: {
        arrayPath: string;
        maxRepetitions: number;
    };
    mode?: string; // 'preview' | 'full'
    includeArrayDetection?: boolean;

    // Messages
    message?: string;
    error?: string;

    // GitHub Issue #135: Coercion validation
    variableIndex?: number;
    columnName?: string;
    targetType?: string;
    sourceFormat?: string;
    sampleValues?: string[];
    validationMappings?: Array<{
        variableName: string;
        csvColumn: string;
        targetType: string;
        sourceFormat: string;
    }>;
    rows?: string[][];
}

export class RunBatchController {
    /** The tab is gone: nothing more to post. */
    private closed = false;
    private endpointConfig: any;
    private endpointId: string;
    private endpointName: string;
    // GitHub Issue #148: CSV sorting for nested arrays
    private csvSortingService: ICSVSortingService;
    /** GitHub Issue #247: the chained rows this Run Batch was opened (or re-used) with. */
    private chain: ChainHandoff | undefined;

    constructor(private readonly session: ScreenSession, private readonly ports: RunBatchPorts, config: RunBatchConfig) {
        this.endpointId = config.endpointId;
        this.endpointName = config.endpointName;
        this.endpointConfig = config.endpoint;
        this.chain = config.chain;
        // GitHub Issue #148: CSV sorting for nested arrays
        this.csvSortingService = new CSVSortingService();
    }

    dispose(): void {
        this.closed = true;
        this.session.dismissAll();
    }

    async handleMessage(message: RunBatchMessage): Promise<void> {

        switch (message.type) {
            // The window controls (maximise, close) are the Hub's: it handles them for its tabs
            case 'requestEndpointConfig':
                await this.handleRequestEndpointConfig();
                break;

            case 'requestTemplateLookups':
                await this.postTemplateLookups();
                break;

            case 'executeBulkLoadCommand':
                await this.handleExecuteBulkLoadCommand(message);
                break;

            // #470: Execute pressed on Review: what its confirmation says and offers
            case 'runBatch.executeAsk':
                await this.handleExecuteAsk();
                break;

            case 'generateBulkJson':
                await this.handleGenerateBulkJson(message);
                break;

            case 'getCurrentEnvironment':
                await this.handleGetCurrentEnvironment();
                break;

            // GitHub Issue #247: the banner's link to the run the rows came from
            case 'openChainSource':
                if (this.chain) {
                    await this.ports.host.openConsole(this.chain.sourceExecutionId, !!this.chain.sourceIsBatch);
                }
                break;

            case 'detectFileFormat':
                await this.handleDetectFileFormat(message);
                break;

            case 'convertFileFormat':
                await this.handleConvertFileFormat(message);
                break;

            case 'parseCSVForModal':
                await this.handleParseCSVForModal(message);
                break;

            case 'verifyCSVCompatibility':
                await this.handleVerifyCSVCompatibility(message);
                break;

            case 'applyTypeTransformations':
                await this.handleApplyTypeTransformations(message);
                break;

            case 'saveEndpoint':
                await this.handleSaveEndpoint(message);
                break;

            // GitHub Issue #135: Coercion validation
            case 'validateSampleCoercion':
                await this.handleValidateSampleCoercion(message);
                break;

            case 'validateFullCoercion':
                await this.handleValidateFullCoercion(message);
                break;

            // GitHub Issue #148: CSV sorting for nested arrays
            case 'analyzeNestedArraySorting':
                await this.handleAnalyzeNestedArraySorting(message);
                break;

            case 'getSortingExplanation':
                await this.handleGetSortingExplanation(message);
                break;

            case 'showSuccessMessage':
                if (message.message) {
                    this.ports.toast.info(message.message);
                }
                break;

            // Never dropped: a problem the page reports is shown (a file it couldn't read said
            // nothing before: no case took 'showError')
            case 'showError':
                if (message.message) this.ports.toast.error(message.message);
                break;
            case 'showWarning':
                if (message.message) this.ports.toast.warn(message.message);
                break;

        }
    }

    private async handleRequestEndpointConfig(): Promise<void> {

        try {
            // Send endpoint configuration to frontend
            this.session.post({
                type: 'endpointConfigLoaded',
                endpoint: this.endpointConfig
            });
            // GitHub Issue #247: chained rows go in once the page knows the endpoint.
            if (this.chain) this.postChainPreload();
            await this.postTemplateLookups();
        } catch (error) {
            console.error('[RunBatchWebview] Failed to load endpoint config:', error);
        }
    }

    /**
     * list / lookup types in the template (James, 2026-11-23): the lookup tables they name, read again and given to
     * the page, so Validate checks each row as the run will. Sent with the endpoint, and again when
     * the page asks (it reaches Validate), so an edit made in the meantime counts.
     */
    private async postTemplateLookups(): Promise<void> {
        const template = JSON.stringify(this.endpointConfig ?? {});
        if (!templateUsesLookups(template)) return;
        const named = lookupTablesNamed(template);
        const tables = (await refreshTemplateLookups()).filter(t => named.has(t.name.trim().toLowerCase()));
        this.session.post({ type: 'templateLookups', tables });
    }

    /** GitHub Issue #247: chaining into a Run Batch that is already open replaces its Step 1 data. */
    applyChain(chain: ChainHandoff): void {
        this.chain = chain;
        this.postChainPreload();
    }

    /**
     * #470: Execute's confirmation. The page asks (`runBatch.executeAsk`, no payload) when Execute is pressed on
     * Review; the header variables are asked for first if one is missing (#424), so the window shows what will be
     * sent. The answer:
     *   { type: 'runBatch.executeConfirm', summary: ExecuteSummary }     (execute-summary.ts: rows, requests,
     *       rowsPerRequest, method, url, environment { name, production, headers [{ name, value }] },
     *       errorHandling { value, options }, threads { value, options }, guard: ProductionGuard | null, sentence)
     *   { type: 'runBatch.executeConfirm', error: string }               (no active environment, Review not drawn)
     *   { type: 'resetExecuteButton' }                                    (the header prompt was cancelled)
     * The window's Execute then sends executeBulkLoadCommand as today, plus
     *   confirm: { errorHandling: 'continue' | 'stop', threads: number, production?: { minutes: 0 | 15 | 30 | 60 } }
     *   review:  ReviewHandoff (review-handoff.ts), what Review showed, for the Console that takes the tab's place.
     * `production` is the guard's answer, sent only when summary.guard was shown (its Warning frequency as minutes).
     */
    private async handleExecuteAsk(): Promise<void> {
        const environments = this.ports.environments;
        const environment = await environments.getActiveEnvironment();
        if (!environment) {
            this.session.post({ type: 'runBatch.executeConfirm', error: 'No active environment: pick one in the header, then Execute.' });
            return;
        }
        if (!(await ensureHeaderVariables(environment, environments, { modal: () => this.session, toast: this.ports.toast }))) {
            this.session.post({ type: 'resetExecuteButton' });
            return;
        }
        const headers = await environments.getHeaderVariables(environment.id).catch(() => []);
        try {
            // (Error handling as chosen last on this tab, else as the endpoint keeps it: Review's choice is saved there)
            const saved = this.endpointConfig?.dataLoadingConfig?.errorHandling?.mode === 'stopOnFirst';
            const current = { stopOnFirstError: this.choices.stopOnFirstError ?? saved, threads: this.choices.threads };
            // The run as it will be sent (2026-11-24: the window said 1,000 requests over a Review of 100, the plan it read
            // a step behind a Rows per request just changed): planned again now from Review's rows, with the endpoint as
            // the run reads it (the page saved Rows per request to it before asking), never from the last plan drawn
            const plan = await this.planAsRun();
            const summary = executeSummary({ plan, environment, headers: headers.map(h => ({ name: h.name, value: h.value })), current });
            this.session.post({ type: 'runBatch.executeConfirm', summary });
        } catch (error) {
            this.session.post({ type: 'runBatch.executeConfirm', error: error instanceof Error ? error.message : String(error) });
        }
    }
    private lastPlan: BatchPlan | undefined;
    /** What Review planned from (its rows, the message, the environment): the confirmation plans the run again from it. */
    private lastPlanArgs: { source: { headers: string[]; rows: string[][] }; message: RunBatchMessage; environment: { baseUrl?: string } | undefined; variables: Record<string, string> } | undefined;
    /** The run's plan now: Review's rows with the endpoint as stored (its Rows per request as the run will use it). */
    private async planAsRun(): Promise<BatchPlan | undefined> {
        const args = this.lastPlanArgs;
        if (!args) return this.lastPlan;
        const stored = await this.ports.endpoints.getEndpoint(this.endpointId).catch(() => undefined);
        const plan = await this.buildPlanForPreview(args.source, args.message, args.environment, args.variables, stored || this.endpointConfig);
        this.lastPlanArgs = args;
        return plan;
    }
    private choices: { stopOnFirstError?: boolean; threads?: number } = {};

    /** #470: what Review showed when Execute was last pressed (the Hub hands it to the run's Console). */
    handoff(): ReviewHandoff | undefined {
        return this.review;
    }
    private review: ReviewHandoff | undefined;

    private postChainPreload(): void {
        if (!this.chain) return;
        this.session.post({
            type: 'chainPreload',
            csv: this.chain.csv,
            rowCount: this.chain.rowCount,
            sourceExecutionId: this.chain.sourceExecutionId,
            sourceIsBatch: !!this.chain.sourceIsBatch,
            sourceLabel: this.chain.sourceLabel,
            viewName: this.chain.viewName
        });
    }


    /**
     * Extract template variables from endpoint configuration
     *
     * Issue #130: Now uses JSON-aware parsing for body templates to support
     * {{}} and {{:type}} shorthand syntax that infers names from JSON keys.
     */
    private extractTemplateVariables(endpointConfig: any): BatchTemplateVariable[] {
        return extractBatchTemplateVariables(endpointConfig);
    }


    /**
     * Handle bulk load command execution with endpoint version check
     * GitHub Issue #98: Check if endpoint was modified since webview opened
     */
    private async handleExecuteBulkLoadCommand(message: RunBatchMessage): Promise<void> {

        try {
            if (!message.endpointId || !message.jsonData || message.jsonData.length === 0) {
                throw new Error('Missing required batch execution data');
            }
            this.review = cleanReviewHandoff(message.review);

            // GitHub Issue #273: guard batch execution against a production environment.
            // This is the final "Execute" step, so it's the right place to confirm.
            // The modal renders over this panel (host = this). No-op for non-production
            // environments and while a suppression window is active.
            const environmentManager = this.ports.environments;
            const activeEnvironment = await environmentManager.getActiveEnvironment();

            // #470: the confirmation window (runBatch.executeConfirm) carries the production guard; its answer comes back
            // here. Production still asking with no yes from the window is refused, never run. An older page with no
            // window confirms by the modal, as before
            const confirm = message.confirm ? cleanExecuteChoices(message.confirm, activeEnvironment ? threadChoices(activeEnvironment) : [1]) : undefined;
            if (confirm) {
                const guard = productionGuardFor(activeEnvironment, 'Run Batch');
                if (guard && guard.ask && confirm.productionMinutes === undefined) {
                    this.ports.toast.warn(`Not run: ${guard.environment} is production and the confirmation was not given.`);
                    this.session.post({ type: 'resetExecuteButton' });
                    return;
                }
                if (activeEnvironment && guard && confirm.productionMinutes !== undefined) applyProductionChoice(activeEnvironment, confirm.productionMinutes);
                this.choices = { stopOnFirstError: confirm.stopOnFirstError, threads: confirm.threads };
            } else if (activeEnvironment && !(await confirmProductionExecution(activeEnvironment, 'Run Batch', this.session))) {
                // User cancelled — restore the Execute button (mid "Processing…") and abort.
                this.session.post({ type: 'resetExecuteButton' });
                return;
            }

            // #424: every header variable (the org among them) holds one of its options, asked for here if not
            if (activeEnvironment && !(await ensureHeaderVariables(activeEnvironment, environmentManager, { modal: () => this.session, toast: this.ports.toast }))) {
                this.session.post({ type: 'resetExecuteButton' });
                return;
            }

            // Check if endpoint was modified since webview opened (GitHub Issue #98)
            const endpointManager = this.ports.endpoints;
            const currentEndpoint = await endpointManager.getEndpoint(message.endpointId);

            if (!currentEndpoint) {
                throw new Error('Endpoint not found');
            }

            // Compare meaningful endpoint properties (avoid false positives from property ordering)
            const hasChanged =
                currentEndpoint.name !== this.endpointConfig.name ||
                currentEndpoint.path !== this.endpointConfig.path ||
                currentEndpoint.method !== this.endpointConfig.method ||
                JSON.stringify(currentEndpoint.body) !== JSON.stringify(this.endpointConfig.body) ||
                JSON.stringify(currentEndpoint.headers) !== JSON.stringify(this.endpointConfig.headers) ||
                JSON.stringify(currentEndpoint.queryParams) !== JSON.stringify(this.endpointConfig.queryParams);

            if (hasChanged) {
                // Endpoint was modified - warn user
                const choice = await this.session.showModal({
                    title: 'Endpoint modified',
                    body: 'The endpoint configuration has been modified since you opened this batch execution. Do you want to continue with the original configuration or reload?',
                    actions: [
                        { id: 'cancel', label: 'Cancel', variant: 'secondary' },
                        { id: 'reload', label: 'Reload & Restart', variant: 'secondary' },
                        { id: 'continue', label: 'Continue with Original', variant: 'primary' }
                    ],
                    dismissible: true,
                    size: 'sm'
                });

                if (choice.actionId === 'reload') {
                    // Reload endpoint and restart
                    this.endpointConfig = currentEndpoint;
                    this.session.post({
                        type: 'endpointConfigLoaded',
                        endpoint: currentEndpoint
                    });
                    this.ports.toast.info('Endpoint reloaded. Please restart your batch configuration.');
                    return;
                } else if (choice.actionId !== 'continue') {
                    // Cancel or dismiss — abort.
                    return;
                }
                // Otherwise continue with original
            }

            // GitHub Issue #224: Notify frontend that batch preparation is starting
            this.session.post({
                type: 'batchPreparationProgress',
                stage: 'preparing',
                message: 'Preparing batch execution...'
            });

            // Fire execution (don't await — batch runs in background, console opens from within)
            const executionPromise = Promise.resolve(this.ports.executeBulkLoad({
                endpointId: message.endpointId,
                jsonData: message.jsonData,
                mappings: message.mappings || [],
                batchName: message.batchName || `Batch ${new Date().toISOString()}`,
                sourceType: message.sourceType || 'file',
                sourceFileName: message.sourceFileName,
                sourceSheetName: message.sourceSheetName,
                parallelProcessing: confirm ? { enabled: confirm.threads > 1, maxConcurrency: confirm.threads } : (message.parallelProcessing || { enabled: false, maxConcurrency: 1 }),
                ...(confirm ? { stopOnFirstError: confirm.stopOnFirstError } : {}),
                repeatableQueryParam: message.repeatableQueryParam,
                columnTypes: message.columnTypes,
                // GitHub Issue #247: linked only while Step 1 still holds the chained rows
                chainedFrom: this.chain && message.chainSourceExecutionId === this.chain.sourceExecutionId
                    ? { sourceExecutionId: this.chain.sourceExecutionId, viewName: this.chain.viewName, rowCount: this.chain.rowCount }
                    : undefined
            }));

            executionPromise.then(async (result: unknown) => {
                // GitHub Issue #396: the answer is { success: false } when the batch did not
                // start (sign-in not completed, preparation failed). Say why and
                // keep the tab, so it can be run again. It used to be ignored, and the tab sat
                // on "Preparing batch execution…" for ever.
                const failure = this.describeStartFailure(result);
                if (failure) {
                    await this.reportStartFailure(failure);
                    return;
                }
                // GitHub Issue #307: "Update Endpoint Template". Only now: every chunk of this
                // batch has been built from the template it started with.
                if (message.endpointId && message.templateRenames && Object.keys(message.templateRenames).length > 0) {
                    await this.applyTemplateRenames(message.endpointId, message.templateRenames);
                }
                // Batch finished normally — refresh explorer if still relevant
                // Close run-batch panel after console opens
                setTimeout(() => {
                    if (!this.closed) {
                        this.ports.host.close();
                    }
                }, 2000);
            }).catch(async (error: unknown) => {
                // executeBulkLoad catches what it runs, so this is rare (it could not be
                // called at all). Same report, same rule: never silent.
                console.error('[RunBatchWebview] Batch execution failed:', error);
                const failure = this.describeStartFailure(bulkLoadFailure(error));
                if (failure) {
                    await this.reportStartFailure(failure);
                }
            });

        } catch (error) {
            console.error('[RunBatchWebview] Batch preparation failed:', error);
            if (!this.closed) {
                this.session.post({
                    type: 'bulkLoadCommandExecuted',
                    error: `Bulk load failed: ${error instanceof Error ? error.message : 'Unknown error'}`
                });
            }
        }
    }


    /**
     * Handle endpoint save request from CSV handler
     * GitHub Issue #106: MUST save endpoint with updated dataLoadingConfig before execution
     *
     * This was working in the old Endpoint Webview modal, but broke when we moved to Run Batch webview.
     * The CSV handler updates the endpoint with array repetition and error handling settings,
     * then sends saveEndpoint message. The backend needs these settings saved before batch creation.
     */
    /**
     * GitHub Issue #308: plan the batch (data-loading/batch-plan.ts) for Step 4, and give each
     * previewed request the body text it will be sent with — BASE64 fields encoded, as
     * Execute sends them — plus the unencoded text when there was anything to encode.
     */
    private async buildPlanForPreview(
        source: { headers: string[]; rows: string[][] },
        message: RunBatchMessage,
        activeEnvironment: { baseUrl?: string } | undefined,
        environmentVariables: Record<string, string>,
        /** #470: the endpoint as the run will read it (Execute's confirmation): its saved Rows per request, as the run's */
        asRun?: APIEndpointConfig
    ): Promise<BatchPlan> {
        const ui = asRun ? undefined : message.uiArrayConfig;
        const endpoint = asRun || this.endpointConfig;
        const enabled = (endpoint.dataLoadingConfig?.repeatableArrays || []).filter((a: { enabled?: boolean }) => a.enabled);
        const saved = enabled[0];
        // (as the run reads it: the smallest enabled Rows per request, run-orchestrator getArrayRepetitionConfig)
        const runReps = enabled.length ? Math.min(...enabled.map((a: { maxRepetitions: number }) => a.maxRepetitions)) : undefined;
        if (asRun) this.lastPlanArgs = undefined;   // (re-planned from what Review planned, kept below)
        const plan = await planBatch({
            endpoint,
            baseUrl: activeEnvironment?.baseUrl,
            headers: source.headers,
            rows: source.rows,
            mappings: message.mappings || [],
            // Same default as the page (getSavedArrayRepetitionValue): the saved Reps, else 1
            reps: asRun ? (runReps || 1) : (ui?.maxRepetitions || saved?.maxRepetitions || 1),
            arrayPath: ui?.arrayPath || saved?.arrayPath || null,
            queryParamRepetition: message.queryParamRepetition?.enabled ? message.queryParamRepetition : null,
            environmentVariables
        });
        for (const request of plan.requests as Array<PlanRequest & { bodyText?: string; unencodedBodyText?: string }>) {
            if (request.body === null) continue;
            const text = JSON.stringify(request.body, null, 2);
            try {
                const encoded = encodeBase64Fields(text);
                request.bodyText = encoded.encodedJson;
                if (encoded.hasEncodingMarkers) request.unencodedBodyText = encoded.unencodedJson;
                request.size = calculateJsonSize(encoded.encodedJson);
            } catch {
                request.bodyText = text;
            }
        }
        return plan;
    }

    /** GitHub Issue #396: null when the batch started. */
    private describeStartFailure(result: unknown): BatchStartFailure | null {
        return describeBatchStartFailure(result);
    }

    /** GitHub Issue #396: tell the user why the batch did not start. The tab stays open. */
    private async reportStartFailure(failure: BatchStartFailure): Promise<void> {
        try {
            await reportBatchStartFailure(failure, {
                hasPanel: () => !this.closed,
                postToPage: pageMessage => { this.session.post(pageMessage); },
                // The tab is gone: force a native-visible toast so a refused batch is never lost.
            });
        } catch (error) {
            console.error('[RunBatchWebview] Could not report why the batch did not start:', error);
        }
    }

    /**
     * GitHub Issue #307: rename the endpoint's template variables to the columns they were
     * mapped to (TemplateRename), and tell the user what changed. Failure is reported, never
     * thrown: the batch itself has already run.
     */
    private async applyTemplateRenames(endpointId: string, renames: Record<string, string>): Promise<void> {
        try {
            const endpointManager = this.ports.endpoints;
            const endpoint = await endpointManager.getEndpoint(endpointId);
            if (!endpoint) { return; }
            const updated = TemplateRename.renameInEndpoint(endpoint, renames);
            await endpointManager.updateEndpoint(endpointId, updated);
            const list = Object.entries(renames).map(([from, to]) => `${from} → ${to}`).join(', ');
            this.ports.toast.info(`Updated the ${endpoint.name} template: ${list}`);
        } catch (error) {
            console.error('[RunBatchWebview] Could not update the endpoint template:', error);
            this.ports.toast.warn(`The batch ran, but the endpoint template could not be updated: ${error instanceof Error ? error.message : String(error)}`, { forceNative: true });
        }
    }

    private async handleSaveEndpoint(message: RunBatchMessage): Promise<void> {

        try {
            // Validate endpoint data
            if (!message.endpoint) {
                throw new Error('No endpoint data provided in saveEndpoint message');
            }

            const endpointData = message.endpoint;

            // Get endpoint manager from service container
            const endpointManager = this.ports.endpoints;

            // Check if endpoint exists (should always exist in Run Batch context)
            let existingEndpoint = null;
            if (endpointData.id && endpointData.id !== 'new' &&
                endpointData.id !== '{{ENDPOINT_ID}}' && endpointData.id !== 'NEW') {
                existingEndpoint = await endpointManager.getEndpoint(endpointData.id);
            }

            if (!existingEndpoint) {
                throw new Error(`Endpoint not found: ${endpointData.id}`);
            }

            // A dataLoadingConfig from Run Batch carries only what it changed (reps, error
            // handling, the #307 mapping). On an endpoint that has never had one, the schema's
            // required fields would be missing and the save refused — so start from defaults.
            if (endpointData.dataLoadingConfig) {
                endpointData.dataLoadingConfig = {
                    ...createDefaultDataLoadingConfig(),
                    ...(existingEndpoint.dataLoadingConfig || {}),
                    ...endpointData.dataLoadingConfig
                };
            }

            // Save the updated endpoint configuration
            const savedEndpoint = await endpointManager.updateEndpoint(existingEndpoint.id, endpointData);

            // Update our local copy of the endpoint config
            this.endpointConfig = savedEndpoint;

            // Send success response so CSV handler can proceed with execution
            this.session.post({
                type: 'endpointSaved',
                endpoint: savedEndpoint,
                success: true
            });
        } catch (error) {
            console.error('[RunBatchWebview] Failed to save endpoint:', error);
            this.session.post({
                type: 'endpointSaveError',
                error: error instanceof Error ? error.message : 'Unknown error'
            });
        }
    }

    // Delegate handlers to endpoint manager patterns


    private async handleGenerateBulkJson(message: RunBatchMessage): Promise<void> {

        try {
            // Get JSON generator service from container
            const endpointManager = this.ports.endpoints;
            const jsonGenerator = new JsonGenerator(endpointManager);
            const arrayRepetitionHelper = new ArrayRepetitionHelper();

            // GitHub Issue #135: Accept parsed data from frontend to avoid CSV parsing issues
            // Frontend now sends properly parsed data, avoiding issues with quoted values containing commas
            let headers: string[];
            let dataLines: string[];
            let dataRows: string[][];

            if (message.parsedData && message.parsedData.headers && message.parsedData.rows && message.parsedData.rows.length > 0) {
                // Use pre-parsed data from frontend (preferred path)
                headers = message.parsedData.headers;
                dataRows = message.parsedData.rows;

                // Apply source format conversions before JSON generation
                dataRows = applySourceFormatConversions(dataRows, headers, message.mappings || []);

                // Convert rows back to CSV lines format for compatibility with existing code
                dataLines = dataRows.map(row => row.join(','));
            } else {
                // Fallback: Parse CSV data (legacy path, kept for backward compatibility)
                const csvDataString = typeof message.csvData === 'string' ? message.csvData : '';
                if (!csvDataString) {
                    throw new Error('No CSV data provided');
                }

                const lines = csvDataString.split('\n');
                headers = lines[0].split(',').map((h: string) => h.trim().replace(/"/g, ''));
                dataLines = lines.slice(1).filter((line: string) => line.trim().length > 0);
                dataRows = dataLines.map(line => line.split(',').map(v => v.trim().replace(/"/g, '')));
            }

            if (dataLines.length === 0) {
                throw new Error('No data rows found in CSV file');
            }

            // Use UI array config if provided, otherwise use saved endpoint config
            let repeatableArrays = this.endpointConfig.dataLoadingConfig?.repeatableArrays || [];

            // Override with UI config if provided (for preview purposes)
            if (message.uiArrayConfig) {
                repeatableArrays = [{
                    arrayPath: message.uiArrayConfig.arrayPath,
                    enabled: true,
                    maxRepetitions: message.uiArrayConfig.maxRepetitions
                }];
            }

            // GitHub Issue #165: Get environment variables for {{ENV:varName}} substitution in preview
            const environmentManager = this.ports.environments;
            const activeEnvironment = await environmentManager.getActiveEnvironment();
            const environmentVariables = activeEnvironment?.variables || {};

            const options = {
                template: this.endpointConfig.body || '{}',
                mappings: message.mappings || [],
                headers: headers,
                repeatableArrays: repeatableArrays,
                endpointId: this.endpointId,
                sequenceStartValue: 1001,
                environmentVariables: environmentVariables // GitHub Issue #165: ENV variable substitution
            };

            // GitHub Issue #308: the batch plan — what Step 4 shows for EVERY endpoint shape:
            // counts, the first 5 requests (body or URL, with their input rows) and the ⓘ.
            // Built from every row (countData when parsedData is only a preview sample),
            // with the source-format conversions Execute applies.
            const planRowsSource = message.countData?.headers && message.countData.rows?.length
                ? { headers: message.countData.headers, rows: applySourceFormatConversions(message.countData.rows, message.countData.headers, message.mappings || []) }
                : { headers, rows: dataRows };
            const plan = await this.buildPlanForPreview(planRowsSource, message, activeEnvironment, environmentVariables);
            // #470: the plan Review shows; Execute's confirmation plans again from the same rows as the run will send them
            this.lastPlan = plan;
            this.lastPlanArgs = { source: planRowsSource, message, environment: activeEnvironment, variables: environmentVariables };
            const rawBody = (this.endpointConfig.body || '').trim();
            const bodyText = rawBody ? stripJsonCommentsSafe(rawBody).trim() : '';
            if (!bodyText || bodyText === '{}') {
                // No body: the URL is the request. Nothing for the JSON preview path to build.
                this.session.post({ type: 'bulkJsonGenerated', mode: 'preview', plan, jsonPreview: '', detectedArrays: [] });
                return;
            }

            // GitHub Issue #119: Check for nested arrays in template
            const nestedAnalysis = (jsonGenerator as any).analyzeNestedArrays(options.template);

            // Check if array repetition is enabled
            const hasArrayRepetition = options.repeatableArrays &&
                options.repeatableArrays.length > 0 &&
                options.repeatableArrays.some((arr: any) => arr.enabled);

            let result;
            let previewGroups: string[][][] | undefined; // For nested mode metadata

            // GitHub Issue #119: Route to nested array generation if detected
            // GitHub Issue #134: Also allow when outerVariables is empty but middleVariables exists (static wrapper)
            const hasOuterVariables = nestedAnalysis.outerVariables && nestedAnalysis.outerVariables.length > 0;
            const hasMiddleVariables = nestedAnalysis.middleVariables && nestedAnalysis.middleVariables.length > 0;
            if (nestedAnalysis.hasNestedArrays && (hasOuterVariables || hasMiddleVariables)) {
                // GitHub Issue #135: Use dataRows directly instead of re-parsing dataLines
                // GitHub Issue #148: Backend auto-sort removed - frontend handles sorting before Step 3
                const csvDataArray = [headers, ...dataRows];

                // For preview: limit to first N groups (where N = reps or default 3)
                const maxGroupsToShow = message.uiArrayConfig?.maxRepetitions || 3;

                // Route based on nesting level (GitHub Issue #119 - Extended for 3 levels)
                if (nestedAnalysis.nestingLevel === 3) {
                    // 3-level nesting: shipments[].packages[].items[]
                    // generate3LevelNestedArrayJson handles grouping internally
                    // For preview: limit CSV to approximate row count
                    const previewCsvData = [headers, ...csvDataArray.slice(1, maxGroupsToShow * 10)]; // Estimate ~10 rows per group
                    result = await (jsonGenerator as any).generate3LevelNestedArrayJson(previewCsvData, options);

                } else if (nestedAnalysis.nestingLevel === 2) {
                    // 2-level nesting: orders[].items[]
                    // Need to pre-group CSV rows by outer variable
                    // Bug fix: Translate template variable name to mapped CSV column name
                    // Same rule as execution: a new group when ANY variable at the level changes
                    // (JsonGenerator.groupingColumnsFor).
                    const groupByColumns = groupingColumnsForPreview(nestedAnalysis.outerVariables, message.mappings);
                    const csvGroups = arrayRepetitionHelper.groupRowsByFieldValues(
                        csvDataArray,
                        groupByColumns
                    );
                    previewGroups = csvGroups.slice(0, Math.min(maxGroupsToShow, csvGroups.length));
                    result = await (jsonGenerator as any).generateNestedArrayJson(previewGroups, options);

                } else if (nestedAnalysis.nestingLevel === 1) {
                    // GitHub Issue #140: 1-level array with root grouping variables
                    // Template like: { "dest": "{{dest}}", "OriginalOrderLine": [...] }
                    const csvGroups = arrayRepetitionHelper.groupRowsByFieldValues(
                        csvDataArray,
                        groupingColumnsForPreview(nestedAnalysis.outerVariables, message.mappings)
                    );
                    const limitedGroups = csvGroups.slice(0, Math.min(maxGroupsToShow, csvGroups.length));
                    previewGroups = limitedGroups;

                    // Use generateBatchJsonFiles which handles level 1, then extract first result for preview
                    const previewCsv = [headers.join(','), ...limitedGroups.flatMap((g: string[][]) => g.slice(1).map((r: string[]) => r.join(',')))].join('\n');
                    const batchResult = await jsonGenerator.generateBatchJsonFiles(previewCsv, options);
                    if (batchResult.success && batchResult.files.length > 0) {
                        result = { success: true, jsonData: batchResult.files[0].content };
                    } else {
                        throw new Error(batchResult.error || 'Failed to generate 1-level preview');
                    }

                } else {
                    throw new Error(`Unsupported nesting level: ${nestedAnalysis.nestingLevel}`);
                }

            } else if (hasArrayRepetition) {
                // Flat array repetition (existing logic)
                const maxRepetitions = Math.max(...options.repeatableArrays!.filter((arr: any) => arr.enabled).map((arr: any) => arr.maxRepetitions));
                const previewRows = dataLines.slice(0, Math.min(maxRepetitions, dataLines.length));
                result = await jsonGenerator.generateConsolidatedJson(previewRows, options);
            } else {
                // Single row preview
                result = await jsonGenerator.generateSingleRowJson(dataLines[0], options);
            }

            if (!result.success) {
                throw new Error(result.error || 'Failed to generate JSON preview');
            }

            // Run template analysis to detect arrays and variables (GitHub Issue #106)
            const templateParser = new TemplateParser();
            const detectedArrays = templateParser.detectArrays(this.endpointConfig.body || '{}');
            const detectedVariables = templateParser.extractVariables(this.endpointConfig.body || '{}');

            // GitHub Issue #279: Flag which arrays are actually data-driven.
            // An array whose element template contains no {{variable}} placeholders
            // (e.g. AsnRequestedService — three hard-coded fields) can't be driven by
            // CSV rows; repeating it just clones an identical static block. These are
            // filtered out of the Step 4 array picker so they can't be auto-selected.
            const arrayVariableFlags = this.computeArrayVariableFlags(this.endpointConfig.body || '{}');

            // GitHub Issue #279: A fixed "Reps" count is meaningless for 1-level
            // root-grouping arrays — each unique group becomes exactly one request
            // regardless of the value (see JsonGenerator nestingLevel===1 branch, which
            // ignores maxRepetitions). Flag those so the UI can hide the Reps input and
            // only offer it where it actually changes the output (flat repeatable arrays,
            // and multi-level nesting where reps batch groups per file).
            const isRootGrouping = nestedAnalysis.hasNestedArrays && nestedAnalysis.nestingLevel === 1;
            for (const arrayInfo of detectedArrays) {
                (arrayInfo as any).hasItemVariables = arrayVariableFlags[arrayInfo.path] === true;
                (arrayInfo as any).repsApplicable = !(isRootGrouping && arrayInfo.path === nestedAnalysis.outerArray);
            }

            // Send preview result with template analysis (GitHub Issue #106)
            // Convert JSON object to formatted string for display
            const jsonPreviewString = typeof result.jsonData === 'string'
                ? result.jsonData
                : JSON.stringify(result.jsonData, null, 2);

            // GitHub Issue #127: Apply BASE64 encoding for preview
            let encodedPreview = jsonPreviewString;
            let unencodedPreview = jsonPreviewString;
            let hasEncodingMarkers = false;
            let encodedSize = calculateJsonSize(jsonPreviewString);
            let unencodedSize = encodedSize;

            try {
                const encodingResult = encodeBase64Fields(jsonPreviewString);
                encodedPreview = encodingResult.encodedJson;
                unencodedPreview = encodingResult.unencodedJson;
                hasEncodingMarkers = encodingResult.hasEncodingMarkers;
                encodedSize = calculateJsonSize(encodedPreview);
                unencodedSize = calculateJsonSize(unencodedPreview);
            } catch (encodingError) {
                console.error('[RunBatchWebview] BASE64 encoding failed:', encodingError);
                // Continue with unencoded preview - don't block user
            }

            // GitHub Issue #119: Include nested mode info for accurate API call calculation
            const responseMessage: any = {
                type: 'bulkJsonGenerated',
                mode: 'preview',
                jsonPreview: encodedPreview,         // Default: show encoded (what gets sent to API)
                unencodedPreview: unencodedPreview,  // For toggle (debug view)
                hasEncodingMarkers: hasEncodingMarkers,
                encodedSize: formatFileSize(encodedSize),
                unencodedSize: formatFileSize(unencodedSize),
                detectedArrays: detectedArrays,
                detectedVariables: detectedVariables,
                plan
            };

            // Add nested mode metadata if applicable
            if (nestedAnalysis.hasNestedArrays) {
                // GitHub Issue #135: Use dataRows directly
                const csvDataArray = [headers, ...dataRows];
                // Count on EVERY row. dataRows can be a type-converted sample (the frontend's
                // first 50) — right for the preview JSON, wrong for "Total API calls": a
                // sorted file's first 50 rows are often one group. countData is the whole file.
                const countRows = message.countData?.headers && message.countData.rows?.length
                    ? [message.countData.headers, ...applySourceFormatConversions(message.countData.rows, message.countData.headers, message.mappings || [])]
                    : csvDataArray;

                // Root-variable grouping fix: for 2-level/3-level nesting, root-level CSV
                // variables above the outer array each produce their own set of calls.
                let rootVariables: string[] = [];
                if (nestedAnalysis.nestingLevel >= 2) {
                    try {
                        const parsedTemplate = JSON.parse(options.template);
                        const outerArrayName = nestedAnalysis.outerArray || Object.keys(parsedTemplate).find(k => Array.isArray(parsedTemplate[k]));
                        if (outerArrayName) {
                            rootVariables = (jsonGenerator as any).extractVariablesFromObject(parsedTemplate, [outerArrayName]);
                        }
                    } catch {
                        // If parsing fails, count without root groups
                    }
                }

                // Calculate actual maxGroupsToShow used (same logic as preview generation)
                const actualMaxGroupsShown = message.uiArrayConfig?.maxRepetitions || 3;

                // Group on EVERY variable at the level (nested-call-count.ts), like the
                // preview above and execution.
                const count = countNestedCalls({
                    analysis: nestedAnalysis,
                    csvData: countRows,
                    mappings: message.mappings,
                    rootVariables,
                    maxGroupsShown: actualMaxGroupsShown,
                    groupRows: (csv, columns) => arrayRepetitionHelper.groupRowsByFieldValues(csv, columns)
                });

                // For 3-level nesting, use metadata from result; for 2-level, use previewGroups
                const groupsInPreview = nestedAnalysis.nestingLevel === 3
                    ? (result.metadata?.nestingLevel === 3 ? Math.min(actualMaxGroupsShown, count.totalGroups) : 0)
                    : (previewGroups?.length || 0);

                responseMessage.nestedMode = {
                    enabled: true,
                    nestingLevel: nestedAnalysis.nestingLevel,
                    groupingColumn: count.groupingVariable,
                    groupingVariables: count.groupingVariables,
                    totalRows: countRows.length - 1,
                    totalGroups: count.totalGroups,
                    totalTransactions: count.totalTransactions,  // GitHub Issue #150: Single source of truth
                    groupsInPreview: groupsInPreview,
                    maxGroupsShown: actualMaxGroupsShown,
                    estimatedApiCalls: count.totalTransactions  // Use accurate count
                };
            }

            this.session.post(responseMessage);

        } catch (error) {
            console.error('[RunBatchWebview] Bulk JSON generation failed:', error);
            this.session.post({
                type: 'bulkJsonGenerated',
                error: `Failed to generate bulk JSON: ${error instanceof Error ? error.message : 'Unknown error'}`
            });
        }
    }

    // GitHub Issue #226: CSV parsing + mismatch detection live in
    // src/utils/csv-mismatch.ts (testable). Thin instance-method delegators
    // are kept so existing call sites (e.g. handleParseCSVForModal) compile
    // unchanged.
    /**
     * GitHub Issue #279: Determine which detected arrays are data-driven.
     *
     * Walks the JSON template the same way TemplateParser.detectArrays() does
     * (identical path construction) and, for each array, records whether its
     * element subtree contains at least one {{...}} placeholder. Arrays whose
     * element is entirely static (e.g. AsnRequestedService) map to `false` and
     * are hidden from the Step 4 array picker — they can't be grouped/repeated
     * from CSV data, so offering them only invites the wrong auto-selection.
     *
     * @param body - The endpoint JSON body template
     * @returns Map of array path -> hasItemVariables
     */
    private computeArrayVariableFlags(body: string): Record<string, boolean> {
        const flags: Record<string, boolean> = {};
        const ROOT_ARRAY_PATH = '$root';
        const placeholderPattern = /\{\{[^}]*\}\}/;

        let parsed: unknown;
        try {
            parsed = JSON.parse(body);
        } catch {
            return flags;
        }

        const walk = (value: unknown, currentPath: string): void => {
            if (Array.isArray(value)) {
                const effectivePath = currentPath || ROOT_ARRAY_PATH;
                const element = value.length > 0 ? value[0] : undefined;
                // Stringify the element subtree: any placeholder anywhere within it
                // (including nested arrays) makes this array a valid grouping target.
                flags[effectivePath] = element !== undefined
                    && placeholderPattern.test(JSON.stringify(element));

                if (value.length > 0) {
                    walk(value[0], `${effectivePath}[]`);
                }
            } else if (value && typeof value === 'object') {
                for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
                    walk(child, currentPath ? `${currentPath}.${key}` : key);
                }
            }
        };

        walk(parsed, '');
        return flags;
    }

    private detectDelimiter(content: string): CsvDelimiter {
        return csvDetectDelimiter(content);
    }

    private parseCSVLine(line: string, delimiter: CsvDelimiter = ','): string[] {
        return csvParseLine(line, delimiter);
    }

    private parseCSVContent(csvContent: string, delimiter?: CsvDelimiter) {
        return csvParseContent(csvContent, delimiter);
    }

    private detectColumnMismatches(csvData: string) {
        return csvDetectColumnMismatches(csvData);
    }

    private async handleGetCurrentEnvironment(): Promise<void> {
        try {
            const environmentManager = this.ports.environments;
            const activeEnvironment = await environmentManager.getActiveEnvironment();

            // #424: with the variables its header shows, for the confirm step's "Sending To".
            // isProduction by the same rule as Execute's confirmation, so Review's warning and
            // the confirmation can't disagree.
            this.session.post({
                type: 'currentEnvironmentData',
                environment: activeEnvironment,
                isProduction: isProductionEnvironment(activeEnvironment),
                headerVariables: activeEnvironment ? await environmentManager.getHeaderVariables(activeEnvironment.id).catch(() => []) : []
            });
        } catch (error) {
            console.error('[RunBatchWebview] Failed to get current environment:', error);
        }
    }



    /**
     * Handle file format detection
     */
    private async handleDetectFileFormat(message: RunBatchMessage): Promise<void> {

        try {
            // Delegate to format converter service (get from service container)
            const formatConverter = this.ports.formatConverter;

            let buffer: Uint8Array;
            if (typeof message.fileData === 'object' && (message.fileData as any) instanceof ArrayBuffer) {
                buffer = new Uint8Array(message.fileData as ArrayBuffer);
            } else if (typeof message.fileData === 'string') {
                buffer = new TextEncoder().encode(message.fileData);
            } else {
                throw new Error('Unsupported file data format');
            }
            // An .xlsx is a zip. Anything else under that name (text renamed .xlsx) would be read
            // by the spreadsheet library as a sheet of its text: say it isn't Excel instead.
            if (/\.xlsx$/i.test(message.fileName || '') && !(buffer[0] === 0x50 && buffer[1] === 0x4b)) {
                throw new Error('Not an Excel workbook (an .xlsx file is a zip)');
            }
            const perfT2 = performance.now();
            const result = await formatConverter.detectFormat(message.fileName || 'unknown', buffer);
            console.log(`[PERF #224] T2-T3 detectFormat: ${Math.round(performance.now() - perfT2)}ms`);

            this.session.post({
                type: 'formatDetected',
                format: result.format,
                confidence: result.confidence,
                metadata: result.metadata,
                fileName: message.fileName,
                fileSize: message.fileSize
            });

        } catch (error) {
            console.error('[RunBatchWebview] Format detection failed:', error);
            this.session.post({
                type: 'formatDetected',
                error: `Failed to detect file format: ${error instanceof Error ? error.message : String(error)}`
            });
        }
    }

    /**
     * Handle file format conversion to CSV
     */
    private async handleConvertFileFormat(message: RunBatchMessage): Promise<void> {

        try {
            // Delegate to format converter service
            const formatConverter = this.ports.formatConverter;

            let buffer: Uint8Array | string;
            if (typeof message.fileData === 'object' && (message.fileData as any) instanceof ArrayBuffer) {
                buffer = new Uint8Array(message.fileData as ArrayBuffer);
            } else if (typeof message.fileData === 'string') {
                buffer = message.fileData;
            } else {
                throw new Error('Unsupported file data format');
            }

            // Map format string to enum
            let format: any;
            switch (message.fileFormat?.toLowerCase()) {
                case 'csv':
                    format = SupportedFormat.CSV;
                    break;
                case 'excel':
                    format = SupportedFormat.EXCEL;
                    break;
                case 'tsv':
                    format = SupportedFormat.TSV;
                    break;
                case 'custom':
                    format = SupportedFormat.CUSTOM_DELIMITED;
                    break;
                default:
                    throw new Error(`Unsupported format: ${message.fileFormat}`);
            }

            const perfT6 = performance.now();
            const result = await formatConverter.convertToCSV(buffer, format, message.options || {});
            console.log(`[PERF #224] T6-T7 convertToCSV: ${Math.round(performance.now() - perfT6)}ms`);

            // GitHub Issue #226: Detect column-count mismatches on the converted CSV.
            // The file-upload path previously skipped this check entirely because
            // the frontend short-circuited using `preview` and never re-parsed.
            const columnMismatch = this.detectColumnMismatches(result.csvData);

            this.session.post({
                type: 'formatConversionComplete',
                csvData: result.csvData,
                preview: result.preview,
                metadata: result.metadata,
                columnMismatch: columnMismatch
            });

        } catch (error) {
            console.error('[RunBatchWebview] Format conversion failed:', error);
            this.session.post({
                type: 'formatConversionError',
                error: `Failed to convert file format: ${error instanceof Error ? error.message : String(error)}`
            });
        }
    }


    /**
     * Handle CSV parsing for modal display
     */
    private async handleParseCSVForModal(message: RunBatchMessage): Promise<void> {

        try {
            // Ensure csvData is a string
            const csvDataString = typeof message.csvData === 'string' ? message.csvData : '';
            if (!csvDataString) {
                throw new Error('CSV data is not a string');
            }

            // GitHub Issue #135: Use proper CSV parsing that honors quoted values
            const { headers, rows } = this.parseCSVContent(csvDataString);

            // GitHub Issue #226: Centralised mismatch detection — paste path
            const columnMismatch = this.detectColumnMismatches(csvDataString);

            const preview = {
                headers: headers,
                rows: rows
            };

            const templateVariables = this.extractTemplateVariables(this.endpointConfig);

            this.session.post({
                type: 'csvModalParsed',
                fileName: message.fileName,
                fileSize: message.fileSize,
                rowCount: rows.length,
                columnCount: headers.length,
                preview: preview,
                templateVariables: templateVariables,
                columnMismatch: columnMismatch
            });

        } catch (error) {
            console.error('[RunBatchWebview] CSV parsing failed:', error);
            this.session.post({
                type: 'csvModalParsed',
                error: `Failed to parse CSV: ${error instanceof Error ? error.message : String(error)}`
            });
        }
    }


    /**
     * Handle type transformations for CSV data
     */
    private async handleApplyTypeTransformations(message: RunBatchMessage): Promise<void> {

        try {
            // Ensure csvData is a string
            const csvDataString = typeof message.csvData === 'string' ? message.csvData : '';
            if (!csvDataString) {
                throw new Error('CSV data is not a string');
            }

            const formatConverterService = this.ports.formatConverter;

            // Convert object back to Map for the service
            const typeOverrides = new Map();
            if (message.columnTypes && typeof message.columnTypes === 'object') {
                Object.entries(message.columnTypes).forEach(([key, value]) => {
                    typeOverrides.set(key, value);
                });
            }

            // GitHub Issue #106: csvData already sampled by frontend before sending
            const result = await formatConverterService.applyDataTransformations(csvDataString, typeOverrides);

            this.session.post({
                type: 'typeTransformationCompleted',
                transformedData: result,
                metadata: {} // No metadata returned from current implementation
            });

        } catch (error) {
            console.error('[RunBatchWebview] Type transformations failed:', error);
            this.session.post({
                type: 'typeTransformationsError',
                error: `Failed to apply transformations: ${error instanceof Error ? error.message : String(error)}`
            });
        }
    }

    /**
     * Handle CSV compatibility verification
     */
    private async handleVerifyCSVCompatibility(message: RunBatchMessage): Promise<void> {

        try {
            // Ensure csvData is a string
            const csvDataString = typeof message.csvData === 'string' ? message.csvData : '';
            if (!csvDataString) {
                throw new Error('CSV data is not a string');
            }

            // Parse CSV headers
            const lines = csvDataString.split('\n');
            const headers = lines[0].split(',').map((h: string) => h.trim().replace(/"/g, ''));
            const dataLines = lines.slice(1).filter((line: string) => line.trim().length > 0);

            // GitHub Issue #123: Validate row count against config
            const maxCsvRows = this.ports.settings.get('dbmn', 'execution.maxCsvRows', 100000);

            // GitHub Issue #247: no cap on chained rows. Chain exists so big results need no
            // clipboard or file; its rows are this Run Batch's only possible input.
            if (!this.chain && dataLines.length > maxCsvRows) {
                // Send error - too many rows
                this.session.post({
                    type: 'csvCompatibilityError',
                    error: `CSV file is too large (${dataLines.length.toLocaleString()} rows). Please limit to ${maxCsvRows.toLocaleString()} rows or fewer. You can adjust this limit in Settings > DBMN > Execution > Max CSV Rows.`
                });
                return;
            }

            // Extract template variables from endpoint config
            const templateVariables = this.extractTemplateVariables(this.endpointConfig);

            // Perform auto-mapping
            const mappingStatus = {
                variables: templateVariables.map(variable => {
                    // First try exact case match
                    let matchedColumn = headers.find((header: string) => header === variable.name);

                    // If no exact match, try case-insensitive match
                    if (!matchedColumn) {
                        matchedColumn = headers.find((header: string) =>
                            header.toLowerCase().includes(variable.name.toLowerCase()) ||
                            variable.name.toLowerCase().includes(header.toLowerCase())
                        );
                    }

                    return {
                        name: variable.name,
                        dataType: variable.dataType,
                        mapped: !!matchedColumn,
                        column: matchedColumn || null,
                        // GitHub Issue #175: Include formatModifier for warning filtering
                        formatModifier: variable.formatModifier,
                        sources: variable.sources,
                        bodyPath: variable.bodyPath
                    };
                })
            };

            // Calculate API call estimation
            const hasArrayRepetition = this.endpointConfig.dataLoadingConfig?.repeatableArrays &&
                this.endpointConfig.dataLoadingConfig.repeatableArrays.length > 0 &&
                this.endpointConfig.dataLoadingConfig.repeatableArrays.some((arr: any) => arr.enabled);

            const maxRepetitions = hasArrayRepetition && this.endpointConfig.dataLoadingConfig?.repeatableArrays ?
                Math.max(...this.endpointConfig.dataLoadingConfig.repeatableArrays.filter((arr: any) => arr.enabled).map((arr: any) => arr.maxRepetitions)) : 100;

            let calculatedApiCalls = hasArrayRepetition ? Math.ceil(dataLines.length / maxRepetitions) : dataLines.length;

            // Root-variable grouping: improve estimation for nested templates with root CSV variables
            // For 2-level/3-level nesting, root variables create separate transactions per unique root value
            try {
                const tempJsonGen = new JsonGenerator();
                const nestedCheck = (tempJsonGen as any).analyzeNestedArrays(this.endpointConfig.body || '{}');

                if (nestedCheck.hasNestedArrays && nestedCheck.nestingLevel >= 2 && nestedCheck.outerArray) {
                    const parsedTpl = JSON.parse(this.endpointConfig.body || '{}');
                    const rootVars = (tempJsonGen as any).extractVariablesFromObject(parsedTpl, [nestedCheck.outerArray]);

                    if (rootVars.length > 0) {
                        // Find root variable's column in CSV headers
                        const rootVarName = rootVars[0];
                        const rootColIdx = headers.indexOf(rootVarName);
                        if (rootColIdx !== -1) {
                            const uniqueRootValues = new Set(dataLines.map((line: string) => {
                                const vals = line.split(',').map((v: string) => v.trim().replace(/"/g, ''));
                                return vals[rootColIdx] || '';
                            }));
                            // Each unique root value produces at least 1 transaction
                            calculatedApiCalls = Math.max(calculatedApiCalls, uniqueRootValues.size);
                        }
                    }
                }
            } catch {
                // If nesting analysis fails, keep original estimate
            }

            const apiCallEstimation = {
                totalRows: dataLines.length,
                apiCalls: calculatedApiCalls,
                arrayRepetition: hasArrayRepetition,
                elementsPerCall: maxRepetitions
            };

            // Get current environment info
            const environmentManager = this.ports.environments;
            const activeEnvironment = await environmentManager.getActiveEnvironment();
            const executionInfo = {
                environment: activeEnvironment?.name || 'Unknown',
                environmentId: activeEnvironment?.id || undefined,
                rowCount: dataLines.length,
                apiCalls: apiCallEstimation.apiCalls
            };

            // Send verification result to webview
            this.session.post({
                type: 'csvCompatibilityVerified',
                mappingStatus: mappingStatus,
                apiCallEstimation: apiCallEstimation,
                executionInfo: executionInfo,
                endpointConfig: {
                    id: this.endpointId,
                    name: this.endpointConfig.name,
                    path: this.endpointConfig.path,
                    method: this.endpointConfig.method,
                    headers: this.endpointConfig.headers || {},
                    queryParams: this.endpointConfig.queryParams || {},
                    body: this.endpointConfig.body || '{}',
                    folder: this.endpointConfig.folder,
                    dataLoadingConfig: this.endpointConfig.dataLoadingConfig
                }
            });

        } catch (error) {
            console.error('[RunBatchWebview] CSV compatibility verification failed:', error);
            this.session.post({
                type: 'csvCompatibilityError',
                error: `Failed to verify CSV compatibility: ${error instanceof Error ? error.message : String(error)}`
            });
        }
    }


    // ========================================================================
    // GitHub Issue #135: Coercion Validation Handlers
    // ========================================================================

    /**
     * Handle sample coercion validation
     * Used for instant feedback when user selects a column mapping
     */
    private async handleValidateSampleCoercion(message: RunBatchMessage): Promise<void> {

        try {
            const formatConverterService = this.ports.formatConverter;

            const result = formatConverterService.validateSampleCoercion(
                message.columnName || '',
                (message.targetType || 'string') as TargetDataType,
                (message.sourceFormat || 'standard') as SourceFormat,
                message.sampleValues || []
            );

            this.session.post({
                type: 'sampleCoercionResult',
                variableIndex: message.variableIndex,
                ...result
            });

        } catch (error) {
            console.error('[RunBatchWebview] Sample coercion validation failed:', error);
            this.session.post({
                type: 'sampleCoercionResult',
                variableIndex: message.variableIndex,
                success: false,
                overallStatus: 'error',
                error: error instanceof Error ? error.message : 'Unknown error'
            });
        }
    }

    /**
     * Handle full coercion validation
     * Used when user clicks "Next" to validate ALL rows
     */
    private async handleValidateFullCoercion(message: RunBatchMessage): Promise<void> {

        try {
            const formatConverterService = this.ports.formatConverter;

            // Build validation request
            const validationRequest = {
                mappings: (message.validationMappings || []).map(m => ({
                    variableName: m.variableName,
                    csvColumn: m.csvColumn,
                    targetType: m.targetType as any,
                    sourceFormat: m.sourceFormat as any
                })),
                rows: message.rows || [],
                headers: message.headers || []
            };

            const result = formatConverterService.validateFullCoercion(validationRequest);
            this.session.post({
                type: 'fullCoercionResult',
                ...result
            });

        } catch (error) {
            console.error('[RunBatchWebview] Full coercion validation failed:', error);
            this.session.post({
                type: 'fullCoercionResult',
                success: false,
                overallStatus: 'error',
                totalRows: 0,
                rowsWithErrors: 0,
                columnResults: [],
                skipRowIndices: [],
                error: error instanceof Error ? error.message : 'Unknown error'
            });
        }
    }

    /**
     * GitHub Issue #148: Analyze template for nested arrays and check if CSV data needs sorting
     */
    private async handleAnalyzeNestedArraySorting(message: any): Promise<void> {

        try {
            // GitHub Issue #223: Only analyze template structure — no CSV data needed
            const analysis = this.csvSortingService.analyzeNestedArrayRequirements(
                message.templateBody,
                message.mappedColumns,
                message.variableToColumn
            );

            this.session.post({
                type: 'sortingAnalysisResult',
                requiresSorting: analysis.requiresSorting,
                sortColumns: analysis.sortColumns,
                arrayPaths: analysis.arrayPaths,
                explanation: analysis.explanation
            });
        } catch (error) {
            console.error('[RunBatchWebview] Error analyzing nested array sorting:', error);
            this.session.post({
                type: 'sortingAnalysisResult',
                requiresSorting: false,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    /**
     * GitHub Issue #148: Get detailed explanation of why sorting is needed
     */
    private async handleGetSortingExplanation(message: any): Promise<void> {

        const explanation = this.csvSortingService.getSortingExplanation(
            message.sortColumns || [],
            message.arrayPaths || []
        );

        this.session.post({
            type: 'sortingExplanation',
            explanation
        });
    }
}
