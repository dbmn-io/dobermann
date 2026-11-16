// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import * as path from 'path';

/**
 * Options for generating directory paths
 */
export interface DirectoryPathOptions {
    /** Workspace root directory */
    workspaceRoot: string;
    
    /** Environment name (required for path) */
    environment: string;
    
    /** Environment folder (optional - from environment configuration) */
    environmentFolder?: string;
    
    /** Endpoint name (required for path) */
    endpointName: string;
    
    /** Endpoint folder (optional - from endpoint configuration) */
    endpointFolder?: string;
    
    /** Execution type determines subdirectory structure */
    executionType: 'individual' | 'batch' | 'batch_member';
    
    /** For batch operations: batch ID for batch directory */
    batchId?: string;
}

/**
 * Options for generating file names
 */
export interface FileNameOptions {
    /** Execution type determines naming pattern */
    executionType: 'individual' | 'batch' | 'batch_member';
    
    /** Timestamp for unique naming (defaults to now) */
    timestamp?: Date;
    
    /** Endpoint name for prefixing (sanitized) */
    endpointName?: string;
    
    /** For batch members: transaction index */
    transactionIndex?: number;
    
    /** For batch parent: use 'input.csv' */
    isCSVFile?: boolean;
}

/**
 * Helper service for generating consistent file paths and names
 * Follows the file structure patterns from Transaction Preparation Architecture
 */
export interface IPathGeneratorHelper {
    /**
     * Generate directory path based on execution type
     * Individual: {workspace}/{environmentFolder}/{ENV}/{endpointFolder}/{ENDPOINT}/
     * Batch Parent: {workspace}/{environmentFolder}/{ENV}/{endpointFolder}/{ENDPOINT}/batch/{batchId}/
     * Batch Member: {workspace}/{environmentFolder}/{ENV}/{endpointFolder}/{ENDPOINT}/batch/{batchId}/
     */
    generateDirectoryPath(options: DirectoryPathOptions): string;
    
    /**
     * Generate filename based on execution type
     * Individual: transaction-{timestamp}.json
     * Batch Parent: input.csv
     * Batch Member: transaction-{index}.json
     */
    generateFileName(options: FileNameOptions): string;
    
    /**
     * Generate full file path (directory + filename)
     */
    generateFullPath(directoryOptions: DirectoryPathOptions, fileOptions: FileNameOptions): string;
}

/**
 * Implementation of path generation helper
 */
/**
 * A batch member's request file name: 1-based, so member index 0 is transaction-001.json.
 * The ONE rule — anything naming a member's file calls this. Fetch all pages once built its own
 * 0-based names beside this rule and two pages wrote the same file.
 */
export function batchMemberFileName(transactionIndex: number): string {
    return `transaction-${String(transactionIndex + 1).padStart(3, '0')}.json`;
}

export class PathGeneratorHelper implements IPathGeneratorHelper {
    
    generateDirectoryPath(options: DirectoryPathOptions): string {
        const { workspaceRoot, environment, environmentFolder, endpointName, endpointFolder, executionType, batchId } = options;
        
        // Start with workspace root (no .active8 directory)
        let pathSegments = [workspaceRoot];
        
        // Add environment folder if provided (optional)
        if (environmentFolder && environmentFolder.trim() !== '') {
            pathSegments.push(this.sanitizeForPath(environmentFolder));
        }
        
        // Add environment name (required)
        pathSegments.push(this.sanitizeForPath(environment));
        
        // Add endpoint folder if provided (optional)
        if (endpointFolder && endpointFolder.trim() !== '') {
            pathSegments.push(this.sanitizeForPath(endpointFolder));
        }
        
        // Add endpoint name (required)
        pathSegments.push(this.sanitizeForPath(endpointName));
        
        // Add batch subdirectory for batch operations
        if (executionType === 'batch' || executionType === 'batch_member') {
            pathSegments.push('batch');
            
            if (batchId) {
                pathSegments.push(batchId);
            }
        }
        
        return path.join(...pathSegments);
    }
    
    generateFileName(options: FileNameOptions): string {
        const { executionType, timestamp, endpointName, transactionIndex, isCSVFile } = options;
        
        if (isCSVFile || executionType === 'batch') {
            return 'input.csv';
        }
        
        if (executionType === 'batch_member') {
            return batchMemberFileName(transactionIndex ?? 0);
        }
        
        // Individual execution: transaction-{timestamp}.json
        const ts = timestamp || new Date();
        const timestampStr = ts.toISOString()
            .replace(/[T:]/g, '-')
            .substring(0, 19); // YYYY-MM-DD-HH-mm-ss
        
        // No endpoint prefix for individual transactions per architecture docs
        return `transaction-${timestampStr}.json`;
    }
    
    generateFullPath(directoryOptions: DirectoryPathOptions, fileOptions: FileNameOptions): string {
        const directory = this.generateDirectoryPath(directoryOptions);
        const filename = this.generateFileName(fileOptions);
        return path.join(directory, filename);
    }
    
    /**
     * Sanitize string for use in file paths
     * Replaces invalid characters with hyphens
     */
    private sanitizeForPath(input: string): string {
        return input
            .toLowerCase()
            .replace(/[^a-z0-9-_.]/g, '-')
            .replace(/-+/g, '-') // Replace multiple hyphens with single
            .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens
    }
}