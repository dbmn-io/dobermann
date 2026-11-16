// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
export interface TemplateContext {
  [key: string]: any;
}

export interface TemplateFragment {
  id: string;
  name: string;
  content: string;
  variables: string[];
}

export interface RenderOptions {
  escapeHtml?: boolean;
  preserveWhitespace?: boolean;
  includeComments?: boolean;
}

export interface ITemplateEngine {
  /**
   * Register a template fragment
   */
  registerFragment(fragment: TemplateFragment): void;

  /**
   * Render a template fragment with context
   */
  render(fragmentId: string, context: TemplateContext, options?: RenderOptions): string;

  /**
   * Render template from string with context
   */
  renderString(template: string, context: TemplateContext, options?: RenderOptions): string;

  /**
   * Get all registered fragments
   */
  getFragments(): TemplateFragment[];

  /**
   * Get a specific fragment by ID
   */
  getFragment(fragmentId: string): TemplateFragment | undefined;

  /**
   * Extract variables from template string
   */
  extractVariables(template: string): string[];

  /**
   * Validate template syntax
   */
  validateTemplate(template: string): { valid: boolean; errors: string[] };

  /**
   * Create conditional rendering helpers
   */
  renderConditional(condition: boolean, ifTrue: string, ifFalse?: string): string;

  /**
   * Create loop rendering helpers
   */
  renderLoop<T>(items: T[], template: string, itemName?: string): string;
}