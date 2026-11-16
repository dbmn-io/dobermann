// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Token Expiry Service for JWT token expiry monitoring and calculation
 * Follows the service interface pattern established in the architecture
 */

import { JWTPayload } from '../../utils/jwt-validation';

export interface TokenExpiryInfo {
    isExpired: boolean;
    remainingMinutes: number;
    warningLevel: 'none' | 'warning' | 'error';
    expiresAt: Date;
}

export interface ITokenExpiryService {
    getExpiryInfo(token: string): TokenExpiryInfo;
    startMonitoring(onExpiryWarning: (info: TokenExpiryInfo) => void): void;
    stopMonitoring(): void;
    isTokenExpired(token: string): boolean;
    getTimeUntilExpiry(token: string): number; // Returns remaining seconds
    setCurrentToken(token: string): void;
    clearCurrentToken(): void;
}

export class TokenExpiryService implements ITokenExpiryService {
    private monitoringTimer?: NodeJS.Timeout;
    private lastExpiryCheck?: TokenExpiryInfo;
    private onExpiryCallback?: (info: TokenExpiryInfo) => void;
    private currentToken?: string;

    private readonly WARNING_THRESHOLD_MINUTES = 30;
    private readonly CRITICAL_THRESHOLD_MINUTES = 10;
    
    // Progressive monitoring intervals
    private readonly NORMAL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
    private readonly WARNING_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
    private readonly CRITICAL_INTERVAL_MS = 30 * 1000; // 30 seconds

    /**
     * Calculates token expiry information from JWT token
     */
    getExpiryInfo(token: string): TokenExpiryInfo {
        try {
            const decoded = this.parseJWTToken(token);
            const now = Math.floor(Date.now() / 1000);
            
            if (!decoded.exp) {
                // Token without expiry timestamp - treat as expired
                return {
                    isExpired: true,
                    remainingMinutes: 0,
                    warningLevel: 'error',
                    expiresAt: new Date(0)
                };
            }

            const remaining = decoded.exp - now;
            const remainingMinutes = Math.floor(remaining / 60);
            const isExpired = remaining <= 0;
            
            let warningLevel: 'none' | 'warning' | 'error' = 'none';
            if (isExpired) {
                warningLevel = 'error';
            } else if (remainingMinutes <= this.CRITICAL_THRESHOLD_MINUTES) {
                warningLevel = 'error'; // Critical = error level for urgent action
            } else if (remainingMinutes <= this.WARNING_THRESHOLD_MINUTES) {
                warningLevel = 'warning';
            }

            return {
                isExpired,
                remainingMinutes: Math.max(0, remainingMinutes),
                warningLevel,
                expiresAt: new Date(decoded.exp * 1000)
            };
        } catch (error) {
            // Invalid token format
            return {
                isExpired: true,
                remainingMinutes: 0,
                warningLevel: 'error',
                expiresAt: new Date(0)
            };
        }
    }

    /**
     * Starts monitoring token expiry with progressive intervals
     */
    startMonitoring(onExpiryWarning: (info: TokenExpiryInfo) => void): void {
        this.onExpiryCallback = onExpiryWarning;
        
        if (this.monitoringTimer) {
            this.stopMonitoring();
        }

        this.scheduleNextCheck();
    }

    /**
     * Schedules the next monitoring check with progressive intervals
     */
    private scheduleNextCheck(): void {
        if (!this.onExpiryCallback) {
            return; // Monitoring stopped
        }

        // Perform the check
        if (this.currentToken) {
            const info = this.getExpiryInfo(this.currentToken);
            
            if (this.shouldNotify(info)) {
                this.onExpiryCallback(info);
                this.lastExpiryCheck = info;
            }

            // Don't schedule next check if token is expired
            if (info.isExpired) {
                return;
            }

            // Calculate next check interval based on time remaining
            const nextInterval = this.getNextMonitoringInterval(info);
            
            this.monitoringTimer = setTimeout(() => {
                this.scheduleNextCheck();
            }, nextInterval);
        } else {
            // No token - check again with normal interval
            this.monitoringTimer = setTimeout(() => {
                this.scheduleNextCheck();
            }, this.NORMAL_INTERVAL_MS);
        }
    }

    /**
     * Determines the next monitoring interval based on token expiry status
     */
    private getNextMonitoringInterval(info: TokenExpiryInfo): number {
        if (info.remainingMinutes <= this.CRITICAL_THRESHOLD_MINUTES) {
            return this.CRITICAL_INTERVAL_MS; // 30 seconds for critical
        } else if (info.remainingMinutes <= this.WARNING_THRESHOLD_MINUTES) {
            return this.WARNING_INTERVAL_MS; // 2 minutes for warning
        } else {
            return this.NORMAL_INTERVAL_MS; // 5 minutes for normal
        }
    }

    /**
     * Stops token expiry monitoring
     */
    stopMonitoring(): void {
        if (this.monitoringTimer) {
            clearTimeout(this.monitoringTimer);
            this.monitoringTimer = undefined;
        }
        this.onExpiryCallback = undefined;
        this.lastExpiryCheck = undefined;
        this.currentToken = undefined;
    }

    /**
     * Quick check if token is expired
     */
    isTokenExpired(token: string): boolean {
        return this.getExpiryInfo(token).isExpired;
    }

    /**
     * Returns remaining time until expiry in seconds
     */
    getTimeUntilExpiry(token: string): number {
        try {
            const decoded = this.parseJWTToken(token);
            const now = Math.floor(Date.now() / 1000);
            
            if (!decoded.exp) {
                return 0;
            }

            return Math.max(0, decoded.exp - now);
        } catch (error) {
            return 0;
        }
    }

    /**
     * Sets the current token for monitoring
     */
    setCurrentToken(token: string): void {
        this.currentToken = token;
        
        // Immediately check expiry for new token
        if (this.onExpiryCallback) {
            const info = this.getExpiryInfo(token);
            if (info.warningLevel !== 'none') {
                this.onExpiryCallback(info);
            }
            this.lastExpiryCheck = info;
            
            // Restart monitoring with progressive intervals for new token
            if (this.monitoringTimer) {
                clearTimeout(this.monitoringTimer);
            }
            this.scheduleNextCheck();
        }
    }

    /**
     * Clears the current token
     */
    clearCurrentToken(): void {
        this.currentToken = undefined;
        this.lastExpiryCheck = undefined;
    }

    /**
     * Parse JWT token payload
     */
    private parseJWTToken(token: string): JWTPayload & { exp?: number; iat?: number } {
        if (!token || typeof token !== 'string') {
            throw new Error('Invalid token format');
        }

        const parts = token.split('.');
        if (parts.length !== 3) {
            throw new Error('Invalid JWT format');
        }

        try {
            // base64url, decoded without Node's Buffer so the web app runs this too (#343)
            const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
            const text = new TextDecoder().decode(Uint8Array.from(atob(padded), c => c.charCodeAt(0)));
            return JSON.parse(text);
        } catch (error) {
            throw new Error('Failed to parse JWT payload');
        }
    }

    /**
     * Determines if we should notify about expiry changes
     */
    private shouldNotify(info: TokenExpiryInfo): boolean {
        if (!this.lastExpiryCheck) {
            // First check - notify if warning or error
            return info.warningLevel !== 'none';
        }

        // Notify if warning level changed
        if (this.lastExpiryCheck.warningLevel !== info.warningLevel) {
            return true;
        }

        // Notify if token became expired
        if (!this.lastExpiryCheck.isExpired && info.isExpired) {
            return true;
        }

        // Notify if we crossed the warning threshold
        if (this.lastExpiryCheck.remainingMinutes > this.WARNING_THRESHOLD_MINUTES && 
            info.remainingMinutes <= this.WARNING_THRESHOLD_MINUTES) {
            return true;
        }

        return false;
    }
}

// Service token for dependency injection
export const TOKEN_EXPIRY_SERVICE_TOKEN = Symbol('TokenExpiryService');