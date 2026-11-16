// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { APIEndpointConfig } from '../../data-loading/types';

// File operation result interface
export interface FileOperationResult {
    success: boolean;
    filePath?: string;
    filename?: string;
    error?: string;
}



// Content type for file formatting
export type ContentType = 'json' | 'xml' | 'text' | 'html';

// File type for naming
export type FileType = 'request' | 'response';

// Main interface for execution file service
export interface IExecutionFileService {
    /**
     * Create response file based on existing request file
     * @param response - The HTTP response object
     * @param endpoint - The API endpoint configuration
     * @param duration - Execution duration in milliseconds
     * @param executionId - The execution ID
     * @param requestFilePath - Path to the existing request file
     * @returns Promise resolving to response file path
     */
    createResponseFile(
        response: any, 
        endpoint: APIEndpointConfig, 
        duration: number, 
        executionId: string,
        requestFilePath: string
    ): Promise<string>;


    /**
     * Generate unique file name for execution results
     * @param endpoint - The API endpoint configuration
     * @param fileType - Type of file (request/response)
     * @param executionId - The execution ID
     * @returns Promise resolving to file name
     */
    generateFileName(
        endpoint: APIEndpointConfig, 
        fileType: FileType, 
        executionId: string
    ): Promise<string>;

    /**
     * Get full file path for workspace file
     * @param endpoint - The API endpoint configuration
     * @param fileName - The file name
     * @returns Promise resolving to full file path
     */
    getFilePath(endpoint: APIEndpointConfig, fileName: string): Promise<string>;

    /**
     * Open files in VS Code editor
     * @param filePaths - Array of file paths to open
     * @param autoOpen - Whether to automatically open files
     * @returns Promise that resolves when files are opened
     */
    openFiles(filePaths: string[], autoOpen: boolean): Promise<void>;

    /**
     * Format file content based on content type
     * @param content - The content to format
     * @param contentType - The type of content
     * @returns Promise resolving to formatted content string
     */
    formatFileContent(content: any, contentType: ContentType): Promise<string>;
}