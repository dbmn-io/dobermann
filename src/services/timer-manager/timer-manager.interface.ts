// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Timer information for tracking execution time
 */
export interface TimerInfo {
  id: string;
  startTime: Date;
  endTime?: Date;
  elapsedTime: number; // milliseconds
  isRunning: boolean;
  label?: string;
  type: 'execution' | 'batch' | 'custom';
}

/**
 * Timer update callback for real-time updates
 */
export type TimerUpdateCallback = (timerId: string, timerInfo: TimerInfo) => void;

/**
 * UI surface types that can receive timer updates
 */
export enum UITimerSurface {
  WEBVIEW = 'webview',
  STATUS_BAR = 'statusbar',
  TREE_VIEW = 'treeview'
}

/**
 * Timer state change events for UI coordination
 */
export interface TimerStateChange {
  timerId: string;
  action: 'started' | 'stopped' | 'paused' | 'resumed' | 'updated';
  timerInfo: TimerInfo;
  formattedTime: string;
  timestamp: number;
}

/**
 * UI-specific timer update callback
 */
export type UITimerUpdateCallback = (surface: UITimerSurface, stateChange: TimerStateChange) => void;

/**
 * Timer manager service interface for Phase 4 progress tracking
 */
export interface ITimerManager {
  /**
   * Start a new timer
   * @param id - Unique timer identifier
   * @param label - Optional label for the timer
   * @param type - Timer type (execution, batch, custom)
   * @returns Timer information
   */
  startTimer(id: string, label?: string, type?: 'execution' | 'batch' | 'custom'): TimerInfo;

  /**
   * Stop a running timer
   * @param id - Timer identifier
   * @returns Final timer information or undefined if timer not found
   */
  stopTimer(id: string): TimerInfo | undefined;

  /**
   * Get current elapsed time for a timer
   * @param id - Timer identifier
   * @returns Elapsed time in milliseconds or undefined if timer not found
   */
  getElapsedTime(id: string): number | undefined;

  /**
   * Check if a timer is running
   * @param id - Timer identifier
   * @returns True if timer is running, false otherwise
   */
  isRunning(id: string): boolean;

  /**
   * Get timer information
   * @param id - Timer identifier
   * @returns Timer information or undefined if timer not found
   */
  getTimer(id: string): TimerInfo | undefined;

  /**
   * Get all active timers
   * @returns Array of active timer information
   */
  getActiveTimers(): TimerInfo[];

  /**
   * Get all timers (active and stopped)
   * @returns Array of all timer information
   */
  getAllTimers(): TimerInfo[];

  /**
   * Clear a timer from memory
   * @param id - Timer identifier
   * @returns True if timer was removed, false if not found
   */
  clearTimer(id: string): boolean;

  /**
   * Clear all timers from memory
   * @param type - Optional type filter to clear only specific timer types
   */
  clearAllTimers(type?: 'execution' | 'batch' | 'custom'): void;

  /**
   * Register callback for timer updates
   * @param callback - Callback function to call on timer updates
   * @returns Unregister function
   */
  onTimerUpdate(callback: TimerUpdateCallback): () => void;

  /**
   * Register UI-specific callback for timer state changes
   * @param surface - UI surface type (webview, statusbar, treeview)
   * @param callback - Callback function for UI-specific updates
   * @returns Unregister function
   */
  onUITimerUpdate(surface: UITimerSurface, callback: UITimerUpdateCallback): () => void;

  /**
   * Broadcast timer state change to all registered UI surfaces
   * @param timerId - Timer identifier
   * @param action - State change action
   * @param timerInfo - Current timer information
   */
  broadcastTimerStateChange(timerId: string, action: 'started' | 'stopped' | 'paused' | 'resumed' | 'updated', timerInfo: TimerInfo): void;

  /**
   * Format elapsed time into human-readable string
   * @param milliseconds - Elapsed time in milliseconds
   * @returns Formatted time string (e.g., "2m 30s", "1h 15m")
   */
  formatElapsedTime(milliseconds: number): string;

  /**
   * Start live updates for active timers
   * @param intervalMs - Update interval in milliseconds (default: 1000)
   */
  startLiveUpdates(intervalMs?: number): void;

  /**
   * Stop live updates for active timers
   */
  stopLiveUpdates(): void;

  /**
   * Pause a timer (stops counting but doesn't end it)
   * @param id - Timer identifier
   * @returns True if timer was paused, false if not found or already paused
   */
  pauseTimer(id: string): boolean;

  /**
   * Resume a paused timer
   * @param id - Timer identifier
   * @returns True if timer was resumed, false if not found or not paused
   */
  resumeTimer(id: string): boolean;

  /**
   * Check if a timer is paused
   * @param id - Timer identifier
   * @returns True if timer is paused, false otherwise
   */
  isPaused(id: string): boolean;
}