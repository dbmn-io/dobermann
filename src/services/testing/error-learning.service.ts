// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import * as vscode from 'vscode';
import { 
    IErrorLearningService, 
    FunctionalErrorPattern, 
    TestSuggestion, 
    ErrorPatternLibrary 
} from './error-learning.interface';
import { IExtensionDiagnosticLogger } from '../logging/extension-diagnostic-logger.interface';

export class ErrorLearningService implements IErrorLearningService {
    private readonly STORAGE_KEY = 'dbmn.errorLearning.patterns';
    private patterns: Map<string, FunctionalErrorPattern> = new Map();

    constructor(
        private context: vscode.ExtensionContext,
        private logger: IExtensionDiagnosticLogger
    ) {
        this.loadStoredPatterns();
    }

    async recordFunctionalError(
        executionId: string,
        endpointId: string,
        errorPattern: { location: string; code: string; message: string }
    ): Promise<void> {
        try {
            // Create a unique pattern ID based on endpoint, location, and code
            const patternId = this.generatePatternId(endpointId, errorPattern.location, errorPattern.code);

            const now = new Date().toISOString();
            const existingPattern = this.patterns.get(patternId);

            if (existingPattern) {
                // Update existing pattern
                existingPattern.frequency += 1;
                existingPattern.lastSeen = now;
                existingPattern.message = errorPattern.message; // Update with latest message
            } else {
                // Create new pattern
                const newPattern: FunctionalErrorPattern = {
                    id: patternId,
                    location: errorPattern.location,
                    errorCode: errorPattern.code,
                    message: errorPattern.message,
                    frequency: 1,
                    firstSeen: now,
                    lastSeen: now,
                    endpointId: endpointId,
                    suggestedTestAssertion: this.generateTestAssertion(errorPattern)
                };
                this.patterns.set(patternId, newPattern);
            }

            // Persist to storage
            await this.persistPatterns();

            this.logger.info(`[ErrorLearningService] Recorded functional error pattern for ${endpointId}`, undefined, {
                executionId,
                endpointId,
                patternId,
                errorCode: errorPattern.code,
                frequency: this.patterns.get(patternId)?.frequency
            });

        } catch (error) {
            this.logger.error('[ErrorLearningService] Failed to record functional error', error instanceof Error ? error : undefined);
        }
    }

    async getErrorPatterns(endpointId: string): Promise<FunctionalErrorPattern[]> {
        const endpointPatterns = Array.from(this.patterns.values())
            .filter(pattern => pattern.endpointId === endpointId)
            .sort((a, b) => b.frequency - a.frequency); // Most frequent first

        return endpointPatterns;
    }

    async suggestTestAssertions(endpointId: string): Promise<TestSuggestion[]> {
        const patterns = await this.getErrorPatterns(endpointId);
        const suggestions: TestSuggestion[] = [];

        // Group patterns by location for better suggestions
        const locationGroups = new Map<string, FunctionalErrorPattern[]>();
        patterns.forEach(pattern => {
            const existing = locationGroups.get(pattern.location) || [];
            existing.push(pattern);
            locationGroups.set(pattern.location, existing);
        });

        // Generate suggestions based on location groups
        for (const [location, locationPatterns] of locationGroups) {
            if (locationPatterns.length === 1) {
                // Single error pattern - specific test
                const pattern = locationPatterns[0];
                suggestions.push({
                    testName: `Validate ${location} - ${pattern.errorCode}`,
                    testScript: this.generateSpecificTestScript(pattern),
                    description: `Check for common ${pattern.errorCode} error in ${location}`,
                    confidence: Math.min(90, pattern.frequency * 10), // Higher frequency = higher confidence
                    basedOnPatterns: [pattern.id]
                });
            } else {
                // Multiple error patterns in same location - comprehensive test
                const totalFrequency = locationPatterns.reduce((sum, p) => sum + p.frequency, 0);
                const errorCodes = locationPatterns.map(p => p.errorCode);
                
                suggestions.push({
                    testName: `Comprehensive ${location} Validation`,
                    testScript: this.generateComprehensiveTestScript(location, locationPatterns),
                    description: `Check for multiple common errors in ${location}: ${errorCodes.join(', ')}`,
                    confidence: Math.min(95, totalFrequency * 5), // Multiple patterns = higher confidence
                    basedOnPatterns: locationPatterns.map(p => p.id)
                });
            }
        }

        // Sort by confidence
        return suggestions.sort((a, b) => b.confidence - a.confidence);
    }

    async exportErrorPatterns(endpointId: string): Promise<ErrorPatternLibrary> {
        const patterns = await this.getErrorPatterns(endpointId);
        
        return {
            version: '1.0.0',
            patterns,
            generatedAt: new Date().toISOString(),
            endpointId
        };
    }

    async importErrorPatterns(library: ErrorPatternLibrary): Promise<void> {
        try {
            let importedCount = 0;
            
            for (const pattern of library.patterns) {
                // Generate new ID to avoid conflicts, but preserve original data
                const newPatternId = this.generatePatternId(pattern.endpointId, pattern.location, pattern.errorCode);
                
                const existingPattern = this.patterns.get(newPatternId);
                if (existingPattern) {
                    // Merge with existing pattern
                    existingPattern.frequency += pattern.frequency;
                    existingPattern.lastSeen = new Date().toISOString();
                } else {
                    // Import as new pattern
                    this.patterns.set(newPatternId, {
                        ...pattern,
                        id: newPatternId
                    });
                    importedCount++;
                }
            }

            await this.persistPatterns();

            this.logger.info(`[ErrorLearningService] Imported error pattern library`, undefined, {
                libraryVersion: library.version,
                totalPatterns: library.patterns.length,
                newPatterns: importedCount,
                endpointId: library.endpointId
            });

        } catch (error) {
            this.logger.error('[ErrorLearningService] Failed to import error patterns', error instanceof Error ? error : undefined);
            throw error;
        }
    }

    async getLearningSummary(): Promise<{
        totalPatterns: number;
        endpointsWithPatterns: number;
        mostCommonErrors: Array<{ code: string; frequency: number; endpoints: string[] }>;
    }> {
        const allPatterns = Array.from(this.patterns.values());
        const endpointIds = new Set(allPatterns.map(p => p.endpointId));
        
        // Group by error code
        const errorCodeGroups = new Map<string, { frequency: number; endpoints: Set<string> }>();
        allPatterns.forEach(pattern => {
            const existing = errorCodeGroups.get(pattern.errorCode) || { frequency: 0, endpoints: new Set() };
            existing.frequency += pattern.frequency;
            existing.endpoints.add(pattern.endpointId);
            errorCodeGroups.set(pattern.errorCode, existing);
        });

        // Convert to sorted array
        const mostCommonErrors = Array.from(errorCodeGroups.entries())
            .map(([code, data]) => ({
                code,
                frequency: data.frequency,
                endpoints: Array.from(data.endpoints)
            }))
            .sort((a, b) => b.frequency - a.frequency)
            .slice(0, 10); // Top 10

        return {
            totalPatterns: allPatterns.length,
            endpointsWithPatterns: endpointIds.size,
            mostCommonErrors
        };
    }

    async clearAllPatterns(): Promise<void> {
        this.patterns.clear();
        await this.context.globalState.update(this.STORAGE_KEY, undefined);
        this.logger.info('[ErrorLearningService] Cleared all learned error patterns');
    }

    private generatePatternId(endpointId: string, location: string, errorCode: string): string {
        return `${endpointId}:${location}:${errorCode}`.toLowerCase().replace(/[^a-z0-9:]/g, '_');
    }

    private generateTestAssertion(errorPattern: { location: string; code: string; message: string }): string {
        const { location, code, message } = errorPattern;
        
        // Generate test assertions based on common patterns
        if (location.toLowerCase().includes('validation')) {
            return `expect(response.json().ValidationErrors).to.not.include('${code}');`;
        } else if (location.toLowerCase().includes('location')) {
            return `expect(response.json().LocationError).to.not.equal('${code}');`;
        } else if (location.toLowerCase().includes('batch')) {
            return `const batchResult = analyzeBatch(response.json().TransactionResults);\nexpect(batchResult.criticalErrors).to.not.include('${message}');`;
        } else {
            return `expect(response.json().Errors).to.not.deep.include({ Code: '${code}', Message: '${message}' });`;
        }
    }

    private generateSpecificTestScript(pattern: FunctionalErrorPattern): string {
        return `// Auto-generated test based on learned error pattern (frequency: ${pattern.frequency})
// Pattern ID: ${pattern.id}

expect(response.status).to.equal(200);
const result = response.json();

// Check for specific error pattern: ${pattern.errorCode}
${pattern.suggestedTestAssertion}

// Report if functional error is found
if (result.Errors && result.Errors.some(e => e.Code === '${pattern.errorCode}')) {
    reportFunctionalError('${pattern.location}', '${pattern.errorCode}', '${pattern.message}');
    throw new Error('Functional validation failed: ${pattern.message}');
}`;
    }

    private generateComprehensiveTestScript(location: string, patterns: FunctionalErrorPattern[]): string {
        const errorChecks = patterns.map(pattern => 
            `    // Check for ${pattern.errorCode} (frequency: ${pattern.frequency})
    if (result.Errors && result.Errors.some(e => e.Code === '${pattern.errorCode}')) {
        reportFunctionalError('${pattern.location}', '${pattern.errorCode}', '${pattern.message}');
        errors.push('${pattern.errorCode}: ${pattern.message}');
    }`
        ).join('\n\n');

        return `// Auto-generated comprehensive test for ${location}
// Based on ${patterns.length} learned error patterns

expect(response.status).to.equal(200);
const result = response.json();
const errors = [];

${errorChecks}

// Throw error if any functional errors found
if (errors.length > 0) {
    throw new Error('Functional validation failed: ' + errors.join('; '));
}`;
    }

    private async loadStoredPatterns(): Promise<void> {
        try {
            const storedPatterns = this.context.globalState.get<Record<string, FunctionalErrorPattern>>(this.STORAGE_KEY);
            if (storedPatterns) {
                this.patterns = new Map(Object.entries(storedPatterns));
                this.logger.debug(`[ErrorLearningService] Loaded ${this.patterns.size} stored error patterns`);
            }
        } catch (error) {
            this.logger.error('[ErrorLearningService] Failed to load stored patterns', error instanceof Error ? error : undefined);
        }
    }

    private async persistPatterns(): Promise<void> {
        try {
            const patternsObject = Object.fromEntries(this.patterns);
            await this.context.globalState.update(this.STORAGE_KEY, patternsObject);
        } catch (error) {
            this.logger.error('[ErrorLearningService] Failed to persist patterns', error instanceof Error ? error : undefined);
        }
    }
}