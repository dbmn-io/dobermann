// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import * as vscode from 'vscode';

export interface StateChange {
  type: string;
  payload: any;
  timestamp: number;
  source: string;
  correlationId?: string;
}

export interface StateSubscription {
  id: string;
  type: string;
  callback: (change: StateChange) => void;
  filter?: (change: StateChange) => boolean;
}

export interface BroadcastChannel {
  name: string;
  subscribers: Set<StateSubscription>;
  lastState?: any;
  retainState?: boolean;
}

export interface BroadcastOptions {
  retainState?: boolean;
  debounceMs?: number;
  filterDuplicates?: boolean;
  includeSource?: boolean;
}

export interface IStateBroadcaster {
  /**
   * Subscribe to state changes of a specific type
   */
  subscribe(type: string, callback: (change: StateChange) => void, filter?: (change: StateChange) => boolean): string;

  /**
   * Unsubscribe from state changes
   */
  unsubscribe(subscriptionId: string): void;

  /**
   * Broadcast a state change to all subscribers
   */
  broadcast(type: string, payload: any, source: string, options?: BroadcastOptions): Promise<void>;

  /**
   * Get the last known state for a specific type
   */
  getLastState(type: string): any;

  /**
   * Clear retained state for a specific type
   */
  clearState(type: string): void;

  /**
   * Get all active subscriptions (for debugging)
   */
  getSubscriptions(): StateSubscription[];

  /**
   * Get all broadcast channels (for debugging)
   */
  getChannels(): BroadcastChannel[];

  /**
   * Create a filtered subscription for specific conditions
   */
  subscribeFiltered(type: string, filter: (change: StateChange) => boolean, callback: (change: StateChange) => void): string;

  /**
   * Broadcast to multiple types at once
   */
  broadcastMultiple(changes: Array<{ type: string; payload: any; source: string; options?: BroadcastOptions }>): Promise<void>;

  /**
   * Event emitter for global state change notifications
   */
  onStateChanged: vscode.Event<StateChange>;
}