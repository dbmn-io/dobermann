// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * StatusComponent - Basic status display component
 * 
 * Provides status display functionality for execution components
 * - HTTP status code display
 * - Cancel button functionality  
 * - Status message updates
 * - Error handling and display
 */

class StatusComponent {
    constructor(options) {
        // Validate required options
        if (!options || !options.statusDisplay || !options.httpStatus || !options.cancelButton || !options.errorMessage) {
            throw new Error('StatusComponent requires statusDisplay, httpStatus, cancelButton, and errorMessage elements');
        }

        // Store DOM elements
        this.elements = {
            statusDisplay: options.statusDisplay,
            httpStatus: options.httpStatus,
            cancelButton: options.cancelButton,
            errorMessage: options.errorMessage
        };

        // Component state
        this.isRunning = false;
        this.currentStatus = 'Ready';
        this.httpStatus = null;
        this.errorMessage = null;
        this.cancelCallback = null;

        // Initialize display
        this.updateDisplay();
        this.setupEventHandlers();
    }

    /**
     * Setup event handlers
     */
    setupEventHandlers() {
        if (this.elements.cancelButton) {
            this.elements.cancelButton.addEventListener('click', () => {
                this.cancel();
            });
        }
    }

    /**
     * Set status message
     */
    setStatus(status) {
        if (status === '') {
            this.currentStatus = '';
        } else {
            this.currentStatus = status || 'Ready';
        }
        this.updateDisplay();
    }

    /**
     * Get current status
     */
    getStatus() {
        return this.currentStatus;
    }

    /**
     * Set HTTP status code and text
     */
    setHttpStatus(statusCode, statusText) {
        this.httpStatus = statusCode;
        this.httpStatusText = statusText;
        this.updateHttpStatusDisplay();
    }

    /**
     * Get HTTP status
     */
    getHttpStatus() {
        return this.httpStatus;
    }

    /**
     * Get CSS class for status display
     */
    getStatusClass(status) {
        const statusLower = (status || '').toLowerCase();
        
        if (statusLower.includes('running') || statusLower.includes('executing')) {
            return 'status-running';
        } else if (statusLower.includes('error') || statusLower.includes('failed')) {
            return 'status-error';
        } else if (statusLower.includes('success') || statusLower.includes('complete')) {
            return 'status-success';
        } else if (statusLower.includes('cancelled')) {
            return 'status-cancelled';
        }
        
        return 'status-ready';
    }

    /**
     * Set running state
     */
    setRunning(running, status) {
        this.isRunning = !!running;
        if (running) {
            // Clear errors when starting to run
            this.clearError();
        }
        if (status) {
            this.setStatus(status);
        } else if (running) {
            this.setStatus('Running...');
        } else if (!this.errorMessage) {
            // When stopping, only show Ready if there's no error
            this.setStatus('Ready');
        }
        // If there's an error, keep current status (which should be 'Error')
        this.updateDisplay();
    }

    /**
     * Set error message
     */
    setError(errorMessage) {
        this.errorMessage = errorMessage;
        // When setting error, update status to Error
        this.setStatus('Error');
        this.updateDisplay();
    }

    /**
     * Get error message
     */
    getErrorMessage() {
        return this.errorMessage;
    }

    /**
     * Clear error message
     */
    clearError() {
        this.errorMessage = null;
        this.updateDisplay();
    }

    /**
     * Cancel current operation
     */
    cancel() {
        if (this.isRunning && this.cancelCallback) {
            this.setStatus('Cancelling...');
            this.cancelCallback();
        }
        this.isRunning = false;
        this.updateDisplay();
    }

    /**
     * Reset component to initial state
     */
    reset() {
        this.isRunning = false;
        this.currentStatus = 'Ready';
        this.httpStatus = 0;  // Reset to 0, not null
        this.errorMessage = null;
        this.updateDisplay();
    }

    /**
     * Set cancel callback function
     */
    setCancelCallback(callback) {
        this.cancelCallback = callback;
    }

    /**
     * Check if button is disabled (for integration tests)
     */
    isButtonDisabled() {
        return this.elements.cancelButton ? this.elements.cancelButton.disabled : true;
    }

    /**
     * Update DOM display
     */
    updateDisplay() {
        // Update status display
        if (this.elements.statusDisplay) {
            this.elements.statusDisplay.textContent = this.currentStatus;
            
            // Apply CSS class based on HTTP status if available, otherwise status text
            if (this.httpStatus && this.httpStatus !== 0) {
                if (this.httpStatus >= 200 && this.httpStatus < 300) {
                    this.elements.statusDisplay.className = 'status-success';
                } else if (this.httpStatus >= 400) {
                    this.elements.statusDisplay.className = 'status-error';
                } else {
                    this.elements.statusDisplay.className = 'status-ready';
                }
            } else {
                this.elements.statusDisplay.className = this.getStatusClass(this.currentStatus);
            }
        }

        // Update HTTP status
        if (this.elements.httpStatus) {
            if (this.httpStatus !== null && this.httpStatus !== 0) {
                const statusText = this.httpStatusText ? ` ${this.httpStatusText}` : '';
                this.elements.httpStatus.textContent = `${this.httpStatus}${statusText}`;
            } else {
                this.elements.httpStatus.textContent = '-';
                // Clear CSS classes when reset
                this.elements.httpStatus.className = '';
            }
        }

        // Update cancel button
        if (this.elements.cancelButton) {
            this.elements.cancelButton.disabled = !this.isRunning;
        }

        // Update error message
        if (this.elements.errorMessage) {
            if (this.errorMessage) {
                this.elements.errorMessage.textContent = this.errorMessage;
                this.elements.errorMessage.style.display = 'block';
            } else {
                this.elements.errorMessage.textContent = '';
                this.elements.errorMessage.style.display = 'none';
            }
        }
    }

    /**
     * Update HTTP status display and apply CSS classes
     */
    updateHttpStatusDisplay() {
        if (this.elements.httpStatus && this.httpStatus !== null) {
            const statusText = this.httpStatusText ? ` ${this.httpStatusText}` : '';
            this.elements.httpStatus.textContent = `${this.httpStatus}${statusText}`;
            
            // Apply CSS classes based on HTTP status code ranges
            if (this.httpStatus >= 100 && this.httpStatus < 200) {
                this.elements.httpStatus.className = 'status-info';
            } else if (this.httpStatus >= 200 && this.httpStatus < 300) {
                this.elements.httpStatus.className = 'status-success';
            } else if (this.httpStatus >= 400 && this.httpStatus < 500) {
                this.elements.httpStatus.className = 'status-client-error';
            } else if (this.httpStatus >= 500) {
                this.elements.httpStatus.className = 'status-server-error';
            } else {
                this.elements.httpStatus.className = '';
            }
        }
    }

    /**
     * Dispose component and cleanup
     */
    dispose() {
        // Clean up event handlers and references
        this.elements = null;
        this.cancelCallback = null;
    }
}

// Export for both CommonJS and ES modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { StatusComponent };
} else if (typeof window !== 'undefined') {
    window.StatusComponent = StatusComponent;
}