// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import * as path from 'path';
import { IFileAccessService, FileAccessEntry } from './file-access.interface';
import { IFileSystemService } from '../../platform/interfaces/filesystem.interface';
import { IOutputService } from '../../platform/interfaces/output.interface';

export interface FileAccessServiceDependencies {
  fileSystem: IFileSystemService;
  outputService: IOutputService;
  workspaceRoot: string;
}

export class FileAccessService implements IFileAccessService {
  private accessLog: FileAccessEntry[] = [];
  private outputService: IOutputService;
  private fileSystem: IFileSystemService;
  private workspaceRoot: string;

  constructor(dependencies: FileAccessServiceDependencies) {
    this.outputService = dependencies.outputService;
    this.fileSystem = dependencies.fileSystem;
    this.workspaceRoot = dependencies.workspaceRoot;
  }

  async openRequestFile(executionId: string): Promise<void> {
    const filePath = this.getExecutionFilePath(executionId, 'request');
    
    if (!(await this.validateFileAccess(filePath))) {
      const error = new Error(`Request file not found for execution ${executionId}: ${filePath}`);
      this.logAccess(executionId, filePath, 'request', 'open', false, error.message);
      throw error;
    }

    await this.enforceReadOnlyAccess(filePath);
    this.logAccess(executionId, filePath, 'request', 'open', true);
  }

  async openResponseFile(executionId: string): Promise<void> {
    const filePath = this.getExecutionFilePath(executionId, 'response');
    
    if (!(await this.validateFileAccess(filePath))) {
      const error = new Error(`Response file not found for execution ${executionId}: ${filePath}`);
      this.logAccess(executionId, filePath, 'response', 'open', false, error.message);
      throw error;
    }

    await this.enforceReadOnlyAccess(filePath);
    this.logAccess(executionId, filePath, 'response', 'open', true);
  }

  async openLogOutput(executionId: string): Promise<void> {
    // Show the output channel
    this.outputService.show();
    
    // Add a filter comment to help user find execution-specific logs
    this.outputService.appendLine(`\n=== Showing logs for execution: ${executionId} ===`);
    this.outputService.appendLine(`Use Ctrl+F to search for "execution:${executionId}" in the output`);
    this.outputService.appendLine(`=== End filter info ===\n`);

    this.logAccess(executionId, 'output-channel', 'other', 'open', true);
  }

  async validateFileAccess(filePath: string): Promise<boolean> {
    try {
      const exists = await this.fileSystem.exists(filePath);
      
      if (exists) {
        // Additional validation - ensure it's a file, not a directory
        const stats = await this.fileSystem.stat(filePath);
        // FileType.File = 1 in VS Code API
        const isFile = (stats.type & 1) !== 0;
        
        this.logAccess(undefined, filePath, 'other', 'validate', isFile);
        return isFile;
      }

      this.logAccess(undefined, filePath, 'other', 'validate', false, 'File does not exist');
      return false;
    } catch (error) {
      this.logAccess(undefined, filePath, 'other', 'error', false, error instanceof Error ? error.message : 'Unknown error');
      return false;
    }
  }

  getExecutionFilePath(executionId: string, fileType: 'request' | 'response'): string {
    // Use injected workspace root
    return path.join(this.workspaceRoot, 'executions', executionId, `${fileType}.json`);
  }

  async enforceReadOnlyAccess(filePath: string): Promise<void> {
    try {
      await this.fileSystem.openFile(filePath, {
        readOnly: true,
        preview: false
      });

      this.logAccess(undefined, filePath, 'other', 'open', true);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logAccess(undefined, filePath, 'other', 'error', false, errorMessage);
      throw new Error(`Failed to open file in read-only mode: ${errorMessage}`);
    }
  }

  getAccessLog(): FileAccessEntry[] {
    return [...this.accessLog]; // Return a copy to prevent external mutation
  }

  private logAccess(
    executionId: string | undefined,
    filePath: string,
    fileType: 'request' | 'response' | 'other',
    action: 'open' | 'validate' | 'error',
    success: boolean,
    errorMessage?: string
  ): void {
    const entry: FileAccessEntry = {
      timestamp: new Date(),
      executionId,
      filePath,
      fileType,
      action,
      success,
      errorMessage
    };

    this.accessLog.push(entry);

    // Also log to output channel for debugging
    const logLevel = success ? 'INFO' : 'ERROR';
    const executionInfo = executionId ? ` execution:${executionId}` : '';
    const errorInfo = errorMessage ? ` - ${errorMessage}` : '';
    
    this.outputService.appendLine(
      `[${entry.timestamp.toISOString()}] ${logLevel}: File ${action} ${fileType}${executionInfo} - ${filePath}${errorInfo}`
    );

    // Keep log size reasonable (last 1000 entries)
    if (this.accessLog.length > 1000) {
      this.accessLog = this.accessLog.slice(-1000);
    }
  }
}