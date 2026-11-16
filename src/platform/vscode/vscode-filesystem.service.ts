// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import * as vscode from 'vscode';
import { IFileSystemService } from '../interfaces/filesystem.interface';

/**
 * VS Code filesystem service implementation
 * Provides concrete implementation of file system operations using VS Code APIs
 */
export class VSCodeFileSystemService implements IFileSystemService {
  
  async exists(path: string): Promise<boolean> {
    try {
      const uri = vscode.Uri.file(path);
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  async readFile(path: string): Promise<string> {
    const uri = vscode.Uri.file(path);
    const data = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(data).toString('utf8');
  }

  async writeFile(path: string, content: string): Promise<void> {
    const uri = vscode.Uri.file(path);
    const data = Buffer.from(content, 'utf8');
    await vscode.workspace.fs.writeFile(uri, data);
  }

  async delete(path: string): Promise<void> {
    const uri = vscode.Uri.file(path);
    await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false });
  }

  async createDirectory(path: string): Promise<void> {
    const uri = vscode.Uri.file(path);
    await vscode.workspace.fs.createDirectory(uri);
  }

  async readDirectory(path: string): Promise<string[]> {
    const uri = vscode.Uri.file(path);
    const entries = await vscode.workspace.fs.readDirectory(uri);
    return entries.map(([name]) => name);
  }

  async stat(path: string): Promise<vscode.FileStat> {
    const uri = vscode.Uri.file(path);
    return await vscode.workspace.fs.stat(uri);
  }

  createWatcher(path: string): vscode.FileSystemWatcher {
    return vscode.workspace.createFileSystemWatcher(path);
  }

  async openFile(path: string, options?: { readOnly?: boolean; preview?: boolean }): Promise<vscode.TextEditor> {
    const uri = vscode.Uri.file(path);
    
    const document = await vscode.workspace.openTextDocument(uri);
    
    const editor = await vscode.window.showTextDocument(document, {
      preview: options?.preview ?? true,
      preserveFocus: false
    });

    // VS Code doesn't have a direct "read-only" mode, but we can simulate it
    // by immediately saving and showing a warning if the user tries to edit
    if (options?.readOnly) {
      // Add a comment or warning to indicate read-only mode
      // This is a limitation of VS Code's API - true read-only enforcement
      // would require a custom text editor or document provider
    }

    return editor;
  }
}