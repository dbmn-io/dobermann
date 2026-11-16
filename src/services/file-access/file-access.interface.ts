// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * File access service interface for read-only execution file operations
 * Ensures all execution-related files are opened in read-only mode
 */
export interface IFileAccessService {
  /**
   * Open request file for an execution in read-only mode
   * @param executionId - The execution ID
   */
  openRequestFile(executionId: string): Promise<void>;

  /**
   * Open response file for an execution in read-only mode
   * @param executionId - The execution ID
   */
  openResponseFile(executionId: string): Promise<void>;

  /**
   * Open VS Code output panel filtered by execution ID
   * @param executionId - The execution ID to filter logs
   */
  openLogOutput(executionId: string): Promise<void>;

  /**
   * Validate if a file exists and is accessible
   * @param filePath - The file path to validate
   * @returns Promise<boolean> - True if file is accessible
   */
  validateFileAccess(filePath: string): Promise<boolean>;

  /**
   * Get the file path for an execution file
   * @param executionId - The execution ID
   * @param fileType - The type of file ('request' | 'response')
   * @returns The complete file path
   */
  getExecutionFilePath(executionId: string, fileType: 'request' | 'response'): string;

  /**
   * Enforce read-only access for any file
   * @param filePath - The file path to open
   */
  enforceReadOnlyAccess(filePath: string): Promise<void>;

  /**
   * Get file access audit log
   * @returns Array of file access entries
   */
  getAccessLog(): FileAccessEntry[];
}

/**
 * File access audit entry
 */
export interface FileAccessEntry {
  timestamp: Date;
  executionId?: string;
  filePath: string;
  fileType: 'request' | 'response' | 'other';
  action: 'open' | 'validate' | 'error';
  success: boolean;
  errorMessage?: string;
}