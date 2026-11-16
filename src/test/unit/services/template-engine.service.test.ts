// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
// Mock vscode module before importing anything else
import '../../helpers/vscode-mock';

import { expect } from 'chai';
import * as sinon from 'sinon';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { TemplateEngine } from '../../../services/template-engine/template-engine.service';
import { ITemplateEngine, TemplateFragment, TemplateContext } from '../../../services/template-engine/template-engine.interface';

describe('TemplateEngine', () => {
  let templateEngine: ITemplateEngine;

  beforeEach(() => {
    templateEngine = new TemplateEngine();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('registerFragment', () => {
    it('should register a template fragment', () => {
      const fragment: TemplateFragment = {
        id: 'test-fragment',
        name: 'Test Fragment',
        content: '<div>{{message}}</div>',
        variables: ['message']
      };

      templateEngine.registerFragment(fragment);

      const registered = templateEngine.getFragment('test-fragment');
      expect(registered).to.deep.equal(fragment);
    });

    it('should overwrite existing fragments with same ID', () => {
      const fragment1: TemplateFragment = {
        id: 'test-fragment',
        name: 'First Fragment',
        content: '<div>{{first}}</div>',
        variables: ['first']
      };

      const fragment2: TemplateFragment = {
        id: 'test-fragment',
        name: 'Second Fragment',
        content: '<div>{{second}}</div>',
        variables: ['second']
      };

      templateEngine.registerFragment(fragment1);
      templateEngine.registerFragment(fragment2);

      const registered = templateEngine.getFragment('test-fragment');
      expect(registered).to.deep.equal(fragment2);
    });
  });

  describe('render', () => {
    it('should render simple template with variables', () => {
      const fragment: TemplateFragment = {
        id: 'button-fragment',
        name: 'Button Fragment',
        content: '<button class="{{cssClass}}" onclick="{{action}}()">{{text}}</button>',
        variables: ['cssClass', 'action', 'text']
      };

      templateEngine.registerFragment(fragment);

      const context: TemplateContext = {
        cssClass: 'btn-primary',
        action: 'runApi',
        text: 'Run API'
      };

      const result = templateEngine.render('button-fragment', context);

      expect(result).to.equal('<button class="btn-primary" onclick="runApi()">Run API</button>');
    });

    it('should handle missing variables gracefully', () => {
      const fragment: TemplateFragment = {
        id: 'incomplete-fragment',
        name: 'Incomplete Fragment',
        content: '<div>{{existing}} and {{missing}}</div>',
        variables: ['existing', 'missing']
      };

      templateEngine.registerFragment(fragment);

      const context: TemplateContext = {
        existing: 'present'
      };

      const result = templateEngine.render('incomplete-fragment', context);

      expect(result).to.equal('<div>present and </div>');
    });

    it('should throw error for non-existent fragment', () => {
      const context: TemplateContext = { message: 'test' };

      expect(() => {
        templateEngine.render('non-existent', context);
      }).to.throw('Template fragment not found: non-existent');
    });

    it('should handle empty context', () => {
      const fragment: TemplateFragment = {
        id: 'no-vars',
        name: 'No Variables',
        content: '<div>Static content</div>',
        variables: []
      };

      templateEngine.registerFragment(fragment);

      const result = templateEngine.render('no-vars', {});

      expect(result).to.equal('<div>Static content</div>');
    });
  });

  describe('renderString', () => {
    it('should render template string with context', () => {
      const template = '<span class="{{status}}">{{message}}</span>';
      const context: TemplateContext = {
        status: 'success',
        message: 'Operation completed'
      };

      const result = templateEngine.renderString(template, context);

      expect(result).to.equal('<span class="success">Operation completed</span>');
    });

    it('should handle nested object properties', () => {
      const template = '<div>{{user.name}} ({{user.email}})</div>';
      const context: TemplateContext = {
        user: {
          name: 'John Doe',
          email: 'john@example.com'
        }
      };

      const result = templateEngine.renderString(template, context);

      expect(result).to.equal('<div>John Doe (john@example.com)</div>');
    });

    it('should escape HTML when option is enabled', () => {
      const template = '<div>{{message}}</div>';
      const context: TemplateContext = {
        message: '<script>alert("xss")</script>'
      };

      const result = templateEngine.renderString(template, context, { escapeHtml: true });

      expect(result).to.equal('<div>&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</div>');
    });

    it('should not escape HTML when option is disabled', () => {
      const template = '<div>{{html}}</div>';
      const context: TemplateContext = {
        html: '<em>emphasized</em>'
      };

      const result = templateEngine.renderString(template, context, { escapeHtml: false });

      expect(result).to.equal('<div><em>emphasized</em></div>');
    });
  });

  describe('extractVariables', () => {
    it('should extract simple variables', () => {
      const template = '<div>{{name}} {{age}} {{city}}</div>';
      const variables = templateEngine.extractVariables(template);

      expect(variables).to.have.members(['name', 'age', 'city']);
    });

    it('should extract nested variables', () => {
      const template = '<div>{{user.name}} {{config.api.url}}</div>';
      const variables = templateEngine.extractVariables(template);

      expect(variables).to.have.members(['user.name', 'config.api.url']);
    });

    it('should handle duplicate variables', () => {
      const template = '<div>{{name}} and {{name}} again</div>';
      const variables = templateEngine.extractVariables(template);

      expect(variables).to.have.lengthOf(1);
      expect(variables).to.include('name');
    });

    it('should return empty array for template without variables', () => {
      const template = '<div>Static content only</div>';
      const variables = templateEngine.extractVariables(template);

      expect(variables).to.be.an('array').that.is.empty;
    });
  });

  describe('validateTemplate', () => {
    it('should validate correct template syntax', () => {
      const template = '<div>{{valid}} {{also.valid}}</div>';
      const result = templateEngine.validateTemplate(template);

      expect(result.valid).to.be.true;
      expect(result.errors).to.be.empty;
    });

    it('should detect unclosed variable tags', () => {
      const template = '<div>{{unclosed</div>';
      const result = templateEngine.validateTemplate(template);

      expect(result.valid).to.be.false;
      expect(result.errors.length).to.be.greaterThan(0);
      expect(result.errors[0]).to.include('Unclosed variable tag');
    });

    it('should detect unopened variable tags', () => {
      const template = '<div>unopened}}</div>';
      const result = templateEngine.validateTemplate(template);

      expect(result.valid).to.be.false;
      expect(result.errors.length).to.be.greaterThan(0);
      expect(result.errors[0]).to.include('Unopened variable tag');
    });

    it('should detect invalid variable names', () => {
      const template = '<div>{{123invalid}} {{also-invalid}}</div>';
      const result = templateEngine.validateTemplate(template);

      expect(result.valid).to.be.false;
      expect(result.errors).to.include('Invalid variable name: 123invalid');
      expect(result.errors).to.include('Invalid variable name: also-invalid');
    });
  });

  describe('renderConditional', () => {
    it('should render true condition', () => {
      const result = templateEngine.renderConditional(true, '<div>Show this</div>', '<div>Not this</div>');

      expect(result).to.equal('<div>Show this</div>');
    });

    it('should render false condition', () => {
      const result = templateEngine.renderConditional(false, '<div>Not this</div>', '<div>Show this</div>');

      expect(result).to.equal('<div>Show this</div>');
    });

    it('should return empty string for false condition without alternative', () => {
      const result = templateEngine.renderConditional(false, '<div>Not shown</div>');

      expect(result).to.equal('');
    });
  });

  describe('renderLoop', () => {
    it('should render loop with items', () => {
      const items = [
        { name: 'John', age: 30 },
        { name: 'Jane', age: 25 }
      ];
      const template = '<li>{{item.name}} is {{item.age}} years old</li>';

      const result = templateEngine.renderLoop(items, template, 'item');

      expect(result).to.equal('<li>John is 30 years old</li><li>Jane is 25 years old</li>');
    });

    it('should render loop with default item name', () => {
      const items = ['apple', 'banana', 'cherry'];
      const template = '<span>{{item}}</span>';

      const result = templateEngine.renderLoop(items, template);

      expect(result).to.equal('<span>apple</span><span>banana</span><span>cherry</span>');
    });

    it('should return empty string for empty array', () => {
      const items: any[] = [];
      const template = '<div>{{item}}</div>';

      const result = templateEngine.renderLoop(items, template);

      expect(result).to.equal('');
    });

    it('should handle loop with index', () => {
      const items = ['a', 'b', 'c'];
      const template = '<div>{{index}}: {{item}}</div>';

      const result = templateEngine.renderLoop(items, template);

      expect(result).to.equal('<div>0: a</div><div>1: b</div><div>2: c</div>');
    });
  });

  describe('getFragments', () => {
    it('should return empty array when no fragments registered', () => {
      const fragments = templateEngine.getFragments();

      expect(fragments).to.be.an('array').that.is.empty;
    });

    it('should return all registered fragments', () => {
      const fragment1: TemplateFragment = {
        id: 'frag1',
        name: 'Fragment 1',
        content: '<div>{{test1}}</div>',
        variables: ['test1']
      };

      const fragment2: TemplateFragment = {
        id: 'frag2',
        name: 'Fragment 2',
        content: '<div>{{test2}}</div>',
        variables: ['test2']
      };

      templateEngine.registerFragment(fragment1);
      templateEngine.registerFragment(fragment2);

      const fragments = templateEngine.getFragments();

      expect(fragments).to.have.lengthOf(2);
      expect(fragments).to.include.deep.members([fragment1, fragment2]);
    });
  });

  describe('integration tests', () => {
    it('should handle complex button state template', () => {
      const buttonTemplate: TemplateFragment = {
        id: 'execution-button',
        name: 'Execution Button',
        content: `
          <div class="button-group" data-endpoint-id="{{endpointId}}">
            <button 
              class="btn {{variant}}" 
              hx-post="/button-action" 
              hx-vals='{"action": "{{action}}", "endpointId": "{{endpointId}}"}'
              hx-target="#button-container-{{endpointId}}"
              hx-swap="outerHTML"
              {{disabled}}
            >
              {{#loading}}<span class="spinner"></span>{{/loading}}
              {{text}}
            </button>
          </div>
        `.trim(),
        variables: ['endpointId', 'variant', 'action', 'disabled', 'loading', 'text']
      };

      templateEngine.registerFragment(buttonTemplate);

      const context: TemplateContext = {
        endpointId: 'endpoint-1',
        variant: 'btn-primary',
        action: 'run-api',
        disabled: '',
        loading: false,
        text: 'Run API'
      };

      const result = templateEngine.render('execution-button', context);

      expect(result).to.include('data-endpoint-id="endpoint-1"');
      expect(result).to.include('class="btn btn-primary"');
      expect(result).to.include('"action": "run-api"');
      expect(result).to.include('Run API');
    });
  });
});