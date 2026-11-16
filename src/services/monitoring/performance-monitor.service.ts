// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Performance Monitoring Service - Phase 8 Stabilization
 * 
 * Monitors execution performance for both legacy and new architectures
 * to ensure the new architecture meets performance requirements.
 */

import { IExtensionDiagnosticLogger } from '../logging/extension-diagnostic-logger.interface';

export interface PerformanceMetric {
    name: string;
    startTime: number;
    endTime?: number;
    duration?: number;
    metadata?: Record<string, any>;
}

export interface PerformanceReport {
    architecture: 'legacy' | 'new';
    metrics: PerformanceMetric[];
    summary: {
        totalDuration: number;
        averageDuration: number;
        minDuration: number;
        maxDuration: number;
        operationCount: number;
    };
}

export class PerformanceMonitorService {
    private metrics: Map<string, PerformanceMetric> = new Map();
    private completedMetrics: PerformanceMetric[] = [];
    private enabled = false;

    constructor(private readonly logger?: IExtensionDiagnosticLogger) {
        // Enable in debug mode or if explicitly requested
        this.enabled = typeof process !== 'undefined' && process.env?.ACTIVE8_PERFORMANCE_MONITORING === 'true';
    }


    /**
     * Start timing an operation
     */
    startTimer(operationName: string, metadata?: Record<string, any>): string {
        if (!this.enabled) {
            return operationName;
        }

        const timerId = `${operationName}-${Date.now()}-${Math.random().toString(36).substring(7)}`;

        const metric: PerformanceMetric = {
            name: operationName,
            startTime: performance.now(),
            metadata
        };

        this.metrics.set(timerId, metric);
        return timerId;
    }

    /**
     * End timing an operation
     */
    endTimer(timerId: string): number | null {
        if (!this.enabled) {
            return null;
        }

        const metric = this.metrics.get(timerId);
        if (!metric) {
            this.logger?.warn(`[PerformanceMonitor] Timer not found: ${timerId}`, undefined, { timerId });
            return null;
        }

        metric.endTime = performance.now();
        metric.duration = metric.endTime - metric.startTime;

        this.completedMetrics.push(metric);
        this.metrics.delete(timerId);

        return metric.duration;
    }

    /**
     * Time a function execution
     */
    async timeOperation<T>(
        operationName: string,
        operation: () => Promise<T>,
        metadata?: Record<string, any>
    ): Promise<{ result: T; duration: number }> {
        if (!this.enabled) {
            const result = await operation();
            return { result, duration: 0 };
        }

        const timerId = this.startTimer(operationName, metadata);
        const startTime = performance.now();

        try {
            const result = await operation();
            const duration = this.endTimer(timerId) || (performance.now() - startTime);
            return { result, duration };
        } catch (error) {
            this.endTimer(timerId);
            throw error;
        }
    }

    /**
     * Generate performance report
     */
    generateReport(architecture: 'legacy' | 'new'): PerformanceReport {
        const metrics = [...this.completedMetrics];

        if (metrics.length === 0) {
            return {
                architecture,
                metrics: [],
                summary: {
                    totalDuration: 0,
                    averageDuration: 0,
                    minDuration: 0,
                    maxDuration: 0,
                    operationCount: 0
                }
            };
        }

        const durations = metrics
            .filter(m => m.duration !== undefined)
            .map(m => m.duration!);

        const totalDuration = durations.reduce((sum, d) => sum + d, 0);
        const averageDuration = totalDuration / durations.length;
        const minDuration = Math.min(...durations);
        const maxDuration = Math.max(...durations);

        return {
            architecture,
            metrics,
            summary: {
                totalDuration,
                averageDuration,
                minDuration,
                maxDuration,
                operationCount: metrics.length
            }
        };
    }

    /**
     * Compare performance between architectures
     */
    compareArchitectures(legacyReport: PerformanceReport, newReport: PerformanceReport): {
        performanceRatio: number; // new/legacy (lower is better)
        improvement: string;
        details: {
            legacy: PerformanceReport['summary'];
            new: PerformanceReport['summary'];
        };
    } {
        const legacyAvg = legacyReport.summary.averageDuration;
        const newAvg = newReport.summary.averageDuration;

        const performanceRatio = legacyAvg > 0 ? newAvg / legacyAvg : 1;

        let improvement = 'No change';
        if (performanceRatio < 0.9) {
            improvement = `${Math.round((1 - performanceRatio) * 100)}% faster`;
        } else if (performanceRatio > 1.1) {
            improvement = `${Math.round((performanceRatio - 1) * 100)}% slower`;
        }

        return {
            performanceRatio,
            improvement,
            details: {
                legacy: legacyReport.summary,
                new: newReport.summary
            }
        };
    }

    /**
     * Log performance metrics
     */
    logMetrics(report: PerformanceReport): void {
        if (!this.enabled) {
            return;
        }

        this.logger?.info(`[PerformanceMonitor] ${report.architecture.toUpperCase()} Architecture Report`, undefined, {
            architecture: report.architecture,
            operations: report.summary.operationCount,
            totalDuration: report.summary.totalDuration,
            averageDuration: report.summary.averageDuration,
            minDuration: report.summary.minDuration,
            maxDuration: report.summary.maxDuration
        });

        // Log slowest operations
        const slowestOps = report.metrics
            .filter(m => m.duration !== undefined)
            .sort((a, b) => (b.duration! - a.duration!))
            .slice(0, 3);

        if (slowestOps.length > 0) {
            this.logger?.info(`[PerformanceMonitor] Slowest Operations:`);
            slowestOps.forEach((op, index) => {
                this.logger?.info(`[PerformanceMonitor] ${index + 1}. ${op.name}: ${op.duration!.toFixed(2)}ms`, undefined, {
                        rank: index + 1,
                    operationName: op.name,
                    duration: op.duration
                });
            });
        }
    }

    /**
     * Clear metrics
     */
    clearMetrics(): void {
        this.metrics.clear();
        this.completedMetrics = [];
    }

    /**
     * Enable/disable monitoring
     */
    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
    }

    /**
     * Check if monitoring is enabled
     */
    isEnabled(): boolean {
        return this.enabled;
    }

    /**
     * Get current metric count
     */
    getMetricCount(): { active: number; completed: number } {
        return {
            active: this.metrics.size,
            completed: this.completedMetrics.length
        };
    }
}

// Note: Use dependency injection instead of singleton pattern
// Services should be injected via constructor for proper DI compliance