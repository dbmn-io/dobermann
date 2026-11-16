// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { APIEndpointConfig } from '../../data-loading/types';
import { ExecutionOptions } from './execution.interface';
import { JWTPayload } from '../../utils/jwt-validation';

// Validation result interfaces
export interface ValidationResult {
    canExecute: boolean;
    jwtValid: boolean;
    orgValid: boolean;
    locValid: boolean;
    error: string | null;
}

export interface JWTValidationResult {
    isValid: boolean;
    isExpired: boolean;
    payload: JWTPayload | null;
}

export interface EnvironmentValidationResult {
    isValid: boolean;
    environment: any;
}

// Main interface for execution validation service
export interface IExecutionValidationService {
    /**
     * Validates whether an execution can proceed based on JWT token, organization, location, and environment
     * @param endpoint - The API endpoint configuration
     * @param options - Execution options
     * @returns Promise resolving to validation result
     */
    validateExecution(endpoint: APIEndpointConfig, options?: ExecutionOptions): Promise<ValidationResult>;

    /**
     * Validates JWT token structure and expiration
     * @returns Promise resolving to JWT validation result
     */
    validateJWT(): Promise<JWTValidationResult>;

    /**
     * Validates current environment configuration
     * @returns Promise resolving to environment validation result
     */
    validateEnvironment(): Promise<EnvironmentValidationResult>;
}