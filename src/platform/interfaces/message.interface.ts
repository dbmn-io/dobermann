// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
export interface BaseMessage {
  type: string;
  payload?: any;
  correlationId?: string;
  timestamp: number;
}

export interface IWebviewMessenger {
  /**
   * Send a message to the webview
   */
  sendMessage(message: BaseMessage): Promise<void>;

  /**
   * Register a message handler for incoming messages
   */
  onDidReceiveMessage(handler: (message: BaseMessage) => void): void;
}