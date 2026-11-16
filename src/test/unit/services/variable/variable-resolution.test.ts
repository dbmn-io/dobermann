// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Unit tests for VariableResolutionService
 * GitHub Issues #113 and #126
 */

import { expect } from 'chai';
import { VariableResolutionService } from '../../../../services/variable/variable-resolution.service';
import { VariableResolutionContext } from '../../../../services/variable/variable-resolution.interface';

describe('VariableResolutionService', () => {
    let service: VariableResolutionService;

    beforeEach(() => {
        service = new VariableResolutionService();
    });

    describe('resolveVariable', () => {
        it('should resolve environment variables', () => {
            const context: VariableResolutionContext = {
                environmentId: 'env1',
                endpointId: 'ep1',
                environmentVariables: { org: 'TestOrg' }
            };

            const resolved = service.resolveVariable('org', context);
            expect(resolved).to.not.be.null;
            expect(resolved?.value).to.equal('TestOrg');
            expect(resolved?.source).to.equal('environment');
        });

        it('should resolve endpoint variables', () => {
            const context: VariableResolutionContext = {
                environmentId: 'env1',
                endpointId: 'ep1',
                endpointVariables: { apiKey: 'secret123' }
            };

            const resolved = service.resolveVariable('apiKey', context);
            expect(resolved).to.not.be.null;
            expect(resolved?.value).to.equal('secret123');
            expect(resolved?.source).to.equal('endpoint');
        });

        it('should resolve CSV variables with highest priority', () => {
            const context: VariableResolutionContext = {
                environmentId: 'env1',
                endpointId: 'ep1',
                environmentVariables: { orderId: 'env-order' },
                endpointVariables: { orderId: 'ep-order' },
                csvRow: { orderId: 'CSV-001' }
            };

            const resolved = service.resolveVariable('orderId', context);
            expect(resolved).to.not.be.null;
            expect(resolved?.value).to.equal('CSV-001');
            expect(resolved?.source).to.equal('csv');
        });

        it('should resolve user input variables', () => {
            const context: VariableResolutionContext = {
                environmentId: 'env1',
                endpointId: 'ep1',
                userInput: { customValue: 'userEntry' }
            };

            const resolved = service.resolveVariable('customValue', context);
            expect(resolved).to.not.be.null;
            expect(resolved?.value).to.equal('userEntry');
            expect(resolved?.source).to.equal('user');
        });

        it('should respect variable precedence: CSV > User > Endpoint > Environment', () => {
            // Endpoint overrides Environment
            const context1: VariableResolutionContext = {
                environmentId: 'env1',
                endpointId: 'ep1',
                environmentVariables: { var: 'env' },
                endpointVariables: { var: 'endpoint' }
            };
            expect(service.resolveVariable('var', context1)?.value).to.equal('endpoint');

            // User overrides Endpoint
            const context2: VariableResolutionContext = {
                environmentId: 'env1',
                endpointId: 'ep1',
                endpointVariables: { var: 'endpoint' },
                userInput: { var: 'user' }
            };
            expect(service.resolveVariable('var', context2)?.value).to.equal('user');

            // CSV overrides all
            const context3: VariableResolutionContext = {
                environmentId: 'env1',
                endpointId: 'ep1',
                environmentVariables: { var: 'env' },
                endpointVariables: { var: 'endpoint' },
                userInput: { var: 'user' },
                csvRow: { var: 'csv' }
            };
            expect(service.resolveVariable('var', context3)?.value).to.equal('csv');
        });

        it('should return null for unresolved variables', () => {
            const context: VariableResolutionContext = {
                environmentId: 'env1',
                endpointId: 'ep1',
                environmentVariables: { known: 'value' }
            };

            const resolved = service.resolveVariable('unknown', context);
            expect(resolved).to.be.null;
        });

        it('should skip empty string values', () => {
            const context: VariableResolutionContext = {
                environmentId: 'env1',
                endpointId: 'ep1',
                environmentVariables: { empty: '' },
                endpointVariables: { valid: 'value' }
            };

            expect(service.resolveVariable('empty', context)).to.be.null;
            expect(service.resolveVariable('valid', context)?.value).to.equal('value');
        });
    });

    describe('resolveAllVariables', () => {
        it('should resolve all variables in template', async () => {
            const context: VariableResolutionContext = {
                environmentId: 'env1',
                endpointId: 'ep1',
                environmentVariables: { org: 'TestOrg', userId: '12345' }
            };

            const result = await service.resolveAllVariables(
                'Organization: {{org}}, User: {{userId}}',
                context
            );

            expect(result.resolvedTemplate).to.equal('Organization: TestOrg, User: 12345');
            expect(result.unresolvedVariables).to.have.lengthOf(0);
        });

        it('should track unresolved variables', async () => {
            const context: VariableResolutionContext = {
                environmentId: 'env1',
                endpointId: 'ep1',
                environmentVariables: { known: 'value' }
            };

            const result = await service.resolveAllVariables(
                '{{known}}, {{unknown1}}, {{unknown2}}',
                context
            );

            expect(result.unresolvedVariables).to.have.members(['unknown1', 'unknown2']);
        });

        it('should leave unresolved variables in template', async () => {
            const context: VariableResolutionContext = {
                environmentId: 'env1',
                endpointId: 'ep1',
                environmentVariables: { known: 'value' }
            };

            const result = await service.resolveAllVariables(
                'Known: {{known}}, Unknown: {{unknown}}',
                context
            );

            expect(result.resolvedTemplate).to.equal('Known: value, Unknown: {{unknown}}');
        });

        it('should handle variables with type hints', async () => {
            const context: VariableResolutionContext = {
                environmentId: 'env1',
                endpointId: 'ep1',
                environmentVariables: { count: '42' }
            };

            const result = await service.resolveAllVariables(
                'Count: {{count:number}}',
                context
            );

            expect(result.resolvedTemplate).to.equal('Count: 42');
        });
    });

    describe('getRequiredVariables', () => {
        it('should return empty array when all variables resolved', async () => {
            const context: VariableResolutionContext = {
                environmentId: 'env1',
                endpointId: 'ep1',
                environmentVariables: { var1: 'val1', var2: 'val2' }
            };

            const required = await service.getRequiredVariables(
                '{{var1}} and {{var2}}',
                context
            );

            expect(required).to.deep.equal([]);
        });

        it('should return list of unresolved variable names', async () => {
            const context: VariableResolutionContext = {
                environmentId: 'env1',
                endpointId: 'ep1',
                environmentVariables: { known: 'value' }
            };

            const required = await service.getRequiredVariables(
                '{{known}}, {{unknown1}}, {{unknown2}}',
                context
            );

            expect(required).to.have.members(['unknown1', 'unknown2']);
        });

        it('should not include system variables (A8:, V8:)', async () => {
            const context: VariableResolutionContext = {
                environmentId: 'env1',
                endpointId: 'ep1'
            };

            const required = await service.getRequiredVariables(
                '{{A8:uuid}}, {{V8:timestamp}}, {{custom}}',
                context
            );

            expect(required).to.deep.equal(['custom']);
        });
    });

    describe('substituteVariables', () => {
        it('should substitute simple variables', () => {
            const result = service.substituteVariables(
                'Organization: {{org}}, User: {{userId}}',
                { org: 'TestOrg', userId: '12345' }
            );

            expect(result).to.equal('Organization: TestOrg, User: 12345');
        });

        it('should leave unresolved variables intact', () => {
            const result = service.substituteVariables(
                'Known: {{known}}, Unknown: {{unknown}}',
                { known: 'value' }
            );

            expect(result).to.equal('Known: value, Unknown: {{unknown}}');
        });

        it('should substitute variables in JSON templates', () => {
            const template = '{"orderId": "{{orderId}}", "quantity": {{qty}}}';
            const result = service.substituteVariables(template, {
                orderId: 'ORD-001',
                qty: '10'
            });

            expect(result).to.equal('{"orderId": "ORD-001", "quantity": 10}');
        });

        it('should handle empty template', () => {
            const result = service.substituteVariables('', { var: 'value' });
            expect(result).to.equal('');
        });
    });

    describe('setEnvironmentVariable and getEnvironmentVariables', () => {
        it('should set and get script-set environment variables', () => {
            service.setEnvironmentVariable('env1', 'scriptVar', 'scriptValue');

            const vars = service.getEnvironmentVariables('env1');
            expect(vars['scriptVar']).to.not.be.undefined;
            expect(vars['scriptVar'].value).to.equal('scriptValue');
            expect(vars['scriptVar'].source).to.equal('script-environment');
        });

        it('should isolate variables by environment', () => {
            service.setEnvironmentVariable('env1', 'var', 'val1');
            service.setEnvironmentVariable('env2', 'var', 'val2');

            expect(service.getEnvironmentVariables('env1')['var'].value).to.equal('val1');
            expect(service.getEnvironmentVariables('env2')['var'].value).to.equal('val2');
        });
    });

    describe('setRequestVariable', () => {
        it('should set request-scoped variables', () => {
            service.setRequestVariable('req1', 'reqVar', 'reqValue');

            const context: VariableResolutionContext = {
                environmentId: 'env1',
                endpointId: 'ep1',
                requestId: 'req1'
            };

            const resolved = service.resolveVariable('reqVar', context);
            expect(resolved?.value).to.equal('reqValue');
            expect(resolved?.source).to.equal('script-request');
        });

        it('should isolate variables by request', () => {
            service.setRequestVariable('req1', 'var', 'val1');
            service.setRequestVariable('req2', 'var', 'val2');

            const context1: VariableResolutionContext = {
                environmentId: 'env1',
                endpointId: 'ep1',
                requestId: 'req1'
            };
            const context2: VariableResolutionContext = {
                environmentId: 'env1',
                endpointId: 'ep1',
                requestId: 'req2'
            };

            expect(service.resolveVariable('var', context1)?.value).to.equal('val1');
            expect(service.resolveVariable('var', context2)?.value).to.equal('val2');
        });
    });

    describe('clearScriptVariables', () => {
        it('should clear script-set environment variables', () => {
            service.setEnvironmentVariable('env1', 'var1', 'val1');
            service.setEnvironmentVariable('env1', 'var2', 'val2');

            service.clearScriptVariables('env1');

            const vars = service.getEnvironmentVariables('env1');
            expect(Object.keys(vars)).to.have.lengthOf(0);
        });

        it('should not affect other environments', () => {
            service.setEnvironmentVariable('env1', 'var', 'val1');
            service.setEnvironmentVariable('env2', 'var', 'val2');

            service.clearScriptVariables('env1');

            expect(service.getEnvironmentVariables('env1')).to.deep.equal({});
            expect(service.getEnvironmentVariables('env2')['var'].value).to.equal('val2');
        });
    });

    describe('clearRequestVariables', () => {
        it('should clear request-scoped variables', () => {
            service.setRequestVariable('req1', 'var', 'value');

            service.clearRequestVariables('req1');

            const context: VariableResolutionContext = {
                environmentId: 'env1',
                endpointId: 'ep1',
                requestId: 'req1'
            };
            expect(service.resolveVariable('var', context)).to.be.null;
        });
    });

    describe('createVariableStore', () => {
        it('should create a store with get method', () => {
            const context: VariableResolutionContext = {
                environmentId: 'env1',
                endpointId: 'ep1',
                environmentVariables: { org: 'TestOrg' }
            };

            const store = service.createVariableStore(context);

            expect(store.get('org')).to.equal('TestOrg');
            expect(store.get('unknown')).to.be.undefined;
        });

        it('should create a store with setEnvironment method', () => {
            const context: VariableResolutionContext = {
                environmentId: 'env1',
                endpointId: 'ep1'
            };

            const store = service.createVariableStore(context);
            store.setEnvironment('newVar', 'newValue');

            // Verify it was set
            const vars = service.getEnvironmentVariables('env1');
            expect(vars['newVar'].value).to.equal('newValue');
        });

        it('should create a store with setRequest method', () => {
            const context: VariableResolutionContext = {
                environmentId: 'env1',
                endpointId: 'ep1',
                requestId: 'req1'
            };

            const store = service.createVariableStore(context);
            store.setRequest('reqVar', 'reqValue');

            // Verify via resolution
            const resolved = service.resolveVariable('reqVar', context);
            expect(resolved?.value).to.equal('reqValue');
        });

        it('should create a store with getAll method', () => {
            const context: VariableResolutionContext = {
                environmentId: 'env1',
                endpointId: 'ep1',
                environmentVariables: { env1: 'val1' },
                endpointVariables: { ep1: 'val2' },
                csvRow: { csv1: 'val3' }
            };

            const store = service.createVariableStore(context);
            const all = store.getAll();

            expect(all['env1'].source).to.equal('environment');
            expect(all['ep1'].source).to.equal('endpoint');
            expect(all['csv1'].source).to.equal('csv');
        });

        it('should create a store with isDefined method', () => {
            const context: VariableResolutionContext = {
                environmentId: 'env1',
                endpointId: 'ep1',
                environmentVariables: { defined: 'value' }
            };

            const store = service.createVariableStore(context);

            expect(store.isDefined('defined')).to.be.true;
            expect(store.isDefined('undefined')).to.be.false;
        });
    });

    describe('getAllEnvironmentVariables', () => {
        it('should combine config and script variables', () => {
            service.setEnvironmentVariable('env1', 'scriptVar', 'scriptValue');

            const all = service.getAllEnvironmentVariables('env1', {
                configVar: 'configValue'
            });

            expect(all['configVar'].value).to.equal('configValue');
            expect(all['configVar'].source).to.equal('environment');
            expect(all['scriptVar'].value).to.equal('scriptValue');
            expect(all['scriptVar'].source).to.equal('script-environment');
        });

        it('should let script variables override config variables', () => {
            service.setEnvironmentVariable('env1', 'var', 'scriptOverride');

            const all = service.getAllEnvironmentVariables('env1', {
                var: 'configValue'
            });

            expect(all['var'].value).to.equal('scriptOverride');
            expect(all['var'].source).to.equal('script-environment');
        });
    });
});
