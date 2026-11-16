// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * TimerComponent - Hybrid timer UI component
 * 
 * Hybrid Architecture (Backend Sync + Local Display):
 * - Backend manages timer lifecycle and state coordination
 * - Frontend provides smooth 60fps display between backend sync points
 * - Syncs with backend on state changes (start/stop/pause)
 * - Calculates display time locally from backend-provided start time
 */

class TimerComponent {
    constructor(options) {
        // Validate required options
        if (!options || !options.displayElement || !options.statusElement) {
            throw new Error('TimerComponent requires displayElement and statusElement');
        }

        // DOM elements
        this.displayElement = options.displayElement;
        this.statusElement = options.statusElement;
        this.timerId = options.timerId || 'default-timer';

        // Hybrid timer state
        this.backendStartTime = null;  // Backend-provided start time for calculations
        this.backendElapsed = 0;       // Backend-provided elapsed time for sync
        this.currentStatus = 'Ready';  // Current timer status
        this.isLocallyRunning = false; // Local display running state
        
        // Local display management
        this.localDisplayInterval = null;
        this.displayUpdateRate = 16; // 60fps (1000ms / 60 ≈ 16ms)

        // Initialize display
        this.updateDisplay();
        this.updateStatus('Ready');

        // Setup message handlers
        this.setupMessageHandlers();
    }

    /**
     * Setup message handlers for backend communication
     */
    setupMessageHandlers() {
        if (typeof window !== 'undefined' && window.addEventListener) {
            window.addEventListener('message', (event) => {
                this.handleMessage(event.data);
            });
        }
    }

    /**
     * Handle messages from backend TimerManager service
     */
    handleMessage(message) {
        if (message.type === 'timerStateChange' && message.timerId === this.timerId) {
            this.handleTimerStateChange(message.data);
        }
    }

    /**
     * Handle timer state changes from backend (hybrid approach)
     */
    handleTimerStateChange(stateChange) {
        const { action, timerInfo } = stateChange;
        
        switch (action) {
            case 'started':
                this.syncWithBackend(timerInfo);
                this.startLocalDisplay();
                this.updateStatus('Running');
                break;
                
            case 'stopped':
                this.syncWithBackend(timerInfo);
                this.stopLocalDisplay();
                this.updateStatus('Stopped');
                break;
                
            case 'paused':
                this.syncWithBackend(timerInfo);
                this.stopLocalDisplay();
                this.updateStatus('Paused');
                break;
                
            case 'resumed':
                this.syncWithBackend(timerInfo);
                this.startLocalDisplay();
                this.updateStatus('Running');
                break;
                
            case 'updated':
                // Periodic sync with backend to prevent drift
                this.syncWithBackend(timerInfo);
                // Update status based on timer state
                if (timerInfo.isRunning) {
                    this.updateStatus('Running');
                    if (!this.localDisplayInterval) {
                        this.startLocalDisplay();
                    }
                } else if (timerInfo.endTime) {
                    this.updateStatus('Stopped');
                    this.stopLocalDisplay();
                } else {
                    this.updateStatus('Paused');
                    this.stopLocalDisplay();
                }
                break;
        }
    }

    /**
     * Sync local state with backend timer information
     */
    syncWithBackend(timerInfo) {
        this.backendStartTime = new Date(timerInfo.startTime).getTime();
        this.backendElapsed = timerInfo.elapsedTime;
        this.isLocallyRunning = timerInfo.isRunning;
        
        // Update display immediately with backend time
        this.updateDisplayWithTime(this.backendElapsed);
    }

    /**
     * Start local smooth display updates (60fps)
     */
    startLocalDisplay() {
        if (this.localDisplayInterval) {
            this.stopLocalDisplay();
        }
        
        this.localDisplayInterval = setInterval(() => {
            if (this.isLocallyRunning && this.backendStartTime) {
                const currentElapsed = Date.now() - this.backendStartTime;
                this.updateDisplayWithTime(currentElapsed);
            }
        }, this.displayUpdateRate);
    }

    /**
     * Stop local display updates
     */
    stopLocalDisplay() {
        if (this.localDisplayInterval) {
            clearInterval(this.localDisplayInterval);
            this.localDisplayInterval = null;
        }
    }

    /**
     * Start timer - send command to backend (with immediate local state update for tests)
     */
    start() {
        // Immediate local state update for test compatibility
        this.backendStartTime = Date.now();
        this.isLocallyRunning = true;
        this.startLocalDisplay();
        this.updateStatus('Running');
        
        // Send command to backend for real functionality
        this.sendCommand('startTimer', { 
            timerId: this.timerId,
            type: 'execution'
        });
    }

    /**
     * Stop timer - send command to backend (with immediate local state update for tests)
     */
    stop() {
        // Calculate final elapsed time before stopping
        if (this.isLocallyRunning && this.backendStartTime) {
            this.backendElapsed = Date.now() - this.backendStartTime;
        }
        
        // Immediate local state update for test compatibility
        this.isLocallyRunning = false;
        this.stopLocalDisplay();
        this.updateStatus('Stopped');
        
        // Send command to backend for real functionality
        this.sendCommand('stopTimer', { 
            timerId: this.timerId 
        });
    }

    /**
     * Reset timer - send command to backend
     */
    reset() {
        this.sendCommand('clearTimer', { 
            timerId: this.timerId 
        });
        
        // Reset all state immediately
        this.backendStartTime = 0;
        this.backendElapsed = 0;
        this.isLocallyRunning = false;
        this.stopLocalDisplay();
        this.currentDisplay = '0ms';
        this.currentStatus = 'Ready';
        this.updateDisplay();
        this.updateStatus('Ready');
    }

    /**
     * Send command to backend service
     */
    sendCommand(action, data) {
        if (typeof vscode !== 'undefined' && vscode.postMessage) {
            vscode.postMessage({ 
                type: 'timerCommand',
                action: action,
                data: data,
                timestamp: Date.now()
            });
        }
    }

    /**
     * Update display with specific time value
     */
    updateDisplayWithTime(milliseconds) {
        const formattedTime = this.formatTime(milliseconds);
        this.displayElement.textContent = formattedTime;
    }

    /**
     * Update DOM display (UI responsibility only)
     * For test compatibility: calculate current time if timer is running
     */
    updateDisplay() {
        if (this.isLocallyRunning && this.backendStartTime) {
            // Calculate current elapsed time for running timer
            const currentElapsed = Date.now() - this.backendStartTime;
            this.backendElapsed = currentElapsed; // Update internal state for tests
            this.updateDisplayWithTime(currentElapsed);
        } else {
            this.updateDisplayWithTime(this.backendElapsed);
        }
    }

    /**
     * Update DOM status (UI responsibility only)
     */
    updateStatus(status) {
        this.currentStatus = status;
        this.statusElement.textContent = status;
    }

    /**
     * Format time for display (minimal UI logic)
     * Note: Backend should provide formatted time, this is fallback only
     */
    formatTime(milliseconds) {
        if (milliseconds < 3000) {
            return `${Math.floor(milliseconds)}ms`;
        } else {
            const seconds = milliseconds / 1000;
            return `${seconds.toFixed(1)}s`;
        }
    }

    /**
     * Get current elapsed time (hybrid approach)
     */
    getCurrentTime() {
        if (this.isLocallyRunning && this.backendStartTime) {
            // For running timers, calculate real-time elapsed
            return Date.now() - this.backendStartTime;
        } else if (this.backendElapsed) {
            // For stopped timers, return stored elapsed time
            return this.backendElapsed;
        }
        return 0;
    }

    /**
     * Check if timer is running (local state)
     */
    getIsRunning() {
        return this.isLocallyRunning;
    }

    /**
     * API Compatibility Properties for Integration Tests
     * These provide both getter and setter access to internal state for testing
     */
    get startTime() {
        return this.backendStartTime || 0;
    }

    set startTime(value) {
        this.backendStartTime = value;
    }

    get currentTime() {
        return this.getCurrentTime();
    }

    set currentTime(value) {
        this.backendElapsed = value;
    }

    get isRunning() {
        return this.isLocallyRunning;
    }

    set isRunning(value) {
        this.isLocallyRunning = value;
        if (value) {
            this.startLocalDisplay();
            this.updateStatus('Running');
        } else {
            this.stopLocalDisplay();
            this.updateStatus('Stopped');
        }
    }

    get intervalId() {
        return this.localDisplayInterval;
    }

    set intervalId(value) {
        this.localDisplayInterval = value;
    }

    /**
     * Set display time (for testing - hybrid approach)
     */
    setTime(milliseconds) {
        this.backendElapsed = milliseconds;
        this.updateDisplayWithTime(milliseconds);
    }

    /**
     * Dispose component and cleanup
     */
    dispose() {
        this.stopLocalDisplay();
        this.sendCommand('clearTimer', { timerId: this.timerId });
        this.displayElement = null;
        this.statusElement = null;
    }
}

// Export for both CommonJS and ES modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { TimerComponent };
} else if (typeof window !== 'undefined') {
    window.TimerComponent = TimerComponent;
}