// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Expandable Row Renderer Service for Report Generation
 * Handles rendering of nested objects with progressive disclosure
 * Part of Phase 3: Nested Data Handling
 */

export interface NestedObjectAnalysis {
    path: string;
    depth: number;
    properties: NestedProperty[];
    totalProperties: number;
    expandableArrays: string[];
    nestedObjects: string[];
}

export interface NestedProperty {
    key: string;
    value: any;
    type: 'primitive' | 'object' | 'array';
    path: string;
    displayValue: string;
    isExpandable: boolean;
    children?: NestedProperty[];
}

export interface ExpandableRowConfig {
    maxDepth: number;
    maxPropertiesPerLevel: number;
    truncateStringLength: number;
    showTypeHints: boolean;
}

export class ExpandableRowRendererService {
    private config: ExpandableRowConfig = {
        maxDepth: 5,                    // Maximum nesting depth to display
        maxPropertiesPerLevel: 20,      // Max properties to show per level
        truncateStringLength: 100,      // Max string length before truncation
        showTypeHints: true             // Show data type hints
    };

    /**
     * Analyze a nested object and prepare for rendering
     */
    analyzeNestedObject(path: string, obj: any, currentDepth = 0): NestedObjectAnalysis {
        if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
            return {
                path,
                depth: 0,
                properties: [],
                totalProperties: 0,
                expandableArrays: [],
                nestedObjects: []
            };
        }

        const properties: NestedProperty[] = [];
        const expandableArrays: string[] = [];
        const nestedObjects: string[] = [];
        let totalProperties = 0;

        for (const [key, value] of Object.entries(obj)) {
            const propertyPath = path ? `${path}.${key}` : key;
            const property = this.analyzeProperty(key, value, propertyPath, currentDepth);
            
            properties.push(property);
            totalProperties++;

            if (property.type === 'array' && Array.isArray(value) && value.length > 0) {
                expandableArrays.push(propertyPath);
            } else if (property.type === 'object' && property.isExpandable) {
                nestedObjects.push(propertyPath);
                
                // Recursively count nested properties (up to maxDepth)
                if (currentDepth < this.config.maxDepth) {
                    const nestedAnalysis = this.analyzeNestedObject(propertyPath, value, currentDepth + 1);
                    totalProperties += nestedAnalysis.totalProperties;
                    expandableArrays.push(...nestedAnalysis.expandableArrays);
                    nestedObjects.push(...nestedAnalysis.nestedObjects);
                }
            }
        }

        return {
            path,
            depth: currentDepth,
            properties: properties.slice(0, this.config.maxPropertiesPerLevel),
            totalProperties,
            expandableArrays,
            nestedObjects
        };
    }

    /**
     * Analyze a single property
     */
    private analyzeProperty(key: string, value: any, path: string, currentDepth: number): NestedProperty {
        const type = this.determinePropertyType(value);
        const displayValue = this.formatDisplayValue(value, type);
        const isExpandable = this.isPropertyExpandable(value, type, currentDepth);

        const property: NestedProperty = {
            key,
            value,
            type,
            path,
            displayValue,
            isExpandable
        };

        // Add children if expandable and within depth limits
        if (isExpandable && currentDepth < this.config.maxDepth) {
            if (type === 'object') {
                const childAnalysis = this.analyzeNestedObject(path, value, currentDepth + 1);
                property.children = childAnalysis.properties;
            } else if (type === 'array' && Array.isArray(value)) {
                // For arrays, create simplified children for preview
                property.children = value.slice(0, 3).map((item, index) => 
                    this.analyzeProperty(
                        `[${index}]`, 
                        item, 
                        `${path}[${index}]`, 
                        currentDepth + 1
                    )
                );
            }
        }

        return property;
    }

    /**
     * Determine property type
     */
    private determinePropertyType(value: any): 'primitive' | 'object' | 'array' {
        if (value === null || value === undefined) {
            return 'primitive';
        }

        if (Array.isArray(value)) {
            return 'array';
        }

        const type = typeof value;
        return type === 'object' ? 'object' : 'primitive';
    }

    /**
     * Check if a property is expandable
     */
    private isPropertyExpandable(value: any, type: 'primitive' | 'object' | 'array', currentDepth: number): boolean {
        if (currentDepth >= this.config.maxDepth) {
            return false;
        }

        if (type === 'array') {
            return Array.isArray(value) && value.length > 0;
        }

        if (type === 'object') {
            return value !== null && Object.keys(value).length > 0;
        }

        return false;
    }

    /**
     * Format display value for different types
     */
    private formatDisplayValue(value: any, type: 'primitive' | 'object' | 'array'): string {
        if (value === null) return 'null';
        if (value === undefined) return 'undefined';

        switch (type) {
            case 'primitive':
                return this.formatPrimitive(value);
            case 'array':
                return this.formatArray(value);
            case 'object':
                return this.formatObject(value);
            default:
                return String(value);
        }
    }

    /**
     * Format primitive values
     */
    private formatPrimitive(value: any): string {
        if (typeof value === 'string') {
            if (value.length > this.config.truncateStringLength) {
                return `"${value.substring(0, this.config.truncateStringLength)}..."`;
            }
            return `"${value}"`;
        }

        if (typeof value === 'number') {
            return value.toString();
        }

        if (typeof value === 'boolean') {
            return value.toString();
        }

        if (value instanceof Date) {
            return value.toISOString();
        }

        return String(value);
    }

    /**
     * Format array preview
     */
    private formatArray(array: any[]): string {
        if (array.length === 0) {
            return '[]';
        }

        const preview = array.slice(0, 3)
            .map(item => {
                if (typeof item === 'object' && item !== null) {
                    return Array.isArray(item) ? `[...${item.length}]` : '{...}';
                }
                return this.formatPrimitive(item);
            })
            .join(', ');

        const hasMore = array.length > 3;
        return `[${preview}${hasMore ? `, ...+${array.length - 3}` : ''}]`;
    }

    /**
     * Format object preview
     */
    private formatObject(obj: any): string {
        if (obj === null) return 'null';

        const keys = Object.keys(obj);
        if (keys.length === 0) {
            return '{}';
        }

        const preview = keys.slice(0, 3)
            .map(key => {
                const value = obj[key];
                const shortValue = typeof value === 'string' && value.length > 20 
                    ? `"${value.substring(0, 20)}..."` 
                    : this.formatPrimitive(value);
                return `${key}: ${shortValue}`;
            })
            .join(', ');

        const hasMore = keys.length > 3;
        return `{${preview}${hasMore ? `, ...+${keys.length - 3}` : ''}}`;
    }

    /**
     * Generate HTML structure for expandable row
     */
    generateExpandableRowHTML(analysis: NestedObjectAnalysis): string {
        const properties = analysis.properties.map(property => 
            this.generatePropertyHTML(property, 0)
        ).join('');

        return `
            <div class="expandable-row" data-path="${analysis.path}">
                <div class="expandable-row-header cursor-pointer flex items-center justify-between p-2 bg-code border rounded transition hover-bg-hover">
                    <div class="flex items-center gap-2">
                        <span class="expandable-row-toggle text-sm">▶</span>
                        <span class="expandable-row-title font-semibold text-base">${analysis.path || 'Object'}</span>
                        <span class="property-count bg-secondary text-xs px-2 py-1 rounded-md">${analysis.totalProperties} properties</span>
                    </div>
                    <div class="expandable-indicators flex gap-1">
                        ${analysis.expandableArrays.length > 0 ? `<span class="indicator-badge bg-editor text-xs px-2 py-1 rounded" title="Contains arrays">📋 ${analysis.expandableArrays.length}</span>` : ''}
                        ${analysis.nestedObjects.length > 0 ? `<span class="indicator-badge bg-editor text-xs px-2 py-1 rounded" title="Nested objects">{} ${analysis.nestedObjects.length}</span>` : ''}
                    </div>
                </div>
                <div class="expandable-row-content hidden mt-2 border rounded bg-editor">
                    <div class="property-list p-3">
                        ${properties}
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Generate HTML for individual property
     */
    private generatePropertyHTML(property: NestedProperty, indentLevel: number): string {
        const indentClass = `ml-${Math.min(indentLevel * 4, 16)}`; // Cap at ml-16
        const typeClass = `property-type-${property.type}`;
        const expandableClass = property.isExpandable ? 'property-expandable cursor-pointer' : '';

        let propertyHTML = `
            <div class="property-item ${indentClass} ${typeClass} ${expandableClass} py-1 px-2 rounded transition hover-bg-hover" data-path="${property.path}">
                <div class="property-header flex items-center gap-2">
                    ${property.isExpandable ? '<span class="property-toggle text-xs">▶</span>' : '<span class="property-bullet text-xs">•</span>'}
                    <span class="property-key font-medium text-sm text-mono">${property.key}</span>
                    ${this.config.showTypeHints ? `<span class="type-hint text-xs bg-code px-1 rounded">${property.type}</span>` : ''}
                    <span class="property-value text-sm flex-1 text-mono">${property.displayValue}</span>
                </div>
        `;

        // Add children if expandable
        if (property.isExpandable && property.children && property.children.length > 0) {
            const childrenHTML = property.children.map(child => 
                this.generatePropertyHTML(child, indentLevel + 1)
            ).join('');

            propertyHTML += `
                <div class="property-children hidden mt-1 ml-4 border-l border-input pl-2">
                    ${childrenHTML}
                </div>
            `;
        }

        propertyHTML += '</div>';
        return propertyHTML;
    }

    /**
     * Generate CSS classes for expandable elements
     */
    getExpandableRowClasses(): string[] {
        return [
            'expandable-row',
            'expandable-row-header',
            'expandable-row-content',
            'property-list',
            'property-item',
            'property-header',
            'property-children',
            'property-expandable',
            'property-type-primitive',
            'property-type-object',
            'property-type-array'
        ];
    }

    /**
     * Update configuration
     */
    updateConfig(newConfig: Partial<ExpandableRowConfig>): void {
        this.config = { ...this.config, ...newConfig };
    }

    /**
     * Get current configuration
     */
    getConfig(): ExpandableRowConfig {
        return { ...this.config };
    }

    /**
     * Create flattened representation for table display
     */
    flattenForTable(obj: any, prefix = '', maxDepth = 3): Record<string, any> {
        const flattened: Record<string, any> = {};

        if (typeof obj !== 'object' || obj === null) {
            flattened[prefix || 'value'] = obj;
            return flattened;
        }

        if (Array.isArray(obj)) {
            flattened[prefix || 'array'] = this.formatArray(obj);
            return flattened;
        }

        const currentDepth = prefix.split('.').length - 1;
        if (currentDepth >= maxDepth) {
            flattened[prefix] = this.formatObject(obj);
            return flattened;
        }

        for (const [key, value] of Object.entries(obj)) {
            const newKey = prefix ? `${prefix}.${key}` : key;
            
            if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                Object.assign(flattened, this.flattenForTable(value, newKey, maxDepth));
            } else {
                flattened[newKey] = value;
            }
        }

        return flattened;
    }
}