// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Modal Manager Service for Report Generation
 * Manages modal displays for large arrays and complex nested data
 * Part of Phase 3: Nested Data Handling
 */

export interface ModalConfig {
    title: string;
    size: 'small' | 'medium' | 'large' | 'fullscreen';
    data: any[];
    dataType: 'array' | 'object' | 'mixed';
    displayMode: 'table' | 'json' | 'hierarchical';
    pagination?: PaginationConfig;
    search?: SearchConfig;
    export?: ExportConfig;
}

export interface PaginationConfig {
    enabled: boolean;
    pageSize: number;
    currentPage: number;
    totalPages: number;
    showPageInfo: boolean;
    showNavigation: boolean;
}

export interface SearchConfig {
    enabled: boolean;
    placeholder: string;
    searchableFields: string[];
    caseSensitive: boolean;
    regex: boolean;
}

export interface ExportConfig {
    enabled: boolean;
    formats: ('json' | 'csv' | 'excel')[];
    filename: string;
}

export interface ModalState {
    id: string;
    isOpen: boolean;
    config: ModalConfig;
    filteredData: any[];
    currentSearchTerm: string;
    selectedItems: Set<number>;
}

export class ModalManagerService {
    private modals = new Map<string, ModalState>();
    private modalCounter = 0;

    /**
     * Create and open a modal for large array display
     */
    openArrayModal(
        data: any[], 
        title: string = 'Array Data', 
        options: Partial<ModalConfig> = {}
    ): string {
        const modalId = this.generateModalId();
        
        const defaultConfig: ModalConfig = {
            title,
            size: this.determineOptimalSize(data.length),
            data,
            dataType: 'array',
            displayMode: this.determineOptimalDisplayMode(data),
            pagination: {
                enabled: data.length > 50,
                pageSize: 50,
                currentPage: 1,
                totalPages: Math.ceil(data.length / 50),
                showPageInfo: true,
                showNavigation: true
            },
            search: {
                enabled: data.length > 10,
                placeholder: 'Search array items...',
                searchableFields: this.extractSearchableFields(data),
                caseSensitive: false,
                regex: false
            },
            export: {
                enabled: true,
                formats: ['json', 'csv'],
                filename: `array-data-${Date.now()}`
            }
        };

        const config = { ...defaultConfig, ...options };
        
        const modalState: ModalState = {
            id: modalId,
            isOpen: true,
            config,
            filteredData: data,
            currentSearchTerm: '',
            selectedItems: new Set()
        };

        this.modals.set(modalId, modalState);
        return modalId;
    }

    /**
     * Create and open a modal for nested object display
     */
    openObjectModal(
        data: any, 
        title: string = 'Object Data', 
        options: Partial<ModalConfig> = {}
    ): string {
        const modalId = this.generateModalId();
        
        // Convert single object to array for consistent handling
        const arrayData = Array.isArray(data) ? data : [data];
        
        const defaultConfig: ModalConfig = {
            title,
            size: 'large',
            data: arrayData,
            dataType: 'object',
            displayMode: 'hierarchical',
            pagination: {
                enabled: false,
                pageSize: 1,
                currentPage: 1,
                totalPages: 1,
                showPageInfo: false,
                showNavigation: false
            },
            search: {
                enabled: this.hasSearchableContent(data),
                placeholder: 'Search object properties...',
                searchableFields: this.extractObjectPaths(data),
                caseSensitive: false,
                regex: false
            },
            export: {
                enabled: true,
                formats: ['json'],
                filename: `object-data-${Date.now()}`
            }
        };

        const config = { ...defaultConfig, ...options };
        
        const modalState: ModalState = {
            id: modalId,
            isOpen: true,
            config,
            filteredData: arrayData,
            currentSearchTerm: '',
            selectedItems: new Set()
        };

        this.modals.set(modalId, modalState);
        return modalId;
    }

    /**
     * Update search term and filter data
     */
    updateSearch(modalId: string, searchTerm: string): void {
        const modal = this.modals.get(modalId);
        if (!modal) return;

        modal.currentSearchTerm = searchTerm;
        
        if (searchTerm.trim() === '') {
            modal.filteredData = modal.config.data;
        } else {
            modal.filteredData = this.filterData(
                modal.config.data,
                searchTerm,
                modal.config.search!
            );
        }

        // Update pagination
        if (modal.config.pagination?.enabled) {
            modal.config.pagination.totalPages = Math.ceil(
                modal.filteredData.length / modal.config.pagination.pageSize
            );
            modal.config.pagination.currentPage = 1; // Reset to first page
        }
    }

    /**
     * Navigate to a specific page
     */
    goToPage(modalId: string, page: number): void {
        const modal = this.modals.get(modalId);
        if (!modal || !modal.config.pagination?.enabled) return;

        const maxPage = modal.config.pagination.totalPages;
        modal.config.pagination.currentPage = Math.max(1, Math.min(page, maxPage));
    }

    /**
     * Get paginated data for current page
     */
    getCurrentPageData(modalId: string): any[] {
        const modal = this.modals.get(modalId);
        if (!modal) return [];

        if (!modal.config.pagination?.enabled) {
            return modal.filteredData;
        }

        const { currentPage, pageSize } = modal.config.pagination;
        const startIndex = (currentPage - 1) * pageSize;
        const endIndex = startIndex + pageSize;

        return modal.filteredData.slice(startIndex, endIndex);
    }

    /**
     * Toggle item selection
     */
    toggleItemSelection(modalId: string, itemIndex: number): void {
        const modal = this.modals.get(modalId);
        if (!modal) return;

        if (modal.selectedItems.has(itemIndex)) {
            modal.selectedItems.delete(itemIndex);
        } else {
            modal.selectedItems.add(itemIndex);
        }
    }

    /**
     * Select all items on current page
     */
    selectAllCurrentPage(modalId: string): void {
        const modal = this.modals.get(modalId);
        if (!modal) return;

        const currentData = this.getCurrentPageData(modalId);
        const { currentPage, pageSize } = modal.config.pagination || { currentPage: 1, pageSize: currentData.length };
        const startIndex = (currentPage - 1) * pageSize;

        currentData.forEach((_, index) => {
            modal.selectedItems.add(startIndex + index);
        });
    }

    /**
     * Clear all selections
     */
    clearAllSelections(modalId: string): void {
        const modal = this.modals.get(modalId);
        if (!modal) return;

        modal.selectedItems.clear();
    }

    /**
     * Get selected items data
     */
    getSelectedItems(modalId: string): any[] {
        const modal = this.modals.get(modalId);
        if (!modal) return [];

        return Array.from(modal.selectedItems)
            .map(index => modal.config.data[index])
            .filter(item => item !== undefined);
    }

    /**
     * Close modal
     */
    closeModal(modalId: string): void {
        const modal = this.modals.get(modalId);
        if (!modal) return;

        modal.isOpen = false;
        // Keep modal state briefly for potential reopening
        setTimeout(() => {
            this.modals.delete(modalId);
        }, 1000);
    }

    /**
     * Get modal state
     */
    getModalState(modalId: string): ModalState | undefined {
        return this.modals.get(modalId);
    }

    /**
     * Get all open modals
     */
    getOpenModals(): ModalState[] {
        return Array.from(this.modals.values()).filter(modal => modal.isOpen);
    }

    /**
     * Determine optimal modal size based on data volume
     */
    private determineOptimalSize(dataLength: number): 'small' | 'medium' | 'large' | 'fullscreen' {
        if (dataLength < 10) return 'small';
        if (dataLength < 50) return 'medium';
        if (dataLength < 200) return 'large';
        return 'fullscreen';
    }

    /**
     * Determine optimal display mode based on data structure
     */
    private determineOptimalDisplayMode(data: any[]): 'table' | 'json' | 'hierarchical' {
        if (data.length === 0) return 'json';

        const sampleItem = data[0];
        
        // If items are primitives, use table
        if (typeof sampleItem !== 'object' || sampleItem === null) {
            return 'table';
        }

        // If items are simple objects (flat structure), use table
        const keys = Object.keys(sampleItem);
        const hasNestedObjects = keys.some(key => 
            typeof sampleItem[key] === 'object' && sampleItem[key] !== null
        );

        return hasNestedObjects ? 'hierarchical' : 'table';
    }

    /**
     * Extract searchable fields from data
     */
    private extractSearchableFields(data: any[]): string[] {
        if (data.length === 0) return [];

        const sampleItem = data[0];
        if (typeof sampleItem !== 'object' || sampleItem === null) {
            return ['value'];
        }

        const fields = Object.keys(sampleItem).filter(key => {
            const value = sampleItem[key];
            return typeof value === 'string' || typeof value === 'number';
        });

        return fields.slice(0, 10); // Limit to first 10 searchable fields
    }

    /**
     * Extract searchable paths from object
     */
    private extractObjectPaths(obj: any, prefix = '', maxDepth = 3): string[] {
        const paths: string[] = [];
        
        if (typeof obj !== 'object' || obj === null || maxDepth <= 0) {
            return paths;
        }

        for (const [key, value] of Object.entries(obj)) {
            const currentPath = prefix ? `${prefix}.${key}` : key;
            
            if (typeof value === 'string' || typeof value === 'number') {
                paths.push(currentPath);
            } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                paths.push(...this.extractObjectPaths(value, currentPath, maxDepth - 1));
            }
        }

        return paths.slice(0, 20); // Limit total paths
    }

    /**
     * Check if object has searchable content
     */
    private hasSearchableContent(data: any): boolean {
        if (typeof data !== 'object' || data === null) {
            return false;
        }

        return this.extractObjectPaths(data).length > 0;
    }

    /**
     * Filter data based on search criteria
     */
    private filterData(data: any[], searchTerm: string, searchConfig: SearchConfig): any[] {
        const term = searchConfig.caseSensitive ? searchTerm : searchTerm.toLowerCase();
        
        return data.filter(item => {
            if (typeof item !== 'object' || item === null) {
                const itemStr = String(item);
                const searchStr = searchConfig.caseSensitive ? itemStr : itemStr.toLowerCase();
                return searchConfig.regex 
                    ? new RegExp(term).test(searchStr)
                    : searchStr.includes(term);
            }

            // Search in specified fields
            return searchConfig.searchableFields.some(field => {
                const value = this.getNestedValue(item, field);
                if (value === undefined || value === null) return false;
                
                const valueStr = String(value);
                const searchStr = searchConfig.caseSensitive ? valueStr : valueStr.toLowerCase();
                
                return searchConfig.regex
                    ? new RegExp(term).test(searchStr)
                    : searchStr.includes(term);
            });
        });
    }

    /**
     * Get nested value from object using dot notation
     */
    private getNestedValue(obj: any, path: string): any {
        return path.split('.').reduce((current, key) => {
            return current && current[key] !== undefined ? current[key] : undefined;
        }, obj);
    }

    /**
     * Generate unique modal ID
     */
    private generateModalId(): string {
        return `modal-${++this.modalCounter}-${Date.now()}`;
    }

    /**
     * Generate modal HTML structure
     */
    generateModalHTML(modalState: ModalState): string {
        const { config, filteredData, currentSearchTerm } = modalState;
        const currentPageData = this.getCurrentPageData(modalState.id);

        return `
            <div class="modal" id="${modalState.id}" style="display: flex;">
                <div class="modal-content modal-size-${config.size}">
                    <div class="modal-header">
                        <h3 class="m-0">${config.title}</h3>
                        <span class="modal-close cursor-pointer text-lg">&times;</span>
                    </div>
                    
                    <div class="modal-toolbar p-3 border-b bg-code">
                        <div class="flex items-center justify-between gap-3">
                            ${config.search?.enabled ? `
                                <div class="search-container flex-1">
                                    <input type="text" 
                                           id="${modalState.id}-search" 
                                           class="w-full px-3 py-2 rounded border"
                                           placeholder="${config.search.placeholder}"
                                           value="${currentSearchTerm}">
                                </div>
                            ` : ''}
                            
                            <div class="modal-stats text-sm text-description">
                                ${filteredData.length} of ${config.data.length} items
                                ${modalState.selectedItems.size > 0 ? `(${modalState.selectedItems.size} selected)` : ''}
                            </div>
                            
                            ${config.export?.enabled ? `
                                <div class="export-controls flex gap-2">
                                    ${config.export.formats.map(format => `
                                        <button class="btn btn-secondary text-xs px-2 py-1" 
                                                data-action="export" 
                                                data-format="${format}">
                                            ${format.toUpperCase()}
                                        </button>
                                    `).join('')}
                                </div>
                            ` : ''}
                        </div>
                    </div>

                    <div class="modal-body overflow-auto">
                        ${this.generateModalBodyContent(modalState, currentPageData)}
                    </div>

                    ${config.pagination?.enabled && config.pagination.totalPages > 1 ? `
                        <div class="modal-footer">
                            <div class="pagination-controls flex items-center justify-between">
                                <div class="page-info text-sm">
                                    Page ${config.pagination.currentPage} of ${config.pagination.totalPages}
                                    (${(config.pagination.currentPage - 1) * config.pagination.pageSize + 1}-${Math.min(config.pagination.currentPage * config.pagination.pageSize, filteredData.length)} of ${filteredData.length})
                                </div>
                                <div class="page-navigation flex gap-2">
                                    <button class="btn btn-secondary" 
                                            ${config.pagination.currentPage <= 1 ? 'disabled' : ''}
                                            data-action="prev-page">Previous</button>
                                    <button class="btn btn-secondary"
                                            ${config.pagination.currentPage >= config.pagination.totalPages ? 'disabled' : ''}
                                            data-action="next-page">Next</button>
                                </div>
                            </div>
                        </div>
                    ` : ''}
                </div>
            </div>
        `;
    }

    /**
     * Generate modal body content based on display mode
     */
    private generateModalBodyContent(modalState: ModalState, data: any[]): string {
        const { config } = modalState;

        switch (config.displayMode) {
            case 'table':
                return this.generateTableContent(data, modalState);
            case 'hierarchical':
                return this.generateHierarchicalContent(data, modalState);
            case 'json':
                return this.generateJSONContent(data);
            default:
                return this.generateTableContent(data, modalState);
        }
    }

    /**
     * Generate table content for modal
     */
    private generateTableContent(data: any[], modalState: ModalState): string {
        if (data.length === 0) {
            return '<div class="text-center p-4 text-description">No data to display</div>';
        }

        // Handle primitive arrays
        if (typeof data[0] !== 'object' || data[0] === null) {
            return `
                <table class="w-full border-collapse">
                    <thead>
                        <tr class="bg-code">
                            <th class="border p-2 text-left">Index</th>
                            <th class="border p-2 text-left">Value</th>
                            <th class="border p-2 text-left">Type</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${data.map((item, index) => `
                            <tr class="hover-bg-hover">
                                <td class="border p-2 text-mono">${index}</td>
                                <td class="border p-2">${String(item)}</td>
                                <td class="border p-2 text-xs">${typeof item}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            `;
        }

        // Handle object arrays
        const columns = Object.keys(data[0]).slice(0, 10); // Limit columns
        return `
            <table class="w-full border-collapse">
                <thead>
                    <tr class="bg-code">
                        <th class="border p-2">
                            <input type="checkbox" id="${modalState.id}-select-all">
                        </th>
                        ${columns.map(col => `
                            <th class="border p-2 text-left">${col}</th>
                        `).join('')}
                    </tr>
                </thead>
                <tbody>
                    ${data.map((item, index) => `
                        <tr class="hover-bg-hover">
                            <td class="border p-2">
                                <input type="checkbox" 
                                       data-index="${index}"
                                       ${modalState.selectedItems.has(index) ? 'checked' : ''}>
                            </td>
                            ${columns.map(col => `
                                <td class="border p-2 max-w-xs overflow-hidden text-ellipsis">
                                    ${this.formatCellValue(item[col])}
                                </td>
                            `).join('')}
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    }

    /**
     * Generate hierarchical content for nested objects
     */
    private generateHierarchicalContent(data: any[], modalState: ModalState): string {
        return `
            <div class="hierarchical-content">
                ${data.map((item, index) => `
                    <div class="hierarchical-item mb-4 p-3 border rounded bg-editor">
                        <div class="item-header flex items-center justify-between mb-2">
                            <h4 class="font-semibold">Item ${index + 1}</h4>
                            <input type="checkbox" 
                                   data-index="${index}"
                                   ${modalState.selectedItems.has(index) ? 'checked' : ''}>
                        </div>
                        <div class="item-content">
                            ${this.generateObjectTree(item)}
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
    }

    /**
     * Generate JSON content
     */
    private generateJSONContent(data: any[]): string {
        return `
            <pre class="json-content text-mono text-sm bg-editor p-3 border rounded overflow-auto">
${JSON.stringify(data, null, 2)}
            </pre>
        `;
    }

    /**
     * Generate object tree HTML
     */
    private generateObjectTree(obj: any, depth = 0): string {
        if (typeof obj !== 'object' || obj === null) {
            return `<span class="property-value">${this.formatCellValue(obj)}</span>`;
        }

        const indentClass = `ml-${Math.min(depth * 2, 8)}`;
        
        return Object.entries(obj)
            .map(([key, value]) => `
                <div class="property-row ${indentClass} flex gap-2 py-1">
                    <span class="property-key font-medium text-mono">${key}:</span>
                    ${typeof value === 'object' && value !== null 
                        ? `<div class="nested-object">${this.generateObjectTree(value, depth + 1)}</div>`
                        : `<span class="property-value">${this.formatCellValue(value)}</span>`
                    }
                </div>
            `).join('');
    }

    /**
     * Format cell value for display
     */
    private formatCellValue(value: any): string {
        if (value === null) return '<span class="text-description">null</span>';
        if (value === undefined) return '<span class="text-description">undefined</span>';
        if (typeof value === 'string') {
            return value.length > 100 ? `${value.substring(0, 100)}...` : value;
        }
        if (typeof value === 'object') {
            return Array.isArray(value) 
                ? `<span class="text-description">[Array(${value.length})]</span>`
                : '<span class="text-description">[Object]</span>';
        }
        return String(value);
    }
}