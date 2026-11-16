// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { substituteEnvDeep, substituteEnvVariables } from '../../../services/environment/env-template';

describe('{{ENV:name}} in paths, query parameters and headers', () => {
    const vars = { region: 'en', org: 'ACME' };

    it('puts the environment\'s value in, case-insensitively, and leaves run-time templates alone', () => {
        expect(substituteEnvVariables('/{{ENV:region}}/purchaseOrders/{{orderId}}', vars)).to.equal('/en/purchaseOrders/{{orderId}}');
        expect(substituteEnvVariables('/{{env:Region}}/x', { Region: 'r' })).to.equal('/r/x');
        expect(substituteEnvVariables('{{ ENV:org }}', vars)).to.equal('ACME');
    });

    it('keeps a name the environment lacks, so the missing-variable check can name it', () => {
        expect(substituteEnvVariables('/{{ENV:tenant}}/a', vars)).to.equal('/{{ENV:tenant}}/a');
        expect(substituteEnvVariables('/{{ENV:region}}', undefined)).to.equal('/{{ENV:region}}');
    });

    it('walks header and query maps in either shape', () => {
        const headers = { Organization: '{{ENV:org}}', Accept: { value: 'application/{{ENV:region}}', enabled: true } };
        expect(substituteEnvDeep(headers, vars)).to.deep.equal({ Organization: 'ACME', Accept: { value: 'application/en', enabled: true } });
        expect(substituteEnvDeep({ q: ['{{ENV:org}}', 1] }, vars)).to.deep.equal({ q: ['ACME', 1] });
    });
});
