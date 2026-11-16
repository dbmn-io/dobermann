// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Execution Commands: VS Code's `dbmn.runApiEndpoint`, and the entry the Run Batch tab calls.
 * The run path itself is core (RunOrchestrator); this builds its dependencies from VS Code's
 * container and globals.
 */
import * as vscode from 'vscode';
import { IServiceContainer, ServiceTokens } from '../container/service-container.interface';
import { ServiceBootstrap } from '../container/service-bootstrap';
import { CoreServiceTokens } from '../container/core-services-registry';
import { UIServiceTokens } from '../container/ui-services-registry';
import type { EnvironmentManager } from '../environmentManager';
import type { APIEndpointManager } from '../apiEndpointManager';
import type { IExtensionDiagnosticLogger } from '../services/logging/extension-diagnostic-logger.interface';
import type { IEnvironmentAuthGate } from '../services/environment/environment-auth-gate.service';
import type { IDbmnAuthService, IDbmnTelemetry } from '../services/dbmn-auth/dbmn-auth.interface';
import type { IToastService } from '../services/notifications/toast.interface';
import type { ModalHost } from '../screens/modal.types';
import { getToast } from '../services/notifications/get-toast';
import { ensureDobermannWorkspaceFolder } from '../utils/workspace-helper';
import { sendDbmnSignInLinkInApp, DbmnModalSpec, DbmnModalResult } from '../services/ui/dbmn-prompts';
import { confirmProductionExecution } from '../services/ui/production-guard.service';
import { RunOrchestrator } from '../services/execution/run-orchestrator';

const globals = globalThis as Record<string, unknown>;

export class ExecutionCommands extends RunOrchestrator {
    constructor(serviceContainer: IServiceContainer) {
        const logger = serviceContainer.resolve<IExtensionDiagnosticLogger>(CoreServiceTokens.ExtensionDiagnosticLogger);
        super({
            logger,
            get environments() { return serviceContainer.resolve<EnvironmentManager>(ServiceTokens.EnvironmentManager); },
            get endpoints() { return serviceContainer.resolve<APIEndpointManager>(ServiceTokens.EndpointManager); },
            pipeline: new ServiceBootstrap(serviceContainer, logger),
            individualEngine: () => serviceContainer.resolve(ServiceTokens.IndividualExecutionEngine) as ReturnType<RunOrchestrator['deps']['individualEngine']>,
            // The Hub's modal (registered globally while the Hub is open)
            modal: () => {
                const bridge = globals.dbmnShowModal as ((spec: DbmnModalSpec) => Promise<DbmnModalResult>) | undefined;
                return bridge ? { showModal: bridge } as ModalHost : undefined;
            },
            ensureAuthenticated: environment => serviceContainer.resolve<IEnvironmentAuthGate>(UIServiceTokens.EnvironmentAuthGate).ensureAuthenticated(environment as never),
            isEnvironmentSignedIn: environment => serviceContainer.resolve<IEnvironmentAuthGate>(UIServiceTokens.EnvironmentAuthGate).isAuthenticationValid(environment as Parameters<IEnvironmentAuthGate['isAuthenticationValid']>[0]),
            telemetry: () => globals.dbmnTelemetryService as IDbmnTelemetry | undefined,
            promptSignIn: async () => {
                const auth = globals.dbmnAuthService as IDbmnAuthService | undefined;
                if (auth) await sendDbmnSignInLinkInApp(auth, globals.dbmnToastService as IToastService);
            },
            confirmProduction: (environment, action) => confirmProductionExecution(environment as never, action),
            workspaceRoot: async () => (await ensureDobermannWorkspaceFolder()).fsPath,
            links: () => serviceContainer.resolve(ServiceTokens.ExecutionMetadataManager),
            toast: { error: message => getToast()?.error(message) }
        });
    }

    /** Register the VS Code commands. */
    registerCommands(context: vscode.ExtensionContext): void {
        context.subscriptions.push(vscode.commands.registerCommand('dbmn.runApiEndpoint', this.runApiEndpointCommand.bind(this)));
    }
}
