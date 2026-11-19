// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/** The screen protocol both hosts share (modals, async submit, links), with no VS Code. */
import { expect } from 'chai';
import { ScreenSession } from '../../../screens/screen-session';
import { modalWaitError } from '../../../screens/modal.types';

function session() {
    const posted: Array<Record<string, unknown>> = [];
    const opened: string[] = [];
    const s = new ScreenSession({ post: m => posted.push(m) }, { openExternal: url => opened.push(url) });
    return { s, posted, opened };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('ScreenSession', () => {
    it('opens a modal on the screen and resolves with the chosen action', async () => {
        const { s, posted } = session();
        const result = s.showModal({ title: 'Delete?', actions: [{ id: 'confirm', label: 'Delete' }] });
        const request = posted[0] as { type: string; requestId: string };
        expect(request.type).to.equal('dbmnModalRequest');

        expect(await s.handleShared({ type: 'dbmnModalResult', requestId: request.requestId, result: { actionId: 'confirm', fields: {} } })).to.equal(true);
        expect(await result).to.deep.equal({ actionId: 'confirm', fields: {} });
    });

    it('runs an onSubmit action on the host and reports success or field errors to the screen', async () => {
        const { s, posted } = session();
        let attempts = 0;
        void s.showModal({
            actions: [{
                id: 'create', label: 'Create',
                onSubmit: async fields => {
                    attempts++;
                    if (fields.name === 'bad') {
                        const e = new Error('Invalid') as Error & { fieldErrors?: Record<string, string> };
                        e.fieldErrors = { name: 'Invalid' };
                        throw e;
                    }
                }
            }]
        });
        const { requestId, spec } = posted[0] as { requestId: string; spec: { actions: Array<Record<string, unknown>> } };
        expect(spec.actions[0]).to.include({ id: 'create', awaitsHostSubmit: true });
        expect(spec.actions[0]).to.not.have.property('onSubmit');

        await s.handleShared({ type: 'dbmnModalActionPending', requestId, submitId: 's1', actionId: 'create', fields: { name: 'bad' } });
        await tick();
        await s.handleShared({ type: 'dbmnModalActionPending', requestId, submitId: 's2', actionId: 'create', fields: { name: 'good' } });
        await tick();

        expect(attempts).to.equal(2);
        expect(posted.slice(1)).to.deep.equal([
            { type: 'dbmnModalActionResult', submitId: 's1', success: false, error: 'Invalid', fieldErrors: { name: 'Invalid' } },
            { type: 'dbmnModalActionResult', submitId: 's2', success: true }
        ]);
    });

    it('an onSubmit that says "not yet" (modalWaitError) hands the screen the wait to count down', async () => {
        const { s, posted } = session();
        const wait = { actionId: 'magic', field: 'email', seconds: 47, text: 'You can ask for another in {seconds}.' };
        void s.showModal({ actions: [{ id: 'magic', label: 'Email me a link', onSubmit: async () => { throw modalWaitError(wait); } }] });
        const requestId = (posted[0] as { requestId: string }).requestId;

        await s.handleShared({ type: 'dbmnModalActionPending', requestId, submitId: 's1', actionId: 'magic', fields: { email: 'a@b.c' } });
        await tick();

        expect(posted[1]).to.deep.equal({ type: 'dbmnModalActionResult', submitId: 's1', success: false, error: 'You can ask for another in 47 seconds.', wait });
    });

    it('a result carrying an error rejects; dismissAll resolves the rest as dismissed', async () => {
        const { s, posted } = session();
        const failing = s.showModal({ actions: [{ id: 'ok', label: 'OK' }] });
        const open = s.showModal({ actions: [{ id: 'ok', label: 'OK' }] });
        await s.handleShared({ type: 'dbmnModalResult', requestId: (posted[0] as { requestId: string }).requestId, result: { actionId: 'error', fields: {}, error: 'boom' } });

        let rejected: unknown;
        try { await failing; } catch (error) { rejected = error; }
        expect((rejected as Error).message).to.equal('boom');

        s.dismissAll();
        expect(await open).to.deep.equal({ actionId: 'dismiss', fields: {} });
    });

    it('hands links to the host, from payload or the legacy top-level url, and leaves other messages alone', async () => {
        const { s, opened } = session();
        await s.handleShared({ type: 'openExternalUrl', payload: { url: 'https://dbmn.io/docs/a/' } });
        await s.handleShared({ type: 'openExternalUrl', url: 'https://dbmn.io/docs/b/' });
        expect(opened).to.deep.equal(['https://dbmn.io/docs/a/', 'https://dbmn.io/docs/b/']);
        expect(await s.handleShared({ type: 'saveEnvironment' })).to.equal(false);
    });
});
