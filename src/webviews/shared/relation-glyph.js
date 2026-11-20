/* SPDX-License-Identifier: AGPL-3.0-only */
/* Copyright (C) 2026 Flexion Tech Pty Ltd */
/**
 * How two sets of records meet on a key, as a little picture: one to one, one to many, many to
 * one, many to many, or only on one side. Compare's Match and Query's Join draw the same one
 * (.compare-glyph in compare.css: the left side .g-b, the right .g-c).
 *
 * And which rows a join keeps, for someone who does not know SQL (Query's Join step):
 *   RelationGlyph.join('left', { left: 'var(--compare-c-0)', right: '…' })   <svg class="join-glyph">
 *   'inner' only the rows both have (the overlap), 'left' all of the left one, 'right' all of the
 *   right one, 'outer' every row of both: two circles, the kept parts filled, the overlap always.
 *   'compare' is DBMN's own (the Hub's Compare icon, Lucide "scale"), not circles.
 * The circles' colours are --join-l and --join-r (the theme's charts blue and orange unless the
 * screen sets them, on the picture through `colours` or on anything around it).
 */
(function () {
    'use strict';
    const GLYPH = {
        oneToOne: '<line class="g-line" x1="6" y1="12" x2="34" y2="12"/><circle class="g-b" cx="6" cy="12" r="4"/><circle class="g-c" cx="34" cy="12" r="4"/>',
        onlyBase: '<circle class="g-b" cx="6" cy="12" r="4"/>',
        onlyOther: '<circle class="g-c" cx="34" cy="12" r="4"/>',
        oneToMany: '<line class="g-line" x1="6" y1="12" x2="34" y2="5"/><line class="g-line" x1="6" y1="12" x2="34" y2="19"/><circle class="g-b" cx="6" cy="12" r="4"/><circle class="g-c" cx="34" cy="5" r="3.5"/><circle class="g-c" cx="34" cy="19" r="3.5"/>',
        manyToOne: '<line class="g-line" x1="6" y1="5" x2="34" y2="12"/><line class="g-line" x1="6" y1="19" x2="34" y2="12"/><circle class="g-b" cx="6" cy="5" r="3.5"/><circle class="g-b" cx="6" cy="19" r="3.5"/><circle class="g-c" cx="34" cy="12" r="4"/>',
        manyToMany: '<line class="g-line" x1="6" y1="5" x2="34" y2="19"/><line class="g-line" x1="6" y1="19" x2="34" y2="5"/><line class="g-line" x1="6" y1="5" x2="34" y2="5"/><line class="g-line" x1="6" y1="19" x2="34" y2="19"/><circle class="g-b" cx="6" cy="5" r="3.5"/><circle class="g-b" cx="6" cy="19" r="3.5"/><circle class="g-c" cx="34" cy="5" r="3.5"/><circle class="g-c" cx="34" cy="19" r="3.5"/>'
    };

    /** The picture of `kind` as an <svg class="compare-glyph">. */
    function svg(kind) {
        const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        node.setAttribute('class', 'compare-glyph');
        node.setAttribute('viewBox', '0 0 40 24');
        node.setAttribute('aria-hidden', 'true');
        node.innerHTML = GLYPH[kind] || '';
        return node;
    }

    const LENS = 'M20 3.6a9 9 0 0 1 0 14.8a9 9 0 0 1 0-14.8z';
    const JOIN_KINDS = ['inner', 'left', 'right', 'outer', 'compare'];

    /** Which rows a join keeps, as an <svg class="join-glyph is-{kind}">. */
    function join(kind, colours) {
        const ns = 'http://www.w3.org/2000/svg';
        if (!JOIN_KINDS.includes(kind)) kind = 'inner';
        let node;
        if (kind === 'compare') {
            const holder = document.createElement('span');
            holder.innerHTML = window.Icons && window.Icons.icon ? window.Icons.icon('scale') : '';
            node = holder.querySelector('svg') || document.createElementNS(ns, 'svg');
        } else {
            node = document.createElementNS(ns, 'svg');
            node.setAttribute('viewBox', '0 0 40 22');
            const left = kind === 'left' || kind === 'outer';
            const right = kind === 'right' || kind === 'outer';
            node.innerHTML = `<circle class="j-l${left ? ' is-kept' : ''}" cx="14" cy="11" r="9"/>`
                + `<circle class="j-r${right ? ' is-kept' : ''}" cx="26" cy="11" r="9"/>`
                + `<path class="j-both" d="${LENS}"/>`;
        }
        node.setAttribute('class', `join-glyph is-${kind}`);
        node.setAttribute('aria-hidden', 'true');
        if (colours && colours.left) node.style.setProperty('--join-l', colours.left);
        if (colours && colours.right) node.style.setProperty('--join-r', colours.right);
        return node;
    }

    window.RelationGlyph = { svg, join, JOIN_KINDS };
})();
