// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * VS Code Output Service Implementation
 * 
 * Following Architecture.md - VS Code API abstraction patterns
 * Concrete implementation of IOutputService using VS Code APIs
 */

import * as vscode from 'vscode';
import { IOutputService, IOutputServiceFactory } from '../interfaces/output.interface';

/**
 * VS Code implementation of IOutputService
 */
export class VSCodeOutputService implements IOutputService {
  constructor(private outputChannel: vscode.OutputChannel) {}

  appendLine(message: string): void {
    this.outputChannel.appendLine(message);
  }

  show(preserveFocus?: boolean): void {
    this.outputChannel.show(preserveFocus);
  }

  clear(): void {
    this.outputChannel.clear();
  }

  hide(): void {
    this.outputChannel.hide();
  }

  dispose(): void {
    this.outputChannel.dispose();
  }
}

/**
 * VS Code implementation of IOutputServiceFactory
 */
export class VSCodeOutputServiceFactory implements IOutputServiceFactory {
  constructor(private vscodeAPI: typeof vscode) {}

  createOutputService(name: string): IOutputService {
    const outputChannel = this.vscodeAPI.window.createOutputChannel(name);
    return new VSCodeOutputService(outputChannel);
  }
}

/**
 * Mock implementation for testing environments
 */
export class MockOutputService implements IOutputService {
  private messages: string[] = [];

  appendLine(message: string): void {
    this.messages.push(message);
    // Optional: console.log for debugging
    // console.log(`[MockOutput] ${message}`);
  }

  show(preserveFocus?: boolean): void {
    // No-op in mock
  }

  clear(): void {
    this.messages = [];
  }

  hide(): void {
    // No-op in mock
  }

  dispose(): void {
    this.messages = [];
  }

  // Testing helper
  getMessages(): string[] {
    return [...this.messages];
  }
}

/**
 * Mock factory for testing environments
 */
export class MockOutputServiceFactory implements IOutputServiceFactory {
  private services = new Map<string, MockOutputService>();

  createOutputService(name: string): IOutputService {
    if (!this.services.has(name)) {
      this.services.set(name, new MockOutputService());
    }
    return this.services.get(name)!;
  }

  // Testing helper
  getService(name: string): MockOutputService | undefined {
    return this.services.get(name);
  }
}