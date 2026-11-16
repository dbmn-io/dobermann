// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Time formatting utilities for consistent ETA and duration display
 */

/**
 * Format seconds into a human-readable time estimate string
 * Reusable utility for displaying ETA in batch preparation, execution, etc.
 * 
 * @param seconds The number of seconds to format
 * @param prefix Optional prefix text (defaults to "Est.")
 * @param suffix Optional suffix text (defaults to "remaining")
 * @returns Formatted time string (e.g., "Est. 5m remaining", "Est. 2h 30m remaining")
 */
export function formatTimeEstimate(
    seconds: number, 
    prefix: string = 'Est.', 
    suffix: string = 'remaining'
): string {
    if (seconds < 60) {
        return `${prefix} ${seconds}s ${suffix}`;
    } else if (seconds < 3600) {
        const minutes = Math.ceil(seconds / 60);
        return `${prefix} ${minutes}m ${suffix}`;
    } else {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.ceil((seconds % 3600) / 60);
        return `${prefix} ${hours}h ${minutes}m ${suffix}`;
    }
}

/**
 * Format seconds into a simple ETA string (just the time part)
 * Useful for inline display where prefix/suffix are handled separately
 *
 * @param seconds The number of seconds to format
 * @returns Simple time string (e.g., "5m", "2h 30m", "45s")
 */
export function formatDuration(seconds: number): string {
    if (seconds < 60) {
        return `${seconds}s`;
    } else if (seconds < 3600) {
        const minutes = Math.ceil(seconds / 60);
        return `${minutes}m`;
    } else {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.ceil((seconds % 3600) / 60);
        if (minutes === 0) {
            return `${hours}h`;
        }
        return `${hours}h ${minutes}m`;
    }
}

/**
 * Format seconds into detailed elapsed time with padding (for reports)
 * Always shows seconds, zero-padded for consistent display
 *
 * @param seconds The number of seconds to format
 * @returns Formatted time string (e.g., "00s", "01m 30s", "02h 15m 45s")
 */
export function formatDetailedDuration(seconds: number): string {
    if (!seconds || seconds < 0) return '00s';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
        return `${hours.toString().padStart(2, '0')}h ${minutes.toString().padStart(2, '0')}m ${secs.toString().padStart(2, '0')}s`;
    } else if (minutes > 0) {
        return `${minutes.toString().padStart(2, '0')}m ${secs.toString().padStart(2, '0')}s`;
    } else {
        return `${secs.toString().padStart(2, '0')}s`;
    }
}