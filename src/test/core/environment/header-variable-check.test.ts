// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #424: before a run, every header variable and every variable the base URL names must hold a
 * value (one of its options, if it has any); the missing ones are asked for in one modal, the
 * answers are saved, and a cancel or an empty answer stops the run.
 */
import { expect } from 'chai';
import type { DbmnModalResult, DbmnModalSpec } from '../../../screens/modal.types';
import { ensureHeaderVariables, headerVariableSpec } from '../../../services/environment/header-variable-check';

function fakes(options: Record<string, string[]>, answer?: DbmnModalResult | 'no-modal') {
    const set: Array<[string, string, string]> = [];
    const added: Array<[string, string, string]> = [];
    const shown: DbmnModalSpec[] = [];
    const errors: string[] = [];
    const environments = {
        getVariableOptions: async (_id: string, name: string) => options[name] ?? [],
        setVariable: async (id: string, name: string, value: string) => { set.push([id, name, value]); },
        addVariableOption: async (id: string, name: string, value: string) => { added.push([id, name, value]); }
    };
    const host = {
        modal: () => answer === 'no-modal' ? undefined : { showModal: async (spec: DbmnModalSpec) => { shown.push(spec); return answer as DbmnModalResult; } },
        toast: { error: (message: string) => { errors.push(message); } }
    };
    return { environments, host, set, added, shown, errors };
}

const env = (variables: Record<string, string>, settings: Record<string, { showInHeader?: boolean; options?: string[]; labels?: Record<string, string> }>, baseUrl?: string) =>
    ({ id: 'env-1', name: 'Staging', variables, variableSettings: settings, baseUrl });

describe('#424 header variables before a run', () => {
    it('lets the run go when every header variable holds one of its options, without asking', async () => {
        const f = fakes({ org: ['acme', 'globex'] });
        expect(await ensureHeaderVariables(env({ org: 'acme' }, { org: { showInHeader: true } }), f.environments, f.host)).to.equal(true);
        expect(f.shown).to.deep.equal([]);
        expect(f.set).to.deep.equal([]);
    });

    it('never asks for a variable with no options that holds a value', async () => {
        const f = fakes({ org: [] });
        expect(await ensureHeaderVariables(env({ org: 'ACME' }, { org: { showInHeader: true } }), f.environments, f.host)).to.equal(true);
        expect(f.shown).to.deep.equal([]);
    });

    it('an empty header variable with no options blocks the run: asked for in a text box, what is typed joins its options', async () => {
        const f = fakes({ org: [] }, { actionId: 'use', fields: { org: ' ACME-DEV ' } });
        expect(await ensureHeaderVariables(env({ org: '' }, { org: { showInHeader: true } }), f.environments, f.host)).to.equal(true);
        expect(f.shown[0].title).to.equal('Set org');
        expect(f.shown[0].fields?.[0]).to.include({ id: 'org', type: 'text', value: '' });
        expect(f.added).to.deep.equal([['env-1', 'org', 'ACME-DEV']]);
        expect(f.set).to.deep.equal([]);
    });

    it('Use with the box still empty stops the run and says why', async () => {
        const f = fakes({ org: [] }, { actionId: 'use', fields: { org: '  ' } });
        expect(await ensureHeaderVariables(env({ org: '' }, { org: { showInHeader: true } }), f.environments, f.host)).to.equal(false);
        expect(f.errors[0]).to.contain('org needs a value');
        expect(f.added).to.deep.equal([]);
    });

    it('a header variable nobody needs is unticked from the header: never asked for', async () => {
        const f = fakes({ note: [] });
        expect(await ensureHeaderVariables(env({ note: '' }, { note: {} }), f.environments, f.host)).to.equal(true);
        expect(f.shown).to.deep.equal([]);
    });

    it('a variable the base URL names must have a value, in the header or not; it is saved as the value', async () => {
        const f = fakes({}, { actionId: 'use', fields: { version: 'v2' } });
        const ok = await ensureHeaderVariables(env({}, {}, 'https://api.example.com/{{version}}/data'), f.environments, f.host);
        expect(ok).to.equal(true);
        expect(f.shown[0].fields?.map(field => `${field.id}:${field.type}`)).to.deep.equal(['version:text']);
        expect(f.set).to.deep.equal([['env-1', 'version', 'v2']]);
        const filled = fakes({});
        expect(await ensureHeaderVariables(env({ version: 'v1' }, {}, 'https://api.example.com/{{ENV:version}}'), filled.environments, filled.host)).to.equal(true);
        expect(filled.shown).to.deep.equal([]);
    });

    it('asks for the missing value, names the variable, saves the pick and goes on', async () => {
        const f = fakes({ org: ['acme', 'globex'], region: ['eu', 'us'] }, { actionId: 'use', fields: { org: 'globex', region: 'eu' } });
        const ok = await ensureHeaderVariables(env({ org: '', region: 'apac' }, { org: { showInHeader: true }, region: { showInHeader: true, options: ['eu', 'us'] } }), f.environments, f.host);
        expect(ok).to.equal(true);
        expect(f.shown).to.have.length(1);
        expect(f.shown[0].title).to.equal('Pick org and region');
        expect(f.shown[0].fields?.map(field => field.id)).to.deep.equal(['org', 'region']);
        expect(f.shown[0].fields?.[0].options?.map(o => o.value)).to.deep.equal(['acme', 'globex']);
        expect(f.set).to.deep.equal([['env-1', 'org', 'globex'], ['env-1', 'region', 'eu']]);
    });

    it('a cancel stops the run and saves nothing', async () => {
        const f = fakes({ org: ['acme'] }, { actionId: 'cancel', fields: {} });
        expect(await ensureHeaderVariables(env({ org: '' }, { org: { showInHeader: true } }), f.environments, f.host)).to.equal(false);
        expect(f.set).to.deep.equal([]);
    });

    it('with nowhere to ask, says what to pick and stops the run', async () => {
        const f = fakes({ org: ['acme'] }, 'no-modal');
        expect(await ensureHeaderVariables(env({ org: '' }, { org: { showInHeader: true } }), f.environments, f.host)).to.equal(false);
        expect(f.errors[0]).to.contain('Staging').and.contain('org');
    });

    it('the modal: one select per variable, the current value kept when it is an option, Use is primary', () => {
        const spec = headerVariableSpec('Staging', [{ name: 'org', value: 'globex', options: ['acme', 'globex'] }]);
        expect(spec.title).to.equal('Pick org');
        expect(spec.fields?.[0]).to.include({ id: 'org', type: 'select', value: 'globex' });
        expect(spec.actions.map(a => `${a.id}:${a.variant}`)).to.deep.equal(['cancel:secondary', 'use:primary']);
    });

    it('an option with a label reads "label · value" in the pick list; the value is what is saved', async () => {
        const f = fakes({ site: ['840', '880'] }, { actionId: 'use', fields: { site: '880' } });
        const ok = await ensureHeaderVariables(env({ site: '' }, { site: { showInHeader: true, labels: { 840: 'Brisbane', 880: 'Melbourne' } } }), f.environments, f.host);
        expect(ok).to.equal(true);
        expect(f.shown[0].fields?.[0].options).to.deep.equal([{ value: '840', label: 'Brisbane · 840' }, { value: '880', label: 'Melbourne · 880' }]);
        expect(f.set).to.deep.equal([['env-1', 'site', '880']]);
    });
});
