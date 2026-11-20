// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/** The lanes grid's tracks (src/webviews/shared/dbmn-lanes.js): worked out from the views alone. */
import { expect } from 'chai';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const DbmnLanes = require('../../../../webviews/shared/dbmn-lanes.js');

describe('DbmnLanes: the tracks every line shares', () => {
    it('a gutter, a lane per view as wide as its runs, an end column', () => {
        expect(DbmnLanes.tracks([{ runs: 4 }, { runs: 1 }, 2])).to.equal('230px minmax(480px, 4fr) minmax(120px, 1fr) minmax(240px, 2fr) 130px');
        expect(DbmnLanes.tracks([{ runs: ['bl', 'c1'] }])).to.equal('230px minmax(240px, 2fr) 130px');
    });
    it('a view with no runs still keeps a place; options change the sizes', () => {
        expect(DbmnLanes.tracks([{ runs: 0 }, {}])).to.equal('230px minmax(120px, 1fr) minmax(120px, 1fr) 130px');
        expect(DbmnLanes.tracks([1], { gutter: 200, run: 100, end: 90 })).to.equal('200px minmax(100px, 1fr) 90px');
    });
    it('the narrowest the rows go: every track at its least, and the gaps', () => {
        expect(DbmnLanes.minWidth([{ runs: 4 }, { runs: 1 }, { runs: 1 }])).to.equal(230 + 720 + 130 + 4 * 6);
        expect(DbmnLanes.minWidth([], { gap: 0 })).to.equal(360);
    });
    it('apply sets the variables on the container', () => {
        const set: Record<string, string> = {};
        DbmnLanes.apply({ style: { setProperty: (k: string, v: string) => { set[k] = v; } } }, [{ runs: 2 }]);
        expect(set).to.deep.equal({ '--lanes-tracks': '230px minmax(240px, 2fr) 130px', '--lanes-min': '612px', '--lanes-gap': '6px' });
    });
});
