// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Output Service Interface
 * 
 * Following Architecture.md - VS Code API abstraction patterns
 * Provides abstracted access to VS Code output channels
 */

export interface IOutputService {
  /**
   * Write a message to the output channel
   */
  appendLine(message: string): void;

  /**
   * Show the output channel
   */
  show(preserveFocus?: boolean): void;

  /**
   * Clear the output channel
   */
  clear(): void;

  /**
   * Hide the output channel
   */
  hide(): void;

  /**
   * Dispose the output channel
   */
  dispose(): void;
}

/**
 * Factory interface for creating output services
 */
export interface IOutputServiceFactory {
  /**
   * Create a new output service with the given name
   */
  createOutputService(name: string): IOutputService;
}