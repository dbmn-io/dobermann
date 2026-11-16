// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * What Run API refuses before it starts: templates in the path, query parameters or headers
 * that nothing filled in. Replaces src/test/unit/commands/find-unresolved-variables.test.ts,
 * which tested the same rule on ExecutionCommands until the logic moved to the run
 * orchestrator (0f56152, 2026-10-07) and nothing ran it since.
 */
import { expect } from 'chai';
import { substituteEnvDeep, substituteEnvVariables } from '../../../services/environment/env-template';
import { unresolvedVariables } from '../../../services/execution/unresolved-variables';

describe('templates left in a request before Run API', () => {
    it('names a run-time value nobody supplied, in the path, a query parameter or a header, once each', () => {
        expect(unresolvedVariables({ path: '/orders/{{orderId}}/{{orderId}}', queryParams: { q: '{{dest}}', n: { value: '{{quantity:number}}' } }, headers: { 'X-Tenant': { value: '{{tenant}}', enabled: true } } } as never))
            .to.deep.equal(['{{orderId}}', '{{dest}}', '{{quantity:number}}', '{{tenant}}']);
    });

    it('lets generated and shorthand templates through', () => {
        expect(unresolvedVariables({ path: '/{{A8:date}}/{{V8:seq}}', queryParams: { a: '{{}}', b: '{{:number}}', c: '{{A8:datetime:YYYY-MM-DD}}' } } as never)).to.deep.equal([]);
    });

    it('does not look at the body: that is the JSON generator\'s, as for Run Batch', () => {
        expect(unresolvedVariables({ path: '/x', body: '{"user": "{{userName}}"}' } as never)).to.deep.equal([]);
    });

    it('an environment variable in the path is filled in first, and only then is the rest checked', () => {
        const env = { region: 'en' };
        const endpoint = { path: '/{{ENV:region}}/orders/{{orderId}}', headers: { Organization: '{{ENV:org}}' } };
        const filled = { ...endpoint, path: substituteEnvVariables(endpoint.path, env), headers: substituteEnvDeep(endpoint.headers, env) };
        expect(filled.path).to.equal('/en/orders/{{orderId}}');
        expect(unresolvedVariables(filled as never)).to.deep.equal(['{{orderId}}', '{{ENV:org}}']);
    });
});
