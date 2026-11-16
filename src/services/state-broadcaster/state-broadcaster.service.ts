// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import * as vscode from 'vscode';
import { 
  IStateBroadcaster, 
  StateChange, 
  StateSubscription, 
  BroadcastChannel, 
  BroadcastOptions 
} from './state-broadcaster.interface';

export class StateBroadcaster implements IStateBroadcaster {
  private channels = new Map<string, BroadcastChannel>();
  private subscriptions = new Map<string, StateSubscription>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private subscriptionCounter = 0;

  private readonly _onStateChanged = new vscode.EventEmitter<StateChange>();
  readonly onStateChanged = this._onStateChanged.event;

  subscribe(type: string, callback: (change: StateChange) => void, filter?: (change: StateChange) => boolean): string {
    const subscriptionId = `sub_${++this.subscriptionCounter}_${Date.now()}`;
    
    
    const subscription: StateSubscription = {
      id: subscriptionId,
      type,
      callback,
      filter
    };

    this.subscriptions.set(subscriptionId, subscription);

    // Ensure channel exists
    if (!this.channels.has(type)) {
      this.channels.set(type, {
        name: type,
        subscribers: new Set(),
        retainState: false
      });
    }

    const channel = this.channels.get(type)!;
    channel.subscribers.add(subscription);

    // If there's retained state, immediately notify new subscriber
    if (channel.lastState !== undefined && channel.retainState) {
      const stateChange: StateChange = {
        type,
        payload: channel.lastState,
        timestamp: Date.now(),
        source: 'retained-state',
        correlationId: `retained_${Date.now()}`
      };

      // Schedule callback on next tick to avoid issues with immediate execution
      setTimeout(() => {
        try {
          callback(stateChange);
        } catch (error) {
          // eslint-disable-next-line no-restricted-syntax
          console.error('Error in subscriber callback:', error);
        }
      }, 0);
    }

    return subscriptionId;
  }

  unsubscribe(subscriptionId: string): void {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) {
      return;
    }

    const channel = this.channels.get(subscription.type);
    if (channel) {
      channel.subscribers.delete(subscription);
      
      // Clean up empty channels
      if (channel.subscribers.size === 0 && !channel.retainState) {
        this.channels.delete(subscription.type);
      }
    }

    this.subscriptions.delete(subscriptionId);
  }

  async broadcast(type: string, payload: any, source: string, options?: BroadcastOptions): Promise<void> {
    
    const opts: Required<BroadcastOptions> = {
      retainState: false,
      debounceMs: 0,
      filterDuplicates: false,
      includeSource: true,
      ...options
    };

    // Ensure channel exists
    if (!this.channels.has(type)) {
      this.channels.set(type, {
        name: type,
        subscribers: new Set(),
        retainState: opts.retainState
      });
    }

    const channel = this.channels.get(type)!;
    
    // Update channel retention setting
    if (opts.retainState) {
      channel.retainState = true;
    }

    // Check for duplicate filtering
    if (opts.filterDuplicates && channel.lastState !== undefined) {
      if (this.deepEqual(channel.lastState, payload)) {
        return; // Skip duplicate broadcast
      }
    }

    // Store state if retention is enabled
    if (opts.retainState) {
      channel.lastState = payload;
    }

    const stateChange: StateChange = {
      type,
      payload,
      timestamp: Date.now(),
      source: opts.includeSource ? source : 'anonymous',
      correlationId: this.generateCorrelationId()
    };

    // Handle debouncing
    if (opts.debounceMs > 0) {
      const debounceKey = `${type}_${source}`;
      
      // Clear existing timer
      const existingTimer = this.debounceTimers.get(debounceKey);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      // Set new timer
      const timer = setTimeout(async () => {
        await this.performBroadcast(channel, stateChange);
        this.debounceTimers.delete(debounceKey);
      }, opts.debounceMs);

      this.debounceTimers.set(debounceKey, timer);
    } else {
      // Immediate broadcast
      await this.performBroadcast(channel, stateChange);
    }
  }

  getLastState(type: string): any {
    const channel = this.channels.get(type);
    return channel?.lastState;
  }

  clearState(type: string): void {
    const channel = this.channels.get(type);
    if (channel) {
      channel.lastState = undefined;
    }
  }

  getSubscriptions(): StateSubscription[] {
    return Array.from(this.subscriptions.values());
  }

  getChannels(): BroadcastChannel[] {
    return Array.from(this.channels.values()).map(channel => ({
      ...channel,
      subscribers: new Set(channel.subscribers) // Create a copy
    }));
  }

  subscribeFiltered(type: string, filter: (change: StateChange) => boolean, callback: (change: StateChange) => void): string {
    return this.subscribe(type, callback, filter);
  }

  async broadcastMultiple(changes: Array<{ type: string; payload: any; source: string; options?: BroadcastOptions }>): Promise<void> {
    const promises = changes.map(change => 
      this.broadcast(change.type, change.payload, change.source, change.options)
    );

    await Promise.all(promises);
  }

  private async performBroadcast(channel: BroadcastChannel, stateChange: StateChange): Promise<void> {
    
    // Fire global event
    this._onStateChanged.fire(stateChange);

    // Notify all subscribers
    const notificationPromises = Array.from(channel.subscribers).map(async (subscription) => {
      try {
        // Apply filter if present
        if (subscription.filter) {
          try {
            if (!subscription.filter(stateChange)) {
              return; // Filter rejected the change
            }
          } catch (error) {
            // eslint-disable-next-line no-restricted-syntax
            console.error('Error in subscription filter:', error);
            return; // Skip this subscription on filter error
          }
        }

        // Call the callback
        subscription.callback(stateChange);
      } catch (error) {
        // eslint-disable-next-line no-restricted-syntax
        console.error('Error in subscriber callback:', error);
        // Continue with other subscribers even if one fails
      }
    });

    await Promise.allSettled(notificationPromises);
  }

  private generateCorrelationId(): string {
    return `corr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private deepEqual(obj1: any, obj2: any): boolean {
    if (obj1 === obj2) {
      return true;
    }

    if (obj1 == null || obj2 == null) {
      return obj1 === obj2;
    }

    if (typeof obj1 !== typeof obj2) {
      return false;
    }

    if (typeof obj1 !== 'object') {
      return obj1 === obj2;
    }

    if (Array.isArray(obj1) !== Array.isArray(obj2)) {
      return false;
    }

    const keys1 = Object.keys(obj1);
    const keys2 = Object.keys(obj2);

    if (keys1.length !== keys2.length) {
      return false;
    }

    for (const key of keys1) {
      if (!keys2.includes(key)) {
        return false;
      }

      if (!this.deepEqual(obj1[key], obj2[key])) {
        return false;
      }
    }

    return true;
  }
}