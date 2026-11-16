// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
// Mock vscode module before importing anything else
import '../../../helpers/vscode-mock';

import { expect } from 'chai';
import { describe, it, beforeEach, afterEach } from 'mocha';
import * as sinon from 'sinon';
import { StateBroadcaster } from '../../../../services/state-broadcaster/state-broadcaster.service';
import { IStateBroadcaster, StateChange, BroadcastOptions } from '../../../../services/state-broadcaster/state-broadcaster.interface';

describe('StateBroadcaster', () => {
  let stateBroadcaster: IStateBroadcaster;
  let originalSetTimeout: typeof setTimeout;
  let originalClearTimeout: typeof clearTimeout;
  let timeoutCallbacks: Map<number, () => void>;
  let timeoutId: number;

  beforeEach(() => {
    // Simple time mocking without Sinon
    originalSetTimeout = global.setTimeout;
    originalClearTimeout = global.clearTimeout;
    timeoutCallbacks = new Map();
    timeoutId = 0;
    
    global.setTimeout = ((callback: () => void, delay: number) => {
      const id = ++timeoutId;
      timeoutCallbacks.set(id, callback);
      return id as any;
    }) as any;
    
    global.clearTimeout = ((id: number) => {
      timeoutCallbacks.delete(id);
    }) as any;
    
    stateBroadcaster = new StateBroadcaster();
  });

  afterEach(() => {
    // Restore original functions
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    timeoutCallbacks.clear();
  });
  
  // Helper function to advance fake time
  const tick = (ms: number) => {
    // Execute all pending timeouts
    for (const [id, callback] of timeoutCallbacks.entries()) {
      callback();
      timeoutCallbacks.delete(id);
    }
  };

  describe('subscribe and broadcast', () => {
    it('should subscribe to state changes and receive broadcasts', async () => {
      const callback = sinon.spy();
      const subscriptionId = stateBroadcaster.subscribe('button-state', callback);

      expect(subscriptionId).to.be.a('string');

      await stateBroadcaster.broadcast('button-state', { action: 'run-api' }, 'test-source');

      expect(callback.calledOnce).to.be.true;
      const change = callback.getCall(0).args[0] as StateChange;
      expect(change.type).to.equal('button-state');
      expect(change.payload).to.deep.equal({ action: 'run-api' });
      expect(change.source).to.equal('test-source');
      expect(change.timestamp).to.be.a('number');
    });

    it('should handle multiple subscribers for same type', async () => {
      const callback1 = sinon.spy();
      const callback2 = sinon.spy();
      
      stateBroadcaster.subscribe('execution-state', callback1);
      stateBroadcaster.subscribe('execution-state', callback2);

      await stateBroadcaster.broadcast('execution-state', { status: 'running' }, 'execution-service');

      expect(callback1.calledOnce).to.be.true;
      expect(callback2.calledOnce).to.be.true;
    });

    it('should only notify subscribers of matching types', async () => {
      const buttonCallback = sinon.spy();
      const executionCallback = sinon.spy();
      
      stateBroadcaster.subscribe('button-state', buttonCallback);
      stateBroadcaster.subscribe('execution-state', executionCallback);

      await stateBroadcaster.broadcast('button-state', { action: 'cancel' }, 'test-source');

      expect(buttonCallback.calledOnce).to.be.true;
      expect(executionCallback.called).to.be.false;
    });

    it('should handle filtered subscriptions', async () => {
      const callback = sinon.spy();
      const filter = (change: StateChange) => change.payload.endpointId === 'endpoint-1';
      
      stateBroadcaster.subscribeFiltered('button-state', filter, callback);

      // This should be filtered out
      await stateBroadcaster.broadcast('button-state', { endpointId: 'endpoint-2' }, 'test-source');
      expect(callback.called).to.be.false;

      // This should pass the filter
      await stateBroadcaster.broadcast('button-state', { endpointId: 'endpoint-1' }, 'test-source');
      expect(callback.calledOnce).to.be.true;
    });
  });

  describe('unsubscribe', () => {
    it('should unsubscribe and stop receiving broadcasts', async () => {
      const callback = sinon.spy();
      const subscriptionId = stateBroadcaster.subscribe('test-type', callback);

      await stateBroadcaster.broadcast('test-type', { data: 'first' }, 'test-source');
      expect(callback.calledOnce).to.be.true;

      stateBroadcaster.unsubscribe(subscriptionId);

      await stateBroadcaster.broadcast('test-type', { data: 'second' }, 'test-source');
      expect(callback.calledOnce).to.be.true; // Should still be called only once
    });

    it('should handle unsubscribing non-existent subscription gracefully', () => {
      expect(() => {
        stateBroadcaster.unsubscribe('non-existent-id');
      }).to.not.throw();
    });
  });

  describe('state retention', () => {
    it('should retain state when option is enabled', async () => {
      const options: BroadcastOptions = { retainState: true };
      const testPayload = { status: 'completed' };

      await stateBroadcaster.broadcast('execution-state', testPayload, 'test-source', options);

      const lastState = stateBroadcaster.getLastState('execution-state');
      expect(lastState).to.deep.equal(testPayload);
    });

    it('should not retain state when option is disabled', async () => {
      const options: BroadcastOptions = { retainState: false };
      const testPayload = { status: 'running' };

      await stateBroadcaster.broadcast('execution-state', testPayload, 'test-source', options);

      const lastState = stateBroadcaster.getLastState('execution-state');
      expect(lastState).to.be.undefined;
    });

    it('should provide last state to new subscribers when state is retained', async () => {
      const options: BroadcastOptions = { retainState: true };
      const testPayload = { action: 'run-api', enabled: true };

      await stateBroadcaster.broadcast('button-state', testPayload, 'test-source', options);

      const callback = sinon.spy();
      stateBroadcaster.subscribe('button-state', callback);

      // Advance timers to trigger async callback
      tick(1);

      // Should receive the last state
      expect(callback.calledOnce).to.be.true;
      const change = callback.getCall(0).args[0] as StateChange;
      expect(change.payload).to.deep.equal(testPayload);
    });

    it('should clear retained state', async () => {
      const options: BroadcastOptions = { retainState: true };
      await stateBroadcaster.broadcast('test-state', { data: 'test' }, 'test-source', options);

      expect(stateBroadcaster.getLastState('test-state')).to.not.be.undefined;

      stateBroadcaster.clearState('test-state');

      expect(stateBroadcaster.getLastState('test-state')).to.be.undefined;
    });
  });

  describe('debouncing', () => {
    it('should debounce rapid broadcasts', async () => {
      const callback = sinon.spy();
      stateBroadcaster.subscribe('debounced-state', callback);

      const options: BroadcastOptions = { debounceMs: 100 };

      // Send multiple rapid broadcasts
      await stateBroadcaster.broadcast('debounced-state', { count: 1 }, 'test-source', options);
      await stateBroadcaster.broadcast('debounced-state', { count: 2 }, 'test-source', options);
      await stateBroadcaster.broadcast('debounced-state', { count: 3 }, 'test-source', options);

      // Should not have been called yet
      expect(callback.called).to.be.false;

      // Advance time past debounce period
      tick(150);

      // Should now be called once with the last value
      expect(callback.calledOnce).to.be.true;
      const change = callback.getCall(0).args[0] as StateChange;
      expect(change.payload.count).to.equal(3);
    });
  });

  describe('duplicate filtering', () => {
    it('should filter duplicate broadcasts when option is enabled', async () => {
      const callback = sinon.spy();
      stateBroadcaster.subscribe('filtered-state', callback);

      const options: BroadcastOptions = { filterDuplicates: true, retainState: true };
      const payload = { status: 'running' };

      await stateBroadcaster.broadcast('filtered-state', payload, 'test-source', options);
      await stateBroadcaster.broadcast('filtered-state', payload, 'test-source', options);

      expect(callback.calledOnce).to.be.true;
    });

    it('should not filter when payload is different', async () => {
      const callback = sinon.spy();
      stateBroadcaster.subscribe('filtered-state', callback);

      const options: BroadcastOptions = { filterDuplicates: true, retainState: true };

      await stateBroadcaster.broadcast('filtered-state', { status: 'running' }, 'test-source', options);
      await stateBroadcaster.broadcast('filtered-state', { status: 'completed' }, 'test-source', options);

      expect(callback.calledTwice).to.be.true;
    });
  });

  describe('broadcastMultiple', () => {
    it('should broadcast multiple state changes at once', async () => {
      const buttonCallback = sinon.spy();
      const executionCallback = sinon.spy();
      
      stateBroadcaster.subscribe('button-state', buttonCallback);
      stateBroadcaster.subscribe('execution-state', executionCallback);

      const changes = [
        { type: 'button-state', payload: { action: 'cancel' }, source: 'test-source' },
        { type: 'execution-state', payload: { status: 'cancelled' }, source: 'test-source' }
      ];

      await stateBroadcaster.broadcastMultiple(changes);

      expect(buttonCallback.calledOnce).to.be.true;
      expect(executionCallback.calledOnce).to.be.true;
    });
  });

  describe('debugging helpers', () => {
    it('should return all active subscriptions', () => {
      const callback1 = sinon.spy();
      const callback2 = sinon.spy();
      
      stateBroadcaster.subscribe('type1', callback1);
      stateBroadcaster.subscribe('type2', callback2);

      const subscriptions = stateBroadcaster.getSubscriptions();
      expect(subscriptions).to.have.lengthOf(2);
      expect(subscriptions.map(s => s.type)).to.include.members(['type1', 'type2']);
    });

    it('should return all broadcast channels', async () => {
      await stateBroadcaster.broadcast('channel1', { data: 'test' }, 'test-source', { retainState: true });
      await stateBroadcaster.broadcast('channel2', { data: 'test' }, 'test-source');

      const channels = stateBroadcaster.getChannels();
      expect(channels).to.have.lengthOf(2);
      expect(channels.map(c => c.name)).to.include.members(['channel1', 'channel2']);
    });
  });

  describe('error handling', () => {
    it('should handle subscriber callback errors gracefully', async () => {
      const errorCallback = sinon.stub().throws(new Error('Callback error'));
      const successCallback = sinon.spy();
      
      stateBroadcaster.subscribe('error-test', errorCallback);
      stateBroadcaster.subscribe('error-test', successCallback);

      // Should not throw even if one callback errors
      let errorThrown = false;
      try {
        await stateBroadcaster.broadcast('error-test', { data: 'test' }, 'test-source');
      } catch (error: any) {
        errorThrown = true;
      }
      expect(errorThrown).to.be.false;

      // Other callbacks should still be called
      expect(successCallback.calledOnce).to.be.true;
    });

    it('should handle invalid filter functions gracefully', async () => {
      const callback = sinon.spy();
      const errorFilter = sinon.stub().throws(new Error('Filter error'));
      
      stateBroadcaster.subscribeFiltered('filter-error-test', errorFilter, callback);

      // Should not throw even if filter errors
      let errorThrown = false;
      try {
        await stateBroadcaster.broadcast('filter-error-test', { data: 'test' }, 'test-source');
      } catch (error: any) {
        errorThrown = true;
      }
      expect(errorThrown).to.be.false;

      // Callback should not be called when filter errors
      expect(callback.called).to.be.false;
    });
  });

  describe('correlation ID tracking', () => {
    it('should preserve correlation ID in state changes', async () => {
      const callback = sinon.spy();
      stateBroadcaster.subscribe('correlation-test', callback);

      const stateChange: StateChange = {
        type: 'correlation-test',
        payload: { data: 'test' },
        source: 'test-source',
        timestamp: Date.now(),
        correlationId: 'test-correlation-123'
      };

      await stateBroadcaster.broadcast(stateChange.type, stateChange.payload, stateChange.source);

      expect(callback.calledOnce).to.be.true;
      const receivedChange = callback.getCall(0).args[0] as StateChange;
      expect(receivedChange.correlationId).to.be.a('string');
    });
  });
});