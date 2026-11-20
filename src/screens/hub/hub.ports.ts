// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * What the Hub needs from its host. The catalogue managers themselves are core: VS Code gives
 * them its globalState and secrets, the web app gives them the Supabase catalogue. The rest is
 * what only a host can do (run, sign in, files, VS Code commands); a host leaves out what it
 * doesn't have.
 */
import type { WhatsNew } from '../../services/release-notes/whats-new';
import type { APIEndpointConfig } from '../../apiConfigManager';
import type { APIEndpointManager } from '../../apiEndpointManager';
import type { EnvironmentManager } from '../../environmentManager';
import type { SystemManager } from '../../systemManager';
import type { Disposable } from '../../platform/events';
import type { IWritableConfiguration } from '../../platform/interfaces/configuration.interface';
import type { ChainHandoff } from '../../services/chain/chain-types';
import type { CompareState } from '../../services/compare/compare-store';
import type { IExecutionMetadataService } from '../../services/execution/execution-metadata.interface';
import type { HubPreferencesService } from '../../services/hub-preferences/hub-preferences.service';
import type { ResumeChoice } from '../console/batch-resume';
import type { NewEnvironmentDraft } from '../new-environment-prompt';
import type { RecentEndpointsService } from '../../services/recent-endpoints/recent-endpoints.service';
import type { CatalogueStorageInfo } from '../../services/catalogue/catalogue-location';
import type { DbmnModalSpec, DbmnModalResult } from '../modal.types';
import type { QueryFileStore } from '../../services/query/query-file-store';
import type { LookupFolder } from '../../services/lookup-tables/lookup-tables';

/** The Hub's side of an embedded tab: posts into the tab's page, or closes the tab. */
export interface TabChannel {
    readonly tabId: string;
    post(message: Record<string, unknown>): void;
    /** The tab asks to go (e.g. its report was deleted): same as the user closing it. */
    close(): void;
    /** A modal over the Hub, for a tab whose own page can't host one. */
    showModal(spec: DbmnModalSpec): Promise<DbmnModalResult>;
}

/** A screen open in a Hub tab. */
export interface HubTab {
    /** The tab's page, for the Hub to mount in an iframe. */
    html: string;
    handle(message: Record<string, unknown>): Promise<void>;
    /** The tab's page is listening (`__embeddedReady__`). */
    ready?(): void;
    dispose(): void;
}

export interface ConsoleTab extends HubTab {
    name: string;
    status?: string;
    /** The endpoint that ran: its Run Batch tab gives way to the Console. */
    endpointId?: string;
}

export interface BatchTab extends HubTab {
    /** GitHub Issue #247: chain new rows into an open Run Batch. */
    applyChain?(chain: ChainHandoff): void;
}

/** Builds the screens the Hub opens as tabs, each wired to the host's services. */
export interface HubTabFactory {
    endpoint(config: { itemId: string; duplicateFromId?: string }, channel: TabChannel): Promise<HubTab>;
    /** A new environment opens with what the New environment dialog asked for (#415). */
    environment(config: { itemId?: string; draft?: NewEnvironmentDraft }, channel: TabChannel): Promise<HubTab>;
    batch?(config: { endpoint: APIEndpointConfig; chain?: ChainHandoff }, channel: TabChannel): Promise<BatchTab>;
    console?(config: { executionId: string; isBatch: boolean }, channel: TabChannel): Promise<ConsoleTab>;
    /** #298: a saved compare (compare-store), opened on Results, Match or its Edit dialog. */
    compare?(config: { compareId: string; endpointName: string; start?: 'results' | 'match' | 'edit' }, channel: TabChannel): Promise<HubTab>;
    /** The design system's page (design-system-page.ts): the reference for building screens, no data of its own. */
    design?(channel: TabChannel): Promise<HubTab>;
    /** Dobermann issue 7: the Logs screen (src/screens/logs), one tab, opened on a search when asked. */
    logs?(config: { search?: string }, channel: TabChannel): Promise<LogsTab>;
    /** A lookup table (src/screens/lookup): its rows and columns, kept as they are typed. `renamed`: its tab follows a rename. */
    lookup?(config: { id: string; name: string; renamed?(name: string): void }, channel: TabChannel): Promise<LookupTab>;
}

export interface LookupTab extends HubTab {
    /** Renamed from the Hub's list while open: its screen keeps the name. */
    rename?(name: string): Promise<void> | void;
}

export interface LogsTab extends HubTab {
    /** Already open, asked for again with a search (Show in Logs). */
    search?(text: string): void;
}

export interface SerializedHubTab {
    type: 'endpoint' | 'environment' | 'batch' | 'console' | 'batchConsole' | 'compare' | 'design' | 'logs' | 'lookup' | 'page';
    refId: string;
    name?: string;
    /** Had unsaved changes when captured: restoring can't bring the edits back, so say so. */
    dirty?: boolean;
}

export interface HubTabsSnapshot {
    tabs: SerializedHubTab[];
    activeTabId: string | null;
}

/** A Hub section run by its own delegate (Account, Import/Export). */
export interface HubSection {
    /** The section's frontend has loaded. */
    ready(): Promise<void>;
    /** The user is looking at it now (Account defers its stats until then). */
    shown?(): Promise<void>;
    handle(message: Record<string, unknown>): Promise<void>;
}

export interface HubAuth {
    isSignedIn(): boolean;
    /**
     * GitHub Issue #396: signed in, but the session can no longer refresh. Nothing stops
     * working; the header says so, so
     * signing in again happens at a quiet moment and not in the middle of a batch.
     */
    sessionExpired?(): boolean;
    onChanged?(listener: () => void): Disposable;
    /** Signed out and asked to run: the in-app sign-in. */
    promptSignIn(): Promise<void>;
}

/** Runs: History's controls and the transactions list. */
export interface HubExecutions {
    metadata: Pick<IExecutionMetadataService, 'getAllTransactions' | 'getExecution' | 'getBatchMemberExecutions' | 'deleteExecutions' | 'searchExecutionBodies' | 'onExecutionChanged'> & Partial<Pick<IExecutionMetadataService, 'updateExecution'>>;
    pause(id: string): Promise<void>;
    /** Issue #311: the environment's sign-in first. Returns the environment's name when the user didn't. */
    resumeRefused?(id: string): Promise<string | undefined>;
    /** #335: with what the user chose (batch-resume.ts applyResumeChoice), then on */
    resume(id: string, choice: ResumeChoice): Promise<void>;
    cancel(id: string, isBatch: boolean): Promise<void>;
    /** A Console open outside the Hub (VS Code's own panel), closed after its run is deleted. */
    closeStandaloneConsole?(id: string): boolean;
}

export type HubSettings = IWritableConfiguration;

export interface HubPorts {
    endpoints: APIEndpointManager;
    environments: EnvironmentManager;
    systems: SystemManager;
    recent: RecentEndpointsService;
    preferences: HubPreferencesService;
    settings: HubSettings;
    auth: HubAuth;
    executions?: HubExecutions;
    confirmDestructive(opts: { title?: string; body: string; confirmLabel?: string }): Promise<boolean>;
    toast: { info(message: string): void; warn(message: string): void; error(message: string): void };
    tabs: HubTabFactory;
    /** Run API from a catalogue row: one call, results in a Console. */
    runApi(endpoint: APIEndpointConfig): Promise<void>;
    /** The strip from last time: `peek` for Home's re-open offer, `take` to re-open it (#348). */
    tabSnapshots?: { peek(): HubTabsSnapshot | undefined; take(): HubTabsSnapshot | undefined; save(snapshot: HubTabsSnapshot): Promise<void> };
    /** Home's "New in vX.Y.Z" (#348): the bundled changelog since this install's last version. */
    whatsNew?(): WhatsNew | null;
    sections?: { account?: HubSection; importExport?: HubSection };
    /**
     * #342: where the signed-in user's catalogue lives (their account, or this computer by their
     * choice), for Settings and Home; signed out, this computer's copy of the account's (#427),
     * or undefined. `saveToAccount` moves a catalogue that is on this computer to the account;
     * `removeFromDevice` removes the signed-out copy.
     */
    catalogueStorage?: { info(): CatalogueStorageInfo | undefined; saveToAccount(): Promise<void>; removeFromDevice?(): Promise<void> };
    /** #298: where the saved compares are kept (the Compare list; Delete and Duplicate change it). */
    compares?: {
        state(): CompareState;
        /** A query's file views keep their rows on this computer: a deleted query drops them, a copy takes its own. */
        queryFiles?: Pick<QueryFileStore, 'remove' | 'copy'>;
        /** Where lookup tables are kept: one JSON file each, in DBMN's data folder (the host's one folder object). */
        lookups?: LookupFolder;
    };
    /** Issue #275: export the selected endpoints to a file; the file's path, or an error. */
    exportEndpoints?(ids: string[]): Promise<{ filePath?: string; error?: string }>;
    workspace?: {
        info(): {
            workspacePath?: string;
            executionsDbPath?: string;
            /** In place of the default help text (the web app: where History lives, #344). */
            note?: string;
            /** In place of "Change folder…" (the web app: Use a folder… / Reconnect folder). */
            chooseLabel?: string;
            /** False: no "Open folder" (a browser can't open the file manager). */
            canReveal?: boolean;
            /** A card on Home while the web app isn't on the workspace folder (#344). */
            home?: { title: string; text: string; button: string };
        };
        reveal(): Promise<boolean>;
        choose(): Promise<void>;
    };
    /** VS Code chords caught inside the Hub's frames. */
    runWorkbenchCommand?(command: string): void;
    /** Editors open outside the Hub: Save / Discard / Cancel each. False when the user cancelled. */
    closeStandaloneEditors?(): Promise<boolean>;
    onStandaloneEditorClosed?(listener: (e: { context: string; itemId?: string }) => void): Disposable;
    /** Issue #313: what startup recovery paused, once. */
    takeStartupRecovery?(): { message: string; batchIds: string[] } | undefined;
}
