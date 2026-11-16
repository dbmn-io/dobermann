// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { APIEndpointConfig } from '../../data-loading/types';
import { 
    IExecutionFileService, 
    FileOperationResult, 
    ContentType, 
    FileType 
} from './execution-file.interface';
import { IExtensionDiagnosticLogger } from '../logging/extension-diagnostic-logger.interface';
import * as path from 'path';
import { writeRunFile } from '../run-content/run-content-store';

// Dependencies interface for ExecutionFileService
export interface ExecutionFileServiceDependencies {
    dobermannInstance: any;
    vscodeAPI: any;
    logger: IExtensionDiagnosticLogger;
}

// Implementation of ExecutionFileService for managing execution result files
export class ExecutionFileService implements IExecutionFileService {
    private dependencies: ExecutionFileServiceDependencies;

    constructor(dependencies: ExecutionFileServiceDependencies) {
        this.dependencies = dependencies;
    }

    /**
     * Generate response file name based on request file name
     * Examples:
     * - transaction-001.json → transaction-001-response.json
     * - endpoint-name-request.json → endpoint-name-response.json
     * - any-name.json → any-name-response.json
     */
    private generateResponseFileName(requestFilePath: string): string {
        const dir = path.dirname(requestFilePath);
        const basename = path.basename(requestFilePath);
        const ext = path.extname(basename);
        const nameWithoutExt = basename.slice(0, -ext.length);
        
        // If filename ends with -request, replace with -response
        let responseName: string;
        if (nameWithoutExt.endsWith('-request')) {
            responseName = nameWithoutExt.slice(0, -8) + '-response';
        } else {
            // Otherwise, add -response suffix
            responseName = nameWithoutExt + '-response';
        }
        
        return path.join(dir, responseName + ext);
    }

    async createResponseFile(
        response: any, 
        endpoint: APIEndpointConfig, 
        duration: number, 
        executionId: string,
        requestFilePath: string
    ): Promise<string> {
        try {
            // Generate response file name based on request file path
            const responseFileName = path.basename(this.generateResponseFileName(requestFilePath));
            
            // Create response data
            const responseData = {
                executionId: executionId,
                duration: duration,
                httpStatus: response.status,
                httpStatusText: response.statusText,
                headers: response.headers || {},
                data: response.data,
                // How `data` was read, e.g. JSON Lines (#115): the Raw tab shows the lines
                ...(response.format ? { format: response.format } : {})
            };
            
            // Format content
            const content = await this.formatFileContent(responseData, 'json');
            
            // Beside the request, in the run folder's content archive (#358)
            const responseFilePath = path.join(path.dirname(requestFilePath), responseFileName);
            writeRunFile(responseFilePath, content);
            return responseFilePath;
        } catch (error) {
            throw error;
        }
    }

    /**
     * Extract workspace relative path from absolute path
     * e.g., /home/alex/active8/acm/vsdev/masterdata/test → acm/vsdev/masterdata/test
     */
    private extractWorkspaceRelativePath(absolutePath: string): string {
        // Try to find workspace root patterns and extract everything after
        const patterns = [
            /\/active8\/(.*)/,      // Matches /home/alex/active8/acm/vsdev/test -> acm/vsdev/test
            /\/workspace\/(.*)/,    // Matches /workspace/acm/vsdev/test -> acm/vsdev/test
            /\/\.active8\/(.*)/     // Legacy pattern: /workspace/.active8/ENV/endpoint -> ENV/endpoint
        ];
        
        for (const pattern of patterns) {
            const match = absolutePath.match(pattern);
            if (match) {
                return match[1];
            }
        }
        
        // Fallback: return the full path (this shouldn't happen with new architecture)
        this.dependencies.logger.warn(`Could not extract workspace relative path from: ${absolutePath}`);
        return absolutePath;
    }


    async generateFileName(
        endpoint: APIEndpointConfig, 
        fileType: FileType, 
        executionId: string
    ): Promise<string> {
        // Sanitize endpoint name for file system (keep it short)
        const sanitizedEndpointName = (endpoint.name || 'endpoint')
            .toLowerCase()
            .replace(/[^a-z0-9-_.]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '')
            .substring(0, 20); // Limit to 20 characters
        
        // Use the clean executionId format: {sanitized-endpoint-name}-{executionid}-{file-type}.json
        const fileName = `${sanitizedEndpointName}-${executionId}-${fileType}.json`;
        
        return fileName;
    }

    async getFilePath(endpoint: APIEndpointConfig, fileName: string): Promise<string> {
        const folder = endpoint.folder || 'default';
        return `/workspace/${folder}/${fileName}`;
    }

    async openFiles(filePaths: string[], autoOpen: boolean): Promise<void> {
        if (!autoOpen || !this.dependencies.vscodeAPI?.window?.showTextDocument) {
            return;
        }
        
        try {
            for (const filePath of filePaths) {
                // Convert to VS Code URI
                const uri = this.dependencies.vscodeAPI.Uri.file(filePath);
                await this.dependencies.vscodeAPI.window.showTextDocument(uri);
            }
        } catch (error) {
            // Silently handle file opening errors
            this.dependencies.logger.warn('Failed to open files:', error);
        }
    }

    async formatFileContent(content: any, contentType: ContentType): Promise<string> {
        try {
            switch (contentType) {
                case 'json':
                    return JSON.stringify(content, null, 2);
                
                case 'xml':
                    // For XML, assume content is already a string
                    return typeof content === 'string' ? content : JSON.stringify(content, null, 2);
                
                case 'text':
                case 'html':
                    return typeof content === 'string' ? content : JSON.stringify(content, null, 2);
                
                default:
                    return JSON.stringify(content, null, 2);
            }
        } catch (error) {
            // Handle formatting errors (e.g., circular references)
            return `Error formatting content: ${error instanceof Error ? error.message : 'Unknown error'}`;
        }
    }
}