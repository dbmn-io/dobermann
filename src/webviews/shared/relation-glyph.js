/* SPDX-License-Identifier: AGPL-3.0-only */
/* Copyright (C) 2026 Flexion Tech Pty Ltd */
/**
 * How two sets of records meet on a key, as a little picture: one to one, one to many, many to
 * one, many to many, or only on one side. Compare's Match and Query's Join draw the same one
 * (.compare-glyph in compare.css: the left side .g-b, the right .g-c).
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

    window.RelationGlyph = { svg };
})();
