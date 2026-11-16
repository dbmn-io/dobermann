// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { ITimerManager, TimerInfo, TimerUpdateCallback, UITimerSurface, TimerStateChange, UITimerUpdateCallback } from './timer-manager.interface';
import { IExtensionDiagnosticLogger } from '../logging/extension-diagnostic-logger.interface';

/**
 * Timer Manager Service - Backend service for Phase 4 Progress Tracking
 * 
 * Manages timer state and business logic in backend per Architecture.md.
 * Frontend TimerComponent only handles message passing + DOM updates.
 */
export class TimerManagerService implements ITimerManager {
  private timers: Map<string, TimerInfo> = new Map();
  private updateCallbacks: Set<TimerUpdateCallback> = new Set();
  private uiUpdateCallbacks: Map<UITimerSurface, Set<UITimerUpdateCallback>> = new Map();
  private liveUpdateInterval: NodeJS.Timeout | null = null;
  private liveUpdateIntervalMs: number = 1000;

  constructor(private readonly logger: IExtensionDiagnosticLogger) {
    // Initialize UI callback maps
    this.uiUpdateCallbacks.set(UITimerSurface.WEBVIEW, new Set());
    this.uiUpdateCallbacks.set(UITimerSurface.STATUS_BAR, new Set());
    this.uiUpdateCallbacks.set(UITimerSurface.TREE_VIEW, new Set());
  }

  startTimer(id: string, label?: string, type: 'execution' | 'batch' | 'custom' = 'execution'): TimerInfo {
    // Stop existing timer if running
    if (this.timers.has(id)) {
      this.stopTimer(id);
    }

    const timer: TimerInfo = {
      id,
      startTime: new Date(),
      elapsedTime: 0,
      isRunning: true,
      label,
      type
    };

    this.timers.set(id, timer);
    this.notifyCallbacks(id, timer);
    this.broadcastTimerStateChange(id, 'started', timer);

    return timer;
  }

  stopTimer(id: string): TimerInfo | undefined {
    const timer = this.timers.get(id);
    if (!timer || !timer.isRunning) {
      return undefined;
    }

    timer.endTime = new Date();
    timer.elapsedTime = timer.endTime.getTime() - timer.startTime.getTime();
    timer.isRunning = false;

    this.timers.set(id, timer);
    this.notifyCallbacks(id, timer);
    this.broadcastTimerStateChange(id, 'stopped', timer);

    return timer;
  }

  getElapsedTime(id: string): number | undefined {
    const timer = this.timers.get(id);
    if (!timer) {
      return undefined;
    }

    if (timer.isRunning) {
      return Date.now() - timer.startTime.getTime();
    }

    return timer.elapsedTime;
  }

  isRunning(id: string): boolean {
    const timer = this.timers.get(id);
    return timer?.isRunning ?? false;
  }

  getTimer(id: string): TimerInfo | undefined {
    const timer = this.timers.get(id);
    if (!timer) {
      return undefined;
    }

    // Update elapsed time for running timers
    if (timer.isRunning) {
      timer.elapsedTime = Date.now() - timer.startTime.getTime();
    }

    return { ...timer }; // Return copy to prevent external mutation
  }

  getActiveTimers(): TimerInfo[] {
    const activeTimers: TimerInfo[] = [];

    for (const timer of this.timers.values()) {
      if (timer.isRunning) {
        // Update elapsed time for active timers
        timer.elapsedTime = Date.now() - timer.startTime.getTime();
        activeTimers.push({ ...timer });
      }
    }

    return activeTimers;
  }

  getAllTimers(): TimerInfo[] {
    const allTimers: TimerInfo[] = [];

    for (const timer of this.timers.values()) {
      if (timer.isRunning) {
        // Update elapsed time for running timers
        timer.elapsedTime = Date.now() - timer.startTime.getTime();
      }
      allTimers.push({ ...timer });
    }

    return allTimers;
  }

  clearTimer(id: string): boolean {
    return this.timers.delete(id);
  }

  clearAllTimers(type?: 'execution' | 'batch' | 'custom'): void {
    if (type) {
      for (const [id, timer] of this.timers.entries()) {
        if (timer.type === type) {
          this.timers.delete(id);
        }
      }
    } else {
      this.timers.clear();
    }
  }

  onTimerUpdate(callback: TimerUpdateCallback): () => void {
    this.updateCallbacks.add(callback);

    // Return unregister function
    return () => {
      this.updateCallbacks.delete(callback);
    };
  }

  formatElapsedTime(milliseconds: number): string {
    // Follow TimerComponent test requirements:
    // - Milliseconds (with 'ms' suffix) for times under 3 seconds
    // - Seconds (with 's' suffix, 1 decimal place) for times 3 seconds and over
    if (milliseconds < 3000) {
      return `${Math.floor(milliseconds)}ms`;
    } else {
      const seconds = milliseconds / 1000;
      return `${seconds.toFixed(1)}s`;
    }
  }

  startLiveUpdates(intervalMs: number = 1000): void {
    if (this.liveUpdateInterval) {
      this.stopLiveUpdates();
    }

    this.liveUpdateIntervalMs = intervalMs;
    this.liveUpdateInterval = setInterval(() => {
      // Notify callbacks for all active timers
      for (const timer of this.getActiveTimers()) {
        this.notifyCallbacks(timer.id, timer);
      }
    }, intervalMs);
  }

  stopLiveUpdates(): void {
    if (this.liveUpdateInterval) {
      clearInterval(this.liveUpdateInterval);
      this.liveUpdateInterval = null;
    }
  }

  pauseTimer(id: string): boolean {
    const timer = this.timers.get(id);
    if (!timer || !timer.isRunning) {
      return false;
    }

    // Store elapsed time and mark as paused
    timer.elapsedTime = Date.now() - timer.startTime.getTime();
    timer.isRunning = false;
    // Note: We don't set endTime for paused timers to distinguish from stopped

    this.timers.set(id, timer);
    this.notifyCallbacks(id, timer);
    this.broadcastTimerStateChange(id, 'paused', timer);

    return true;
  }

  resumeTimer(id: string): boolean {
    const timer = this.timers.get(id);
    if (!timer || timer.isRunning || timer.endTime) {
      return false;
    }

    // Adjust start time to account for paused duration
    const pausedDuration = timer.elapsedTime;
    timer.startTime = new Date(Date.now() - pausedDuration);
    timer.isRunning = true;

    this.timers.set(id, timer);
    this.notifyCallbacks(id, timer);
    this.broadcastTimerStateChange(id, 'resumed', timer);

    return true;
  }

  isPaused(id: string): boolean {
    const timer = this.timers.get(id);
    return timer ? !timer.isRunning && !timer.endTime : false;
  }

  onUITimerUpdate(surface: UITimerSurface, callback: UITimerUpdateCallback): () => void {
    const callbackSet = this.uiUpdateCallbacks.get(surface);
    if (callbackSet) {
      callbackSet.add(callback);
    }

    // Return unregister function
    return () => {
      const callbackSet = this.uiUpdateCallbacks.get(surface);
      if (callbackSet) {
        callbackSet.delete(callback);
      }
    };
  }

  broadcastTimerStateChange(timerId: string, action: 'started' | 'stopped' | 'paused' | 'resumed' | 'updated', timerInfo: TimerInfo): void {
    const stateChange: TimerStateChange = {
      timerId,
      action,
      timerInfo: { ...timerInfo }, // Copy to prevent external mutation
      formattedTime: this.formatElapsedTime(timerInfo.elapsedTime),
      timestamp: Date.now()
    };

    // Broadcast to all UI surfaces
    for (const [surface, callbackSet] of this.uiUpdateCallbacks.entries()) {
      for (const callback of callbackSet) {
        try {
          callback(surface, stateChange);
        } catch (error) {
          this.logger.error(`Timer UI update callback error for ${surface}`, error instanceof Error ? error : undefined, { surface });
        }
      }
    }
  }

  private notifyCallbacks(timerId: string, timerInfo: TimerInfo): void {
    for (const callback of this.updateCallbacks) {
      try {
        callback(timerId, timerInfo);
      } catch (error) {
        this.logger.error('Timer update callback error', error instanceof Error ? error : undefined);
      }
    }
  }

  /**
   * Dispose of the service and cleanup resources
   */
  dispose(): void {
    this.stopLiveUpdates();
    this.updateCallbacks.clear();
    this.uiUpdateCallbacks.clear();
    this.timers.clear();
  }
}