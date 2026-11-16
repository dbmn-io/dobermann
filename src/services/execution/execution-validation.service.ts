// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { APIEndpointConfig } from '../../data-loading/types';
import { ExecutionOptions } from './execution.interface';
import {
    IExecutionValidationService,
    ValidationResult,
    JWTValidationResult,
    EnvironmentValidationResult
} from './execution-validation.interface';

// Dependencies interface for ExecutionValidationService
export interface ExecutionValidationServiceDependencies {
    dobermannInstance: any;
    environmentManager: any;
}

// Minimal implementation of ExecutionValidationService to make tests pass (GREEN phase)
export class ExecutionValidationService implements IExecutionValidationService {
    private dependencies: ExecutionValidationServiceDependencies;

    constructor(dependencies: ExecutionValidationServiceDependencies) {
        this.dependencies = dependencies;
    }

    async validateExecution(endpoint: APIEndpointConfig, options?: ExecutionOptions): Promise<ValidationResult> {
        try {
            // Validate JWT token
            const jwtResult = await this.validateJWT();
            if (!jwtResult.isValid) {
                return {
                    canExecute: false,
                    jwtValid: false,
                    orgValid: false,
                    locValid: false,
                    error: jwtResult.isExpired ? 'JWT token is expired' : 'JWT token not found'
                };
            }

            // Organisation and location headers are environment variables the user keeps (#424):
            // not checked against the token
            // All validations passed
            return {
                canExecute: true,
                jwtValid: true,
                orgValid: true,
                locValid: true,
                error: null
            };
        } catch (error) {
            return {
                canExecute: false,
                jwtValid: false,
                orgValid: false,
                locValid: false,
                error: error instanceof Error ? error.message : 'Unknown validation error'
            };
        }
    }

    async validateJWT(): Promise<JWTValidationResult> {
        try {
            const tokenStatus = this.dependencies.dobermannInstance.getTokenStatus();
            const decodedToken = await this.dependencies.dobermannInstance.getDecodedToken();

            if (!decodedToken || !tokenStatus.isValid) {
                return {
                    isValid: false,
                    isExpired: tokenStatus.isExpired || false,
                    payload: decodedToken
                };
            }

            return {
                isValid: true,
                isExpired: false,
                payload: decodedToken
            };
        } catch (error) {
            // Re-throw the error for network errors to be caught by caller
            throw error;
        }
    }

    async validateEnvironment(): Promise<EnvironmentValidationResult> {
        try {
            const environment = await this.dependencies.environmentManager.getActiveEnvironment();
            
            if (!environment) {
                return {
                    isValid: false,
                    environment: null
                };
            }

            return {
                isValid: true,
                environment
            };
        } catch (error) {
            return {
                isValid: false,
                environment: null
            };
        }
    }
}