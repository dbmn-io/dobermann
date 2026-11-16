// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * What the environment editor needs from its host. VS Code supplies EnvironmentManager,
 * SystemManager, the vault, OAuth commands and DBMN auth; the web app supplies the Supabase
 * catalogue and the browser. Anything a host can't do is left out, and the controller says so.
 */
import type { SystemConfig } from '../../data-loading/system-schema';
import type { EnvironmentConfig } from '../../environmentManager';
import type { Disposable } from '../../platform/events';
import type { GoogleServiceAccountConfig } from '../../types/oauth';
import type { SystemManagerLike } from '../new-system-prompt';

export interface EnvironmentRecords {
    getEnvironment(id: string): Promise<EnvironmentConfig | undefined>;
    getActiveEnvironment(): Promise<EnvironmentConfig | undefined>;
    addEnvironment(config: Partial<EnvironmentConfig>): Promise<EnvironmentConfig>;
    updateEnvironment(id: string, updates: Partial<EnvironmentConfig>): Promise<EnvironmentConfig>;
    deleteEnvironment(id: string): Promise<boolean>;
    setActiveEnvironment(id: string): Promise<unknown>;
    getEnvironmentToken(id: string): Promise<string | undefined>;
    setEnvironmentToken(id: string, token: string): Promise<void>;
    deleteEnvironmentToken(id: string): Promise<void>;
    /** Any environment changed, by whoever: the editor re-reads the one it shows. */
    onEnvironmentsChanged?(listener: () => void): Disposable;
}

export interface SystemRecords extends SystemManagerLike {
    getAllSystems(): Promise<SystemConfig[]>;
    onSystemsChanged?(listener: () => void): Disposable;
}

export interface OAuthActions {
    signIn(environmentId: string): Promise<void>;
    /** Resolves false when the user cancelled. */
    signOut(environmentId: string): Promise<boolean>;
    refresh(environmentId: string): Promise<void>;
    requestNewToken(environmentId: string): Promise<void>;
    hasRefreshToken(environmentId: string): Promise<boolean>;
    /** A token pasted into an OAuth environment becomes its session. */
    adoptPastedToken(environmentId: string, token: string, claims?: Record<string, unknown>): Promise<void>;
    /**
     * #344: signed in somewhere other than this host's token store (an environment that runs in
     * DBMN for VS Code: its session is VS Code's). Undefined: the host's own token decides.
     */
    status?(environmentId: string): Promise<{ signedIn: boolean; where: string } | undefined>;
}

export interface DbmnAccount {
    openAccountPage(): Promise<void>;
}

/**
 * #344: where an environment's secrets live when not on this host. The web app answers
 * 'DBMN for VS Code' for an environment that runs in the local agent: its client secret, token
 * and key are entered there, never saved here. Undefined (VS Code; Browser environments): here.
 */
export type SecretsElsewhere = (environment: Partial<EnvironmentConfig>) => string | undefined;

export interface EnvironmentEditorPorts {
    environments: EnvironmentRecords;
    secretsElsewhere?: SecretsElsewhere;
    /** Absent while a host's System store isn't available yet. */
    systems?: SystemRecords;
    confirmDestructive(opts: { title?: string; body: string; confirmLabel?: string }): Promise<boolean>;
    toast: { info(message: string): void; error(message: string): void };
    /** OAuth sign-in: VS Code's flows, or the web app's popup (both run oauth-sign-in.ts). */
    oauth?: OAuthActions;
    testServiceAccount?(config: GoogleServiceAccountConfig, scopes: string[]): Promise<{ expiresIn: number }>;
    takePendingVariables?(environmentId: string): Promise<string[] | undefined>;
    account?: DbmnAccount;
    countTransactions?(environmentId: string): Promise<number>;
    host: {
        maximize?(): void;
        close(): void;
        /** The environment was saved (new or existing): hosts track the open item and the save-context prompt. */
        saved?(environment: EnvironmentConfig, wasNew: boolean): void;
        saveFailed?(): void;
    };
}
