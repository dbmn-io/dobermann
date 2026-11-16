// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Array Handler Service for Report Generation
 * Determines the appropriate display strategy for arrays based on size and content
 * Part of Phase 3: Nested Data Handling
 */

export interface ArrayDisplayStrategy {
    type: 'concatenate' | 'inline' | 'modal';
    threshold: number;
    reason: string;
}

export interface ArrayAnalysis {
    path: string;
    length: number;
    itemType: 'primitive' | 'object';
    sampleItems: any[];
    displayStrategy: ArrayDisplayStrategy;
    previewText?: string;
    shouldExpand?: boolean;
}

export interface ArrayHandlerConfig {
    concatenateThreshold: number;
    inlineThreshold: number;
    maxPreviewItems: number;
    maxConcatenatedLength: number;
}

export class ArrayHandlerService {
    private config: ArrayHandlerConfig = {
        concatenateThreshold: 3,    // Arrays ≤ 3 items: concatenate
        inlineThreshold: 10,        // Arrays 4-10 items: inline table
        maxPreviewItems: 5,         // Show first 5 items in preview
        maxConcatenatedLength: 100  // Max character length for concatenation
    };

    /**
     * Analyze an array and determine the best display strategy
     */
    analyzeArray(path: string, array: any[]): ArrayAnalysis {
        if (!Array.isArray(array) || array.length === 0) {
            return {
                path,
                length: 0,
                itemType: 'primitive',
                sampleItems: [],
                displayStrategy: {
                    type: 'concatenate',
                    threshold: 0,
                    reason: 'Empty array'
                },
                previewText: '[]',
                shouldExpand: false
            };
        }

        const length = array.length;
        const sampleItems = array.slice(0, this.config.maxPreviewItems);
        const itemType = this.determineItemType(sampleItems[0]);
        
        // Determine display strategy based on array characteristics
        const displayStrategy = this.determineDisplayStrategy(array, itemType);
        
        // Generate preview text for concatenated arrays
        const previewText = displayStrategy.type === 'concatenate' 
            ? this.generatePreviewText(array, itemType)
            : undefined;

        // Determine if array should be expandable
        const shouldExpand = displayStrategy.type !== 'concatenate' && length > 0;

        return {
            path,
            length,
            itemType,
            sampleItems,
            displayStrategy,
            previewText,
            shouldExpand
        };
    }

    /**
     * Determine the type of items in the array
     */
    private determineItemType(sampleItem: any): 'primitive' | 'object' {
        if (sampleItem === null || sampleItem === undefined) {
            return 'primitive';
        }

        const type = typeof sampleItem;
        return (type === 'object' && !Array.isArray(sampleItem)) ? 'object' : 'primitive';
    }

    /**
     * Determine the best display strategy for an array
     */
    private determineDisplayStrategy(array: any[], itemType: 'primitive' | 'object'): ArrayDisplayStrategy {
        const length = array.length;

        // Small arrays: concatenate if they fit well as text
        if (length <= this.config.concatenateThreshold) {
            if (itemType === 'primitive') {
                const previewText = this.generatePreviewText(array, itemType);
                if (previewText.length <= this.config.maxConcatenatedLength) {
                    return {
                        type: 'concatenate',
                        threshold: this.config.concatenateThreshold,
                        reason: `Small array (${length} items) fits in text format`
                    };
                }
            }
        }

        // Medium arrays: inline table if manageable
        if (length <= this.config.inlineThreshold) {
            return {
                type: 'inline',
                threshold: this.config.inlineThreshold,
                reason: `Medium array (${length} items) suitable for inline display`
            };
        }

        // Large arrays: modal display
        return {
            type: 'modal',
            threshold: this.config.inlineThreshold,
            reason: `Large array (${length} items) requires modal for optimal viewing`
        };
    }

    /**
     * Generate preview text for concatenated arrays
     */
    private generatePreviewText(array: any[], itemType: 'primitive' | 'object'): string {
        if (array.length === 0) {
            return '[]';
        }

        if (itemType === 'primitive') {
            // For primitive arrays, join with commas
            const preview = array
                .slice(0, this.config.maxPreviewItems)
                .map(item => this.formatPrimitiveValue(item))
                .join(', ');
            
            const hasMore = array.length > this.config.maxPreviewItems;
            return hasMore ? `${preview}, ...` : preview;
        } else {
            // For object arrays, show count and sample
            const sample = array[0];
            const keys = Object.keys(sample).slice(0, 3);
            const sampleText = keys.map(key => key + ': ' + this.formatPrimitiveValue(sample[key])).join(', ');
            
            return array.length + ' objects: {' + sampleText + (keys.length < Object.keys(sample).length ? ', ...' : '') + '}';
        }
    }

    /**
     * Format primitive values for display
     */
    private formatPrimitiveValue(value: any): string {
        if (value === null) return 'null';
        if (value === undefined) return 'undefined';
        if (typeof value === 'string') {
            // Truncate long strings
            return value.length > 20 ? '"' + value.substring(0, 20) + '..."' : '"' + value + '"';
        }
        if (typeof value === 'number') {
            return value.toString();
        }
        if (typeof value === 'boolean') {
            return value.toString();
        }
        if (value instanceof Date) {
            return value.toISOString().split('T')[0]; // Just the date part
        }
        
        return String(value);
    }

    /**
     * Update configuration
     */
    updateConfig(newConfig: Partial<ArrayHandlerConfig>): void {
        this.config = { ...this.config, ...newConfig };
    }

    /**
     * Get current configuration
     */
    getConfig(): ArrayHandlerConfig {
        return { ...this.config };
    }

    /**
     * Batch analyze multiple arrays found in data
     */
    batchAnalyze(arrayPaths: { path: string; array: any[] }[]): ArrayAnalysis[] {
        return arrayPaths.map(({ path, array }) => this.analyzeArray(path, array));
    }

    /**
     * Generate CSS classes for array display elements
     */
    getArrayDisplayClasses(strategy: ArrayDisplayStrategy['type']): string[] {
        const baseClasses = ['array-display'];
        
        switch (strategy) {
            case 'concatenate':
                return [...baseClasses, 'array-concatenated', 'inline-text'];
            case 'inline':
                return [...baseClasses, 'array-inline', 'expandable-section'];
            case 'modal':
                return [...baseClasses, 'array-modal', 'clickable-preview'];
            default:
                return baseClasses;
        }
    }
}