// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Time Formatting Utilities - Frontend Version
 *
 * Centralized time formatting for consistent display across all webviews.
 * Handles durations, ETAs, and individual transaction times with appropriate precision.
 *
 * GitHub Issue #104: Consolidated from duplicate implementations in report.html
 */

/**
 * Format elapsed duration - INCLUDES seconds for accuracy
 * Used for showing how long a batch/execution has been running
 *
 * @param {number} seconds - Duration in seconds
 * @returns {string} Formatted duration like "45s", "5m 23s", "1h 15m 30s"
 */
function formatDuration(seconds) {
    if (!seconds || seconds < 0) return '0s';

    const s = Math.floor(seconds);

    if (s < 60) {
        return `${s}s`;
    } else if (s < 3600) {
        const minutes = Math.floor(s / 60);
        const remainingSeconds = s % 60;
        return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
    } else {
        const hours = Math.floor(s / 3600);
        const minutes = Math.floor((s % 3600) / 60);
        const remainingSeconds = s % 60;
        if (minutes === 0) {
            return remainingSeconds > 0 ? `${hours}h ${remainingSeconds}s` : `${hours}h`;
        } else {
            return remainingSeconds > 0 ? `${hours}h ${minutes}m ${remainingSeconds}s` : `${hours}h ${minutes}m`;
        }
    }
}

/**
 * Format ETA/remaining time - NO seconds, shows "<1m" for under 1 minute
 * Used for displaying estimated time remaining (cleaner, less precise)
 *
 * GitHub Issue #104: Use Math.floor() to avoid flickering between "2m" and "<1m"
 * Gives smooth transitions: "2m" → "1m" → "<1m" → "0s"
 *
 * @param {number} seconds - Remaining time in seconds
 * @returns {string} Formatted ETA like "<1m", "5m", "2h 30m"
 */
function formatETA(seconds) {
    if (!seconds || seconds < 0) return 'Complete';

    const s = Math.floor(seconds);

    if (s < 60) {
        return '<1m';  // Show "<1m" instead of "30s", "45s"
    } else if (s < 3600) {
        const minutes = Math.floor(s / 60);  // Floor instead of ceil - smoother countdown
        return `${minutes}m`;
    } else {
        const hours = Math.floor(s / 3600);
        const minutes = Math.floor((s % 3600) / 60);  // Floor for consistency
        return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
    }
}

/**
 * Format duration with zero-padding for consistent display
 * Used for detailed reports where alignment matters
 *
 * @param {number} seconds - Duration in seconds
 * @returns {string} Formatted duration like "00s", "01m 30s", "02h 15m 45s"
 */
function formatDetailedDuration(seconds) {
    if (!seconds || seconds < 0) return '00s';

    const s = Math.floor(seconds);
    const hours = Math.floor(s / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    const secs = s % 60;

    if (hours > 0) {
        return `${hours.toString().padStart(2, '0')}h ${minutes.toString().padStart(2, '0')}m ${secs.toString().padStart(2, '0')}s`;
    } else if (minutes > 0) {
        return `${minutes.toString().padStart(2, '0')}m ${secs.toString().padStart(2, '0')}s`;
    } else {
        return `${secs.toString().padStart(2, '0')}s`;
    }
}

/**
 * Format duration for individual executions with millisecond precision
 * Used for fast API calls where sub-second precision matters
 *
 * @param {number} seconds - Duration in seconds (can be fractional)
 * @returns {string} Formatted duration:
 *   - < 1s: "450ms", "123ms"
 *   - 1-10s: "3.5s", "8.2s" (1 decimal place)
 *   - >= 10s: "45s", "2m 15s" (standard formatting)
 */
function formatIndividualDuration(seconds) {
    if (!seconds || seconds < 0) return '0ms';

    if (seconds < 1) {
        // Show milliseconds for very fast executions
        return `${Math.round(seconds * 1000)}ms`;
    } else if (seconds < 10) {
        // Show 1 decimal place for 1-10s
        return `${seconds.toFixed(1)}s`;
    } else {
        // >= 10s: use standard formatting
        return formatDuration(Math.floor(seconds));
    }
}

// Export for module systems (Node.js, etc.)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        formatDuration,
        formatETA,
        formatDetailedDuration,
        formatIndividualDuration
    };
}

// Make available globally for webview usage
if (typeof window !== 'undefined') {
    window.formatDuration = formatDuration;
    window.formatETA = formatETA;
    window.formatDetailedDuration = formatDetailedDuration;
    window.formatIndividualDuration = formatIndividualDuration;
}
