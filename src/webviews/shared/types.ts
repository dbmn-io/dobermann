// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import type { NewEnvironmentDraft } from '../../screens/new-environment-prompt';
// Shared types for webview communication

export interface WebviewMessage {
    type: string;
    [key: string]: any;
}

// Environment-specific messages
export interface EnvironmentMessages {
    // From webview to extension
    saveEnvironment: { environment: any };
    loadEnvironment: { environmentId: string };
    setActiveEnvironment: { environmentId: string };
    saveCurrentEnvironment: {};
    
    // From extension to webview
    environmentSaved: { environment: any };
    environmentSaveError: { error: string };
    environmentLoaded: { environment: any };
    environmentSetActive: { environmentId: string };
}

// Endpoint-specific messages
export interface EndpointMessages {
    // From webview to extension
    saveEndpoint: { endpoint: any };
    deleteEndpoint: { endpointId: string };
    testEndpoint: { endpointId: string };
    saveCurrentEndpoint: {};
    
    // From extension to webview
    endpointSaved: { endpoint: any };
    endpointSaveError: { error: string };
    endpointDeleted: { endpointId: string };
    endpointDeleteError: { error: string };
    endpointTestResult: { endpointId: string; result: any };
    endpointTestError: { endpointId: string; error: string };
}

// Shared messages (available to all webviews)
export interface SharedMessages {
    // Token management
    submitToken: { token: string };
    clearToken: {};
    tokenDecoded: { decodedToken: any; isExpired: boolean; baseUrl: string };
    tokenError: { error: string };
    tokenCleared: {};
    
    // Context management
    setContext: { context: string; itemId: string };
    ready: {};
    
    // Change detection
    checkUnsavedChanges: {};
    unsavedChangesResponse: { hasUnsavedChanges: boolean };
    
    // API requests
    sendRequest: { config: any };
}

export type AllMessages = EnvironmentMessages & EndpointMessages & SharedMessages;

// Context types
export type WebviewContext = 'environment' | 'endpoint' | 'execution' | 'general' | 'batchCopy' | 'runBatch' | 'compare' | 'documentation' | 'account' | 'hub';

// Form state for change tracking
export interface FormState {
    [key: string]: string;
}

// Webview configuration
export interface WebviewConfig {
    context: WebviewContext;
    itemId?: string;
    data?: any;
    defaultFolder?: string; // Pre-populate folder field when creating new items
    // Set when a new-endpoint tab should pre-populate from an existing endpoint
    // (Duplicate action). The endpoint manager loads this source and posts it as
    // a duplicate-shaped populate (no id, COPY-prefixed name).
    duplicateFromId?: string;
    // #415: a new environment opens with the System and URL the New environment dialog asked for
    draft?: NewEnvironmentDraft;
}