// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { BlackBox, describeMessage, type BlackBoxStore } from '../../../services/diagnostics/black-box';

function memoryStore(): BlackBoxStore & { map: Map<string, string> } {
    const map = new Map<string, string>();
    return { map, getItem: k => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); }, removeItem: k => { map.delete(k); }, keys: () => [...map.keys()] };
}

describe('The app\'s black box: what it was doing when it stopped', () => {
    let at = 0;
    const now = () => at;
    let lines: string[];
    const log = (level: string, message: string) => { lines.push(`${level}: ${message}`); };
    beforeEach(() => { at = Date.UTC(2026, 10, 26, 3, 0, 0); lines = []; });

    it('keeps a message\'s type, its run and its sizes, and never its values', () => {
        expect(describeMessage({ type: 'console.requests.page', batchId: 'b1', offset: 200, limit: 100, search: '@org=secret', body: { a: 1 } }))
            .to.equal('console.requests.page (batchId b1, offset 200, limit 100)');
        expect(describeMessage({ type: 'historyAll' })).to.equal('historyAll');
        expect(describeMessage({})).to.equal('a message');
    });

    it('a page that froze and was reloaded: the next start says what it was handling', () => {
        const store = memoryStore();
        const frozen = new BlackBox({ store, log, now, id: 'one' });
        frozen.handling('Hub', { type: 'ready' })();                              // finished: not part of the story
        frozen.handling('Console', { type: 'console.requests.page', batchId: 'b1', offset: 0 });   // never finishes
        expect(lines).to.deep.equal([]);
        at += 60000;                                                              // … the page is reloaded a minute on
        const next = new BlackBox({ store, log, now, id: 'two' });
        next.recover();
        expect(lines).to.have.length(1);
        expect(lines[0]).to.match(/^warn: The app stopped or was closed without finishing, last heard from at \d\d:\d\d:\d\d, while handling: Console: console\.requests\.page \(batchId b1, offset 0\), started \d\d:\d\d:\d\d$/);
        // Said once
        new BlackBox({ store, log, now, id: 'three' }).recover();
        expect(lines).to.have.length(1);
    });

    it('says nothing for a page that closed as pages do, one with nothing in flight, or another window still alive', () => {
        const store = memoryStore();
        const closed = new BlackBox({ store, log, now, id: 'closed' });
        closed.handling('Hub', { type: 'historyAll' });
        closed.closing();
        const idle = new BlackBox({ store, log, now, id: 'idle' });
        idle.handling('Hub', { type: 'ready' })();
        const alive = new BlackBox({ store, log, now, id: 'alive' });
        alive.handling('Query', { type: 'query.run' });
        at += 60000;
        alive.beat(1000, false);                                                  // still heard from
        new BlackBox({ store, log, now, id: 'new' }).recover();
        expect(lines).to.deep.equal([]);
        expect(store.map.has('dbmn.blackbox.alive')).to.equal(true);
        expect(store.map.has('dbmn.blackbox.idle')).to.equal(false);
    });

    it('work that took long gets a line; quick work gets none', () => {
        const box = new BlackBox({ store: memoryStore(), log, now });
        const quick = box.handling('Hub', { type: 'ready' });
        at += 100; quick();
        const slow = box.handling('Hub', { type: 'historyAll' });
        at += 1340; slow();
        expect(lines).to.deep.equal(['info: Hub: historyAll took 1.3 s, start to finish']);
    });

    it('a page that stopped answering and came back says for how long, and what was handled across it', () => {
        const box = new BlackBox({ store: memoryStore(), log, now });
        at += 1000; box.beat(1000);                                               // on time: nothing
        const history = box.handling('Hub', { type: 'historyAll' });
        at += 7000; history();                                                    // 7 s in one piece: no timer could fire
        box.handling('Console', { type: 'console.requests.shown', tab: 't1' });
        at += 1000; box.beat(1000);                                               // the timer, 7 s late
        expect(lines.filter(l => l.startsWith('warn'))).to.deep.equal([
            'warn: The app did not respond for 7.0 s. Being handled then: Console: console.requests.shown (tab t1) (not finished); Hub: historyAll (7.0 s)']);
    });

    it('a late timer on a page that is not on screen is the browser resting it, not a stall', () => {
        const box = new BlackBox({ store: memoryStore(), log, now });
        at += 3600000; box.beat(1000, false);
        at += 1000; box.beat(1000, true);
        expect(lines).to.deep.equal([]);
        // Back on screen after hours with no timer at all (a sleeping tab): told so, and the next timer is on time
        at += 7200000; box.awake();
        at += 1000; box.beat(1000, true);
        expect(lines).to.deep.equal([]);
        // A computer that slept with the page on screen: said as rest, never as the app not responding
        at += 3600000; box.beat(1000, true);
        expect(lines).to.have.length(1);
        expect(lines[0]).to.match(/^info: The app was not running for 60 min: the computer or the browser rested it$/);
    });

    it('storage that refuses a note never stops the work', () => {
        const store = memoryStore();
        store.setItem = () => { throw new Error('full'); };
        const box = new BlackBox({ store, log, now });
        box.handling('Hub', { type: 'ready' })();
        box.beat(1000);
        expect(lines).to.deep.equal([]);
    });
});
