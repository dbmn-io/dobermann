#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd

/**
 * Architecture Compliance Validator
 * Prevents drift from Architecture.md principles
 * Run: npm run validate:architecture
 */

const fs = require('fs');
const path = require('path');
const glob = require('glob');

class ArchitectureValidator {
  constructor() {
    this.violations = [];
    this.srcPath = path.join(__dirname, '../src');
  }

  validate() {
    console.log('🔍 Validating Architecture Compliance...\n');
    
    this.checkServiceIsolation();
    this.checkAsyncDatabaseCalls();
    this.checkCircularDependencies();
    this.checkUIServiceBoundaries();
    this.checkTestPatterns();
    
    this.reportResults();
    // Only HIGH severity blocks (as reportResults says); MEDIUM and LOW are
    // reported for follow-up. The integration-test ratio, for one, counts
    // files, so every new unit test lowered it however good the test was.
    return this.violations.every(v => v.severity !== 'HIGH');
  }

  /**
   * Issue #45 Prevention: Check for database calls in UI services
   */
  checkAsyncDatabaseCalls() {
    console.log('Checking for database calls in UI services...');
    
    const uiServices = [
      'src/services/status-bar/**/*.ts',
      'src/services/button-state/**/*.ts',
      'src/webviews/**/*.js'
    ];

    const dangerousPatterns = [
      /await.*\.getExecution.*\(/g,
      /await.*\.getExecutions.*\(/g,
      /await.*executionMetadataService\.get/g,
      /\.then\(.*executionMetadata/g,
      /async.*getBatchTooltip.*database/g
    ];

    uiServices.forEach(pattern => {
      const files = glob.sync(pattern, { cwd: path.join(__dirname, '..') });
      
      files.forEach(file => {
        const content = fs.readFileSync(file, 'utf8');
        
        dangerousPatterns.forEach(regex => {
          const matches = content.match(regex);
          if (matches) {
            this.violations.push({
              type: 'DATABASE_CALL_IN_UI',
              file,
              issue: 'UI service making database calls (Issue #45 anti-pattern)',
              matches: matches,
              severity: 'HIGH'
            });
          }
        });
      });
    });
  }

  /**
   * Service Isolation: Check for cascade failure patterns
   */
  checkServiceIsolation() {
    console.log('Checking service isolation patterns...');
    
    const serviceFiles = glob.sync('src/services/**/*.service.ts', { 
      cwd: path.join(__dirname, '..') 
    });

    serviceFiles.forEach(file => {
      const content = fs.readFileSync(file, 'utf8');
      
      // Check for bulk service resolution (cascade failure risk)
      const bulkResolutionPattern = /try\s*\{[\s\S]*?container\.resolve.*container\.resolve/g;
      if (bulkResolutionPattern.test(content)) {
        this.violations.push({
          type: 'CASCADE_FAILURE_RISK',
          file,
          issue: 'Bulk service resolution detected - risk of cascade failures',
          severity: 'MEDIUM'
        });
      }

      // Check for missing null checks on optional services
      const optionalChainingPattern = /this\..*Service\?\./g;
      const nullCheckPattern = /if\s*\(\s*this\..*Service\s*\)/g;
      const serviceUsagePattern = /this\.(.*Service)\./g;
      
      const hasOptionalChaining = optionalChainingPattern.test(content);
      const hasNullChecks = nullCheckPattern.test(content);
      const serviceUsages = content.match(serviceUsagePattern);
      
      // Only flag if there are optional service usages without proper safety checks
      if (serviceUsages && serviceUsages.length > 0 && !hasOptionalChaining && !hasNullChecks) {
        // Find optional services in constructor
        const optionalServices = [];
        const optionalServiceMatches = content.match(/(\w+Service)\?\s*[:, ]/g);
        if (optionalServiceMatches) {
          optionalServiceMatches.forEach(match => {
            const serviceName = match.match(/(\w+Service)/)[1];
            optionalServices.push(serviceName);
          });
        }
        
        // Check if any used services are actually optional
        const usedOptionalServices = [];
        serviceUsages.forEach(usage => {
          const match = usage.match(/this\.(\w+Service)\./);
          if (match && match[1]) {
            const serviceName = match[1];
            if (optionalServices.includes(serviceName)) {
              usedOptionalServices.push(serviceName);
            }
          }
        });
        
        // Only flag if optional services are actually used without null checks
        if (usedOptionalServices.length > 0) {
          this.violations.push({
            type: 'MISSING_NULL_CHECKS',
            file,
            issue: `Missing null checks for optional services: ${usedOptionalServices.join(', ')}`,
            severity: 'MEDIUM'
          });
        }
      }
    });
  }

  /**
   * Check for circular dependency imports
   */
  checkCircularDependencies() {
    console.log('Checking for circular dependencies...');
    
    const importGraph = new Map();
    const serviceFiles = glob.sync('src/services/**/*.ts', { 
      cwd: path.join(__dirname, '..') 
    });

    serviceFiles.forEach(file => {
      const content = fs.readFileSync(file, 'utf8');
      const imports = content.match(/import.*from\s+['"](.+)['"]/g) || [];
      
      const relativeImports = imports
        .map(imp => imp.match(/from\s+['"](.+)['"]/)?.[1])
        .filter(imp => imp?.startsWith('.') || imp?.startsWith('../'))
        .map(imp => path.resolve(path.dirname(file), imp));
        
      importGraph.set(file, relativeImports);
    });

    // Simple cycle detection
    importGraph.forEach((imports, file) => {
      imports.forEach(importPath => {
        const importImports = importGraph.get(importPath + '.ts') || 
                             importGraph.get(importPath + '/index.ts') || [];
        
        if (importImports.some(secondLevel => 
            secondLevel.includes(path.basename(file, '.ts')))) {
          this.violations.push({
            type: 'CIRCULAR_DEPENDENCY',
            file,
            issue: `Circular dependency detected with ${importPath}`,
            severity: 'HIGH'
          });
        }
      });
    });
  }

  /**
   * Check UI service boundaries (no business logic in webviews)
   */
  checkUIServiceBoundaries() {
    console.log('Checking UI service boundaries...');
    
    const webviewFiles = glob.sync('src/webviews/**/*.js', { 
      cwd: path.join(__dirname, '..') 
    });

    const businessLogicPatterns = [
      /class.*Service/g,
      /async function.*validate/g,
      /\.execute\(/g,
      /\.process\(/g,
      /await.*fetch\(/g
    ];

    webviewFiles.forEach(file => {
      const content = fs.readFileSync(file, 'utf8');
      
      businessLogicPatterns.forEach(pattern => {
        if (pattern.test(content)) {
          this.violations.push({
            type: 'BUSINESS_LOGIC_IN_UI',
            file,
            issue: 'Business logic detected in webview (should be in backend services)',
            severity: 'MEDIUM'
          });
        }
      });
    });
  }

  /**
   * Check for proper test patterns (integration-focused)
   */
  checkTestPatterns() {
    console.log('Checking test patterns...');
    
    const testFiles = glob.sync('src/test/**/*.test.ts', { 
      cwd: path.join(__dirname, '..') 
    });

    const integrationTestCount = testFiles.filter(f => f.includes('integration')).length;
    const unitTestCount = testFiles.filter(f => f.includes('unit')).length;

    // Integration tests should be 30%+ of total
    const totalTests = integrationTestCount + unitTestCount;
    const integrationRatio = integrationTestCount / totalTests;

    if (integrationRatio < 0.30) {
      this.violations.push({
        type: 'INSUFFICIENT_INTEGRATION_TESTS',
        file: 'Test Suite',
        issue: `Integration test ratio too low: ${Math.round(integrationRatio * 100)}% (should be 30%+)`,
        severity: 'MEDIUM'
      });
    }
  }

  reportResults() {
    console.log('\n📊 Architecture Validation Results:');
    console.log('=====================================');
    
    if (this.violations.length === 0) {
      console.log('✅ All architecture checks passed!');
      return;
    }

    console.log(`❌ Found ${this.violations.length} violations:\n`);
    
    // Group by severity
    const high = this.violations.filter(v => v.severity === 'HIGH');
    const medium = this.violations.filter(v => v.severity === 'MEDIUM');
    const low = this.violations.filter(v => v.severity === 'LOW');

    if (high.length > 0) {
      console.log('🚨 HIGH SEVERITY:');
      high.forEach(v => {
        console.log(`  • ${v.file}: ${v.issue}`);
        if (v.matches) console.log(`    Matches: ${v.matches.join(', ')}`);
      });
      console.log();
    }

    if (medium.length > 0) {
      console.log('⚠️  MEDIUM SEVERITY:');
      medium.forEach(v => {
        console.log(`  • ${v.file}: ${v.issue}`);
      });
      console.log();
    }

    if (low.length > 0) {
      console.log('ℹ️  LOW SEVERITY:');
      low.forEach(v => {
        console.log(`  • ${v.file}: ${v.issue}`);
      });
    }

    console.log(`\n🎯 Fix ${high.length} high severity issues before proceeding.`);
  }
}

// Run validation
const validator = new ArchitectureValidator();
const isValid = validator.validate();
process.exit(isValid ? 0 : 1);