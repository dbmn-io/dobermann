// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Base Message Types
 *
 * Core message type definitions for webview communication.
 * Relocated from src/messaging/base-message.interface.ts as part of
 * legacy messaging cleanup (GitHub Issue #194).
 */

/**
 * Base message structure for all webview communication
 */
export interface BaseMessage {
    /** Unique identifier for message correlation */
    correlationId: string;

    /** Message type for routing and handling */
    type: string;

    /** Timestamp when message was created */
    timestamp: number;

    /** Source of the message (webview or extension) */
    source: MessageSource;

    /** Target destination for the message */
    target: MessageTarget;

    /** Optional message payload */
    payload?: unknown;

    /** Optional error information */
    error?: MessageError;

    /** Message metadata */
    metadata?: MessageMetadata;
}

/**
 * Message source types
 */
export type MessageSource =
    | 'webview'
    | 'extension'
    | 'service'
    | 'command';

/**
 * Message target types
 */
export type MessageTarget =
    | 'webview'
    | 'extension'
    | 'service'
    | 'broadcast';

/**
 * Error information structure
 */
export interface MessageError {
    /** Error code for categorization */
    code: string;

    /** Human-readable error message */
    message: string;

    /** Detailed error information */
    details?: unknown;

    /** Stack trace (for debugging) */
    stack?: string;
}

/**
 * Message metadata structure
 */
export interface MessageMetadata {
    /** User ID associated with the message */
    userId?: string;

    /** Session ID for tracking */
    sessionId?: string;

    /** Environment context */
    environment?: string;

    /** Organization context */
    organization?: string;

    /** Message category for grouping */
    category?: string;

    /** Additional custom metadata */
    custom?: Record<string, unknown>;
}

/**
 * Request message interface
 */
export interface RequestMessage extends BaseMessage {
    /** Indicates this is a request message */
    messageKind: 'request';

    /** Expected response timeout in milliseconds */
    timeout?: number;

    /** Whether this request expects a response */
    expectsResponse: boolean;
}

/**
 * Response message interface
 */
export interface ResponseMessage extends BaseMessage {
    /** Indicates this is a response message */
    messageKind: 'response';

    /** Correlation ID of the original request */
    requestCorrelationId: string;

    /** Whether the operation was successful */
    success: boolean;

    /** Response data */
    data?: unknown;
}

/**
 * Event message interface
 */
export interface EventMessage extends BaseMessage {
    /** Indicates this is an event message */
    messageKind: 'event';

    /** Event category */
    category: EventCategory;

    /** Event severity level */
    severity: EventSeverity;
}

/**
 * Event categories
 */
export type EventCategory =
    | 'execution'
    | 'validation'
    | 'file-operation'
    | 'ui-interaction'
    | 'system'
    | 'error';

/**
 * Event severity levels
 */
export type EventSeverity =
    | 'low'
    | 'medium'
    | 'high'
    | 'critical';

/**
 * Generate a unique correlation ID
 */
export function generateCorrelationId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Create a response message
 */
export function createResponseMessage(
    requestCorrelationId: string,
    success: boolean,
    data?: unknown,
    error?: MessageError
): ResponseMessage {
    return {
        correlationId: generateCorrelationId(),
        type: 'response',
        timestamp: Date.now(),
        source: 'extension',
        target: 'webview',
        messageKind: 'response',
        requestCorrelationId,
        success,
        data,
        error
    };
}

/**
 * Create an error response message
 */
export function createErrorResponseMessage(
    requestCorrelationId: string,
    error: Error | string,
    code: string = 'UNKNOWN_ERROR'
): ResponseMessage {
    const messageError: MessageError = {
        code,
        message: typeof error === 'string' ? error : error.message,
        details: typeof error === 'object' ? error : undefined,
        stack: error instanceof Error ? error.stack : undefined
    };

    return createResponseMessage(requestCorrelationId, false, undefined, messageError);
}

/**
 * Create an event message
 */
export function createEventMessage(
    type: string,
    category: EventCategory,
    severity: EventSeverity,
    payload?: unknown
): EventMessage {
    return {
        correlationId: generateCorrelationId(),
        type,
        timestamp: Date.now(),
        source: 'extension',
        target: 'broadcast',
        payload,
        messageKind: 'event',
        category,
        severity
    };
}
