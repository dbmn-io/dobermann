// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #424: environment variables with options and a place in the header, as the core sees them.
 */
import { expect } from 'chai';
import {
    formatOptions, hasUsableValue, headerVariableNames, optionLabel, parseOptions, variableOptions, variablesMissingAValue,
    type VariableSettingsMap
} from '../../../services/environment/variable-options';

type Env = { variables?: Record<string, string>; variableSettings?: VariableSettingsMap };
const env = (e: Env): Env => e;

describe('#424 variables with options', () => {
    it('which variables the header shows, in the order declared', () => {
        expect(headerVariableNames({ variableSettings: { company: { showInHeader: true, options: ['a'] }, client: { options: ['100'] }, org: { showInHeader: true } } })).to.deep.equal(['company', 'org']);
        expect(headerVariableNames({})).to.deep.equal([]);
    });

    it('options are what the user typed, org and location included: nothing comes from a token', () => {
        const env = { variables: { org: 'ACM-APAC-DEV', location: '', company: '' }, variableSettings: { company: { options: ['CRONUS', 'Contoso'] }, org: { showInHeader: true } } };
        expect(variableOptions(env, 'company')).to.deep.equal(['CRONUS', 'Contoso']);
        expect(variableOptions(env, 'org'), 'an org with nothing typed has no options').to.deep.equal([]);
        expect(variableOptions(env, 'location')).to.deep.equal([]);
        expect(variableOptions({}, 'org')).to.deep.equal([]);
    });

    it('a header variable is missing a value when it is not one of its options, or, with none, empty', () => {
        const env = { variables: { company: 'Gone', org: 'ACM-APAC-DEV', note: '', client: '100' }, variableSettings: { company: { showInHeader: true, options: ['CRONUS'] }, org: { showInHeader: true, options: ['ACM-APAC-DEV'] }, note: { showInHeader: true }, client: { showInHeader: true } } };
        const options = (name: string) => (name === 'company' ? ['CRONUS'] : name === 'org' ? ['ACM-APAC-DEV'] : []);
        expect(variablesMissingAValue(env, options)).to.deep.equal([
            { name: 'company', value: 'Gone', options: ['CRONUS'] },
            { name: 'note', value: '', options: [] }
        ]);
    });

    it('a variable a run needs (the base URL names it) is missing a value when empty or absent, in the header or not', () => {
        const env = { variables: { version: '', tenant: 'acme' }, variableSettings: {} };
        expect(variablesMissingAValue(env, () => [], ['version', 'tenant', 'company']).map(v => v.name)).to.deep.equal(['version', 'company']);
    });

    it('a usable value: one of the options, or with none, anything but empty', () => {
        expect(hasUsableValue({ value: 'a', options: ['a'] })).to.equal(true);
        expect(hasUsableValue({ value: 'b', options: ['a'] })).to.equal(false);
        expect(hasUsableValue({ value: ' ', options: [] })).to.equal(false);
        expect(hasUsableValue({ value: 'x', options: [] })).to.equal(true);
    });

    it('options typed as a comma list are trimmed and unique; `value = label` gives one a label', () => {
        expect(parseOptions(' CRONUS, Contoso ,,CRONUS\nFabrikam ')).to.deep.equal({ options: ['CRONUS', 'Contoso', 'Fabrikam'], labels: {} });
        expect(parseOptions('840 = Brisbane, 880=Melbourne, 900 =, 910 = 910')).to.deep.equal({ options: ['840', '880', '900', '910'], labels: { 840: 'Brisbane', 880: 'Melbourne' } });
    });

    it('labels read back as typed, and stand in for the value where it is picked', () => {
        expect(formatOptions({ options: ['840', '880', '900'], labels: { 840: 'Brisbane', 880: 'Melbourne' } })).to.equal('840 = Brisbane, 880 = Melbourne, 900');
        expect(optionLabel({ labels: { 840: 'Brisbane' } }, '840')).to.equal('Brisbane');
        expect(optionLabel({}, '900')).to.equal('900');
    });
});
