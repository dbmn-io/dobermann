// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Progressive Disclosure Manager for Report Generation
 * Manages hierarchical data display with intelligent depth control
 * Part of Phase 3: Nested Data Handling
 */

export interface DisclosureLevel {
    depth: number;
    label: string;
    description: string;
    itemCount: number;
    isVisible: boolean;
    isCollapsible: boolean;
    children: DisclosureItem[];
}

export interface DisclosureItem {
    id: string;
    path: string;
    label: string;
    type: 'object' | 'array' | 'primitive';
    value: any;
    previewText: string;
    depth: number;
    hasChildren: boolean;
    isExpanded: boolean;
    children?: DisclosureItem[];
    parent?: DisclosureItem;
}

export interface HierarchyAnalysis {
    maxDepth: number;
    totalItems: number;
    levels: DisclosureLevel[];
    recommendations: DisclosureRecommendation[];
}

export interface DisclosureRecommendation {
    type: 'collapse_deep' | 'limit_siblings' | 'virtualize_large' | 'modal_array';
    message: string;
    affectedPaths: string[];
    threshold: number;
    priority: 'low' | 'medium' | 'high';
}

export interface ProgressiveDisclosureConfig {
    autoCollapseDepth: number;        // Automatically collapse levels deeper than this
    maxItemsPerLevel: number;         // Max items to show per level before pagination
    maxSiblingsExpanded: number;      // Max sibling items expanded simultaneously
    virtualizeThreshold: number;      // Item count threshold for virtualization
    previewLength: number;           // Character length for preview text
    enableSmartCollapse: boolean;     // Automatically collapse less relevant sections
}

export class ProgressiveDisclosureManagerService {
    private config: ProgressiveDisclosureConfig = {
        autoCollapseDepth: 3,
        maxItemsPerLevel: 50,
        maxSiblingsExpanded: 5,
        virtualizeThreshold: 100,
        previewLength: 80,
        enableSmartCollapse: true
    };

    private expandedPaths = new Set<string>();
    private collapsedBySystem = new Set<string>();

    /**
     * Analyze hierarchical data structure and create disclosure strategy
     */
    analyzeHierarchy(data: any, rootPath = 'root'): HierarchyAnalysis {
        const levels: DisclosureLevel[] = [];
        const recommendations: DisclosureRecommendation[] = [];
        let maxDepth = 0;
        let totalItems = 0;

        // Build the hierarchy tree
        const rootItems = this.buildDisclosureTree(data, rootPath, 0);
        
        // Analyze each depth level
        const depthMap = new Map<number, DisclosureItem[]>();
        this.collectItemsByDepth(rootItems, depthMap);

        for (const [depth, items] of depthMap.entries()) {
            maxDepth = Math.max(maxDepth, depth);
            totalItems += items.length;

            const level: DisclosureLevel = {
                depth,
                label: this.generateLevelLabel(depth),
                description: this.generateLevelDescription(depth, items.length),
                itemCount: items.length,
                isVisible: depth <= this.config.autoCollapseDepth,
                isCollapsible: depth > 0,
                children: items
            };

            levels.push(level);

            // Generate recommendations for this level
            recommendations.push(...this.generateLevelRecommendations(level));
        }

        // Apply smart collapse recommendations
        if (this.config.enableSmartCollapse) {
            this.applySmartCollapse(levels);
        }

        return {
            maxDepth,
            totalItems,
            levels,
            recommendations: this.prioritizeRecommendations(recommendations)
        };
    }

    /**
     * Build hierarchical tree of disclosure items
     */
    private buildDisclosureTree(data: any, path: string, depth: number, parent?: DisclosureItem): DisclosureItem[] {
        const items: DisclosureItem[] = [];

        if (Array.isArray(data)) {
            data.forEach((item, index) => {
                const itemPath = `${path}[${index}]`;
                const disclosureItem = this.createDisclosureItem(
                    itemPath, 
                    `[${index}]`, 
                    item, 
                    depth + 1, 
                    parent
                );
                items.push(disclosureItem);
            });
        } else if (typeof data === 'object' && data !== null) {
            Object.entries(data).forEach(([key, value]) => {
                const itemPath = path === 'root' ? key : `${path}.${key}`;
                const disclosureItem = this.createDisclosureItem(
                    itemPath, 
                    key, 
                    value, 
                    depth + 1, 
                    parent
                );
                items.push(disclosureItem);
            });
        }

        return items;
    }

    /**
     * Create a single disclosure item
     */
    private createDisclosureItem(
        path: string, 
        label: string, 
        value: any, 
        depth: number, 
        parent?: DisclosureItem
    ): DisclosureItem {
        const type = this.determineItemType(value);
        const hasChildren = type !== 'primitive';
        const previewText = this.generatePreviewText(value, type);

        const item: DisclosureItem = {
            id: this.generateItemId(path),
            path,
            label,
            type,
            value,
            previewText,
            depth,
            hasChildren,
            isExpanded: this.shouldExpandByDefault(path, depth, type),
            parent
        };

        // Add children if the item should be expanded
        if (hasChildren && item.isExpanded) {
            item.children = this.buildDisclosureTree(value, path, depth, item);
        }

        return item;
    }

    /**
     * Determine item type
     */
    private determineItemType(value: any): 'object' | 'array' | 'primitive' {
        if (Array.isArray(value)) return 'array';
        if (typeof value === 'object' && value !== null) return 'object';
        return 'primitive';
    }

    /**
     * Generate preview text for different value types
     */
    private generatePreviewText(value: any, type: 'object' | 'array' | 'primitive'): string {
        if (value === null) return 'null';
        if (value === undefined) return 'undefined';

        switch (type) {
            case 'primitive':
                const str = String(value);
                return str.length > this.config.previewLength 
                    ? `${str.substring(0, this.config.previewLength)}...`
                    : str;
            
            case 'array':
                return `Array(${value.length})`;
            
            case 'object':
                const keys = Object.keys(value);
                return `Object(${keys.length} ${keys.length === 1 ? 'property' : 'properties'})`;
            
            default:
                return String(value);
        }
    }

    /**
     * Determine if item should be expanded by default
     */
    private shouldExpandByDefault(path: string, depth: number, type: 'object' | 'array' | 'primitive'): boolean {
        // Don't expand beyond auto-collapse depth
        if (depth > this.config.autoCollapseDepth) {
            return false;
        }

        // Check if explicitly expanded by user
        if (this.expandedPaths.has(path)) {
            return true;
        }

        // Don't expand if collapsed by system
        if (this.collapsedBySystem.has(path)) {
            return false;
        }

        // Default expansion rules
        if (type === 'primitive') return false;
        if (depth <= 1) return true; // Always expand first level
        if (depth <= 2 && type === 'object') return true; // Expand objects up to depth 2
        
        return false;
    }

    /**
     * Collect items by depth for analysis
     */
    private collectItemsByDepth(items: DisclosureItem[], depthMap: Map<number, DisclosureItem[]>): void {
        items.forEach(item => {
            if (!depthMap.has(item.depth)) {
                depthMap.set(item.depth, []);
            }
            depthMap.get(item.depth)!.push(item);

            if (item.children) {
                this.collectItemsByDepth(item.children, depthMap);
            }
        });
    }

    /**
     * Generate level label
     */
    private generateLevelLabel(depth: number): string {
        const labels = [
            'Root Level',
            'First Level Properties',
            'Nested Properties',
            'Deep Properties',
            'Very Deep Properties'
        ];
        return labels[depth] || `Level ${depth}`;
    }

    /**
     * Generate level description
     */
    private generateLevelDescription(depth: number, itemCount: number): string {
        const descriptions = [
            `Top-level structure with ${itemCount} items`,
            `Primary properties and immediate children (${itemCount} items)`,
            `Secondary nested structures (${itemCount} items)`,
            `Deep nested properties (${itemCount} items)`,
            `Very deep nested properties (${itemCount} items)`
        ];
        return descriptions[depth] || `Level ${depth} with ${itemCount} items`;
    }

    /**
     * Generate recommendations for a level
     */
    private generateLevelRecommendations(level: DisclosureLevel): DisclosureRecommendation[] {
        const recommendations: DisclosureRecommendation[] = [];
        const { depth, itemCount, children } = level;

        // Too many items at this level
        if (itemCount > this.config.maxItemsPerLevel) {
            recommendations.push({
                type: 'limit_siblings',
                message: `Level ${depth} has ${itemCount} items. Consider grouping or pagination.`,
                affectedPaths: children.map(child => child.path),
                threshold: this.config.maxItemsPerLevel,
                priority: 'medium'
            });
        }

        // Very deep nesting
        if (depth > this.config.autoCollapseDepth + 2) {
            recommendations.push({
                type: 'collapse_deep',
                message: `Level ${depth} is very deep. Consider auto-collapsing for better UX.`,
                affectedPaths: children.map(child => child.path),
                threshold: this.config.autoCollapseDepth + 2,
                priority: 'high'
            });
        }

        // Large arrays that should be virtualized
        const largeArrays = children.filter(child => 
            child.type === 'array' && 
            Array.isArray(child.value) && 
            child.value.length > this.config.virtualizeThreshold
        );

        if (largeArrays.length > 0) {
            recommendations.push({
                type: 'virtualize_large',
                message: `Found ${largeArrays.length} large arrays. Consider virtualization or modal display.`,
                affectedPaths: largeArrays.map(arr => arr.path),
                threshold: this.config.virtualizeThreshold,
                priority: 'medium'
            });
        }

        return recommendations;
    }

    /**
     * Apply smart collapse based on analysis
     */
    private applySmartCollapse(levels: DisclosureLevel[]): void {
        levels.forEach(level => {
            // Auto-collapse deep levels
            if (level.depth > this.config.autoCollapseDepth) {
                level.isVisible = false;
                level.children.forEach(child => {
                    child.isExpanded = false;
                    this.collapsedBySystem.add(child.path);
                });
            }

            // Limit expanded siblings
            const expandedChildren = level.children.filter(child => child.isExpanded);
            if (expandedChildren.length > this.config.maxSiblingsExpanded) {
                expandedChildren.slice(this.config.maxSiblingsExpanded).forEach(child => {
                    child.isExpanded = false;
                    this.collapsedBySystem.add(child.path);
                });
            }
        });
    }

    /**
     * Prioritize recommendations by importance
     */
    private prioritizeRecommendations(recommendations: DisclosureRecommendation[]): DisclosureRecommendation[] {
        return recommendations.sort((a, b) => {
            const priorityOrder = { high: 3, medium: 2, low: 1 };
            return priorityOrder[b.priority] - priorityOrder[a.priority];
        });
    }

    /**
     * Generate unique item ID
     */
    private generateItemId(path: string): string {
        return `disclosure-${path.replace(/[^a-zA-Z0-9]/g, '-')}`;
    }

    /**
     * Toggle expansion state of an item
     */
    toggleExpansion(path: string): boolean {
        if (this.expandedPaths.has(path)) {
            this.expandedPaths.delete(path);
            this.collapsedBySystem.add(path);
            return false;
        } else {
            this.expandedPaths.add(path);
            this.collapsedBySystem.delete(path);
            return true;
        }
    }

    /**
     * Expand all items up to a certain depth
     */
    expandToDepth(maxDepth: number, items: DisclosureItem[]): void {
        items.forEach(item => {
            if (item.depth <= maxDepth && item.hasChildren) {
                item.isExpanded = true;
                this.expandedPaths.add(item.path);
                this.collapsedBySystem.delete(item.path);

                if (item.children) {
                    this.expandToDepth(maxDepth, item.children);
                }
            }
        });
    }

    /**
     * Collapse all items beyond a certain depth
     */
    collapseFromDepth(minDepth: number, items: DisclosureItem[]): void {
        items.forEach(item => {
            if (item.depth >= minDepth) {
                item.isExpanded = false;
                this.expandedPaths.delete(item.path);
                this.collapsedBySystem.add(item.path);

                if (item.children) {
                    this.collapseFromDepth(minDepth, item.children);
                }
            }
        });
    }

    /**
     * Generate breadcrumb path for deep items
     */
    generateBreadcrumb(item: DisclosureItem): string[] {
        const breadcrumb: string[] = [];
        let current: DisclosureItem | undefined = item;

        while (current) {
            breadcrumb.unshift(current.label);
            current = current.parent;
        }

        return breadcrumb;
    }

    /**
     * Get current configuration
     */
    getConfig(): ProgressiveDisclosureConfig {
        return { ...this.config };
    }

    /**
     * Update configuration
     */
    updateConfig(newConfig: Partial<ProgressiveDisclosureConfig>): void {
        this.config = { ...this.config, ...newConfig };
    }

    /**
     * Reset expansion state
     */
    reset(): void {
        this.expandedPaths.clear();
        this.collapsedBySystem.clear();
    }

    /**
     * Generate HTML for progressive disclosure navigation
     */
    generateNavigationHTML(analysis: HierarchyAnalysis): string {
        return `
            <div class="disclosure-navigation mb-4 p-3 bg-code border rounded">
                <div class="flex items-center justify-between mb-3">
                    <h4 class="font-semibold text-base m-0">Data Hierarchy</h4>
                    <div class="disclosure-stats flex gap-3 text-xs">
                        <span class="stat-badge bg-secondary px-2 py-1 rounded">${analysis.totalItems} items</span>
                        <span class="stat-badge bg-secondary px-2 py-1 rounded">${analysis.maxDepth} levels deep</span>
                    </div>
                </div>
                
                <div class="disclosure-levels flex gap-2 mb-3">
                    ${analysis.levels.map(level => `
                        <button class="level-toggle btn text-xs px-3 py-1 rounded ${level.isVisible ? 'bg-secondary' : 'bg-code'}" 
                                data-depth="${level.depth}" 
                                title="${level.description}">
                            Level ${level.depth} (${level.itemCount})
                        </button>
                    `).join('')}
                </div>
                
                ${analysis.recommendations.length > 0 ? `
                    <div class="disclosure-recommendations">
                        <div class="recommendations-toggle cursor-pointer flex items-center gap-2 text-xs text-link">
                            <span>▶</span>
                            <span>${analysis.recommendations.length} optimization suggestions</span>
                        </div>
                        <div class="recommendations-content hidden mt-2 p-2 bg-editor rounded border text-xs">
                            ${analysis.recommendations.map(rec => `
                                <div class="recommendation-item mb-2 p-2 border-l-2 border-${rec.priority === 'high' ? 'error' : rec.priority === 'medium' ? 'warning' : 'info'} pl-2">
                                    <div class="font-semibold">${rec.type.replace('_', ' ').toUpperCase()}</div>
                                    <div class="text-description mt-1">${rec.message}</div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                ` : ''}
            </div>
        `;
    }
}