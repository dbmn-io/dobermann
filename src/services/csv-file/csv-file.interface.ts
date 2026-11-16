// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { APIEndpointConfig } from '../../apiConfigManager';

/**
 * Interface for CSV file management service
 * Handles CSV file creation and workspace management following Architecture.md patterns
 */
export interface ICSVFileService {
    /**
     * Create CSV file from data array and save to workspace
     * Uses same workspace structure as createWorkspaceResultFile: {environment}/{endpoint}/batches/{batchId}/input.csv
     * 
     * @param csvData Array of string arrays representing CSV data (header + rows)
     * @param endpoint Endpoint configuration for folder structure
     * @param environment Environment name for folder structure
     * @returns Object containing file path and batch ID
     */
    createCSVFile(
        csvData: string[][], 
        endpoint: APIEndpointConfig, 
        environment: string
    ): Promise<{
        filePath: string;
        batchId: string;
        workspaceDir: string;
    }>;

    /**
     * Generate unique batch ID for workspace creation
     * @returns Unique batch identifier
     */
    generateBatchId(): string;

    /**
     * Convert CSV data array to CSV string format with proper escaping
     * @param csvData Array of string arrays
     * @returns CSV formatted string
     */
    convertCsvArrayToString(csvData: string[][]): string;

    /**
     * Sanitize endpoint name for folder creation (same as Dobermann)
     * @param endpoint Endpoint name or path
     * @returns Sanitized folder name
     */
    sanitizeEndpointName(endpoint: string): string;
}