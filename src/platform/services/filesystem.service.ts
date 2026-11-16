// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import * as vscode from 'vscode';
import { IFileSystemService } from '../interfaces/filesystem.interface';

/**
 * VS Code filesystem service implementation
 */
export class VSCodeFileSystemService implements IFileSystemService {
  constructor(private vscodeApi: typeof vscode) {}

  async exists(path: string): Promise<boolean> {
    try {
      const uri = this.vscodeApi.Uri.file(path);
      await this.vscodeApi.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  async readFile(path: string): Promise<string> {
    const uri = this.vscodeApi.Uri.file(path);
    const data = await this.vscodeApi.workspace.fs.readFile(uri);
    return Buffer.from(data).toString('utf8');
  }

  async writeFile(path: string, content: string): Promise<void> {
    const uri = this.vscodeApi.Uri.file(path);
    const data = Buffer.from(content, 'utf8');
    await this.vscodeApi.workspace.fs.writeFile(uri, data);
  }

  async delete(path: string): Promise<void> {
    const uri = this.vscodeApi.Uri.file(path);
    await this.vscodeApi.workspace.fs.delete(uri);
  }

  async createDirectory(path: string): Promise<void> {
    const uri = this.vscodeApi.Uri.file(path);
    await this.vscodeApi.workspace.fs.createDirectory(uri);
  }

  async readDirectory(path: string): Promise<string[]> {
    const uri = this.vscodeApi.Uri.file(path);
    const entries = await this.vscodeApi.workspace.fs.readDirectory(uri);
    return entries.map(([name]: [string, vscode.FileType]) => name);
  }

  async stat(path: string): Promise<vscode.FileStat> {
    const uri = this.vscodeApi.Uri.file(path);
    return await this.vscodeApi.workspace.fs.stat(uri);
  }

  createWatcher(path: string): vscode.FileSystemWatcher {
    return this.vscodeApi.workspace.createFileSystemWatcher(path);
  }

  async openFile(path: string, options?: { readOnly?: boolean; preview?: boolean }): Promise<vscode.TextEditor> {
    const uri = this.vscodeApi.Uri.file(path);
    const document = await this.vscodeApi.workspace.openTextDocument(uri);
    
    return await this.vscodeApi.window.showTextDocument(document, {
      preview: options?.preview ?? false,
      // VS Code doesn't have a direct read-only option in showTextDocument
      // Read-only enforcement would need to be handled at the document level
    });
  }
}