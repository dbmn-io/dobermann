// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import * as vscode from 'vscode';

/**
 * Abstract interface for file system operations
 * Provides abstraction layer over VS Code filesystem API
 */
export interface IFileSystemService {
  /**
   * Check if a file or directory exists
   * @param path - The file or directory path
   * @returns Promise<boolean> - True if exists, false otherwise
   */
  exists(path: string): Promise<boolean>;

  /**
   * Read file contents as string
   * @param path - The file path
   * @returns Promise<string> - File contents
   */
  readFile(path: string): Promise<string>;

  /**
   * Write file contents
   * @param path - The file path
   * @param content - The content to write
   * @returns Promise<void>
   */
  writeFile(path: string, content: string): Promise<void>;

  /**
   * Delete a file or directory
   * @param path - The file or directory path
   * @returns Promise<void>
   */
  delete(path: string): Promise<void>;

  /**
   * Create a directory
   * @param path - The directory path
   * @returns Promise<void>
   */
  createDirectory(path: string): Promise<void>;

  /**
   * List directory contents
   * @param path - The directory path
   * @returns Promise<string[]> - Array of file/directory names
   */
  readDirectory(path: string): Promise<string[]>;

  /**
   * Get file stats (size, modified time, etc.)
   * @param path - The file path
   * @returns Promise<vscode.FileStat> - File statistics
   */
  stat(path: string): Promise<vscode.FileStat>;

  /**
   * Watch for file changes
   * @param path - The file or directory path to watch
   * @returns vscode.FileSystemWatcher - Watcher instance
   */
  createWatcher(path: string): vscode.FileSystemWatcher;

  /**
   * Open file in VS Code editor
   * @param path - The file path
   * @param options - Optional editor options
   * @returns Promise<vscode.TextEditor> - The opened editor
   */
  openFile(path: string, options?: { readOnly?: boolean; preview?: boolean }): Promise<vscode.TextEditor>;
}