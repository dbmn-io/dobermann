// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { ITemplateEngine, TemplateFragment, TemplateContext, RenderOptions } from './template-engine.interface';

export class TemplateEngine implements ITemplateEngine {
  private fragments = new Map<string, TemplateFragment>();

  registerFragment(fragment: TemplateFragment): void {
    this.fragments.set(fragment.id, fragment);
  }

  render(fragmentId: string, context: TemplateContext, options?: RenderOptions): string {
    const fragment = this.fragments.get(fragmentId);
    if (!fragment) {
      throw new Error(`Template fragment not found: ${fragmentId}`);
    }

    return this.renderString(fragment.content, context, options);
  }

  renderString(template: string, context: TemplateContext, options?: RenderOptions): string {
    const opts = {
      escapeHtml: false,
      preserveWhitespace: false,
      includeComments: false,
      ...options
    };

    let result = template;

    // Replace variables with context values
    result = result.replace(/\{\{([^}]+)\}\}/g, (match, variable) => {
      const trimmedVar = variable.trim();
      const value = this.getNestedValue(context, trimmedVar);
      
      if (value === undefined || value === null) {
        return '';
      }

      const stringValue = String(value);
      return opts.escapeHtml ? this.escapeHtml(stringValue) : stringValue;
    });

    // Handle conditional blocks {{#condition}}...{{/condition}}
    result = this.processConditionals(result, context);

    // Handle loop blocks {{#each items}}...{{/each}}
    result = this.processLoops(result, context);

    if (!opts.preserveWhitespace) {
      result = result.replace(/\s+/g, ' ').trim();
    }

    if (!opts.includeComments) {
      result = result.replace(/<!--[\s\S]*?-->/g, '');
    }

    return result;
  }

  getFragments(): TemplateFragment[] {
    return Array.from(this.fragments.values());
  }

  getFragment(fragmentId: string): TemplateFragment | undefined {
    return this.fragments.get(fragmentId);
  }

  extractVariables(template: string): string[] {
    const variables = new Set<string>();
    const regex = /\{\{([^}]+)\}\}/g;
    let match;

    while ((match = regex.exec(template)) !== null) {
      const variable = match[1].trim();
      // Skip conditional and loop syntax
      if (!variable.startsWith('#') && !variable.startsWith('/')) {
        variables.add(variable);
      }
    }

    return Array.from(variables);
  }

  validateTemplate(template: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Check for unclosed variable tags - look for {{ without matching }}
    let openBraces = 0;
    let unclosedStart = -1;
    
    for (let i = 0; i < template.length - 1; i++) {
      if (template[i] === '{' && template[i + 1] === '{') {
        if (openBraces === 0) {
          unclosedStart = i;
        }
        openBraces++;
        i++; // skip next brace
      } else if (template[i] === '}' && template[i + 1] === '}') {
        openBraces--;
        if (openBraces < 0) {
          // Found }} without opening {{
          const start = Math.max(0, i - 10);
          const end = Math.min(template.length, i + 12);
          errors.push(`Unopened variable tag: ${template.slice(start, end).trim()}`);
        }
        i++; // skip next brace
      }
    }
    
    if (openBraces > 0 && unclosedStart >= 0) {
      const unclosedPart = template.slice(unclosedStart);
      errors.push(`Unclosed variable tag: ${unclosedPart}`);
    }

    // Check for invalid variable names
    const variables = this.extractVariables(template);
    variables.forEach(variable => {
      if (!this.isValidVariableName(variable)) {
        errors.push(`Invalid variable name: ${variable}`);
      }
    });

    return {
      valid: errors.length === 0,
      errors
    };
  }

  renderConditional(condition: boolean, ifTrue: string, ifFalse?: string): string {
    if (condition) {
      return ifTrue;
    }
    return ifFalse || '';
  }

  renderLoop<T>(items: T[], template: string, itemName: string = 'item'): string {
    if (!items || items.length === 0) {
      return '';
    }

    return items
      .map((item, index) => {
        const context: TemplateContext = {
          [itemName]: item,
          index
        };
        return this.renderString(template, context);
      })
      .join('');
  }

  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => {
      return current && current[key] !== undefined ? current[key] : undefined;
    }, obj);
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }

  private isValidVariableName(name: string): boolean {
    // Variable names should start with letter or underscore, 
    // followed by letters, numbers, underscores, or dots (for nested access)
    return /^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(name);
  }

  private processConditionals(template: string, context: TemplateContext): string {
    // Handle {{#variable}}...{{/variable}} blocks
    return template.replace(/\{\{#([^}]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (match, variable, content) => {
      const value = this.getNestedValue(context, variable.trim());
      const isTruthy = Boolean(value);
      return isTruthy ? content : '';
    });
  }

  private processLoops(template: string, context: TemplateContext): string {
    // Handle {{#each items}}...{{/each}} blocks
    return template.replace(/\{\{#each\s+([^}]+)\}\}([\s\S]*?)\{\{\/each\}\}/g, (match, arrayPath, content) => {
      const items = this.getNestedValue(context, arrayPath.trim());
      if (!Array.isArray(items)) {
        return '';
      }

      return items
        .map((item, index) => {
          const loopContext = {
            ...context,
            item,
            index,
            '@index': index,
            '@first': index === 0,
            '@last': index === items.length - 1
          };
          return this.renderString(content, loopContext);
        })
        .join('');
    });
  }
}