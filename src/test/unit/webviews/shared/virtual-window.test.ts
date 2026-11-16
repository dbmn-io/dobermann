// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const VirtualWindow = require('../../../../webviews/shared/virtual-window');

// GitHub Issue #287: console virtual scroll showed blank rows while scrolling.
// Root cause: the window was sized in rows from an assumed 30px row height,
// but rows actually render ~19.4px tall, so almost no buffer existed below
// the viewport. Windowing is now sized in pixels from the measured height.

const ACTUAL_ROW_HEIGHT = 19.390625; // measured in Chromium for the Report table
const VIEWPORT = 467;

describe('virtual-window — console virtual scroll windowing (Issue #287)', () => {
    describe('computeWindow', () => {
        const base = {
            viewportHeight: VIEWPORT,
            rowHeight: ACTUAL_ROW_HEIGHT,
            totalRows: 5000,
            overscanAhead: 1400,
            overscanBehind: 467,
        };

        it('renders at least the ahead-overscan in pixels below the viewport when scrolling down', () => {
            const scrollTop = 30000;
            const w = VirtualWindow.computeWindow({ ...base, scrollTop, direction: 1 });
            const renderedBottomPx = w.end * ACTUAL_ROW_HEIGHT;
            expect(renderedBottomPx - (scrollTop + VIEWPORT)).to.be.at.least(1400);
            expect(scrollTop - w.start * ACTUAL_ROW_HEIGHT).to.be.at.least(467);
        });

        it('puts the larger overscan above the viewport when scrolling up', () => {
            const scrollTop = 30000;
            const w = VirtualWindow.computeWindow({ ...base, scrollTop, direction: -1 });
            expect(scrollTop - w.start * ACTUAL_ROW_HEIGHT).to.be.at.least(1400);
            expect(w.end * ACTUAL_ROW_HEIGHT - (scrollTop + VIEWPORT)).to.be.at.least(467);
        });

        it('uses the ahead-overscan on both sides when direction is unknown', () => {
            const scrollTop = 30000;
            const w = VirtualWindow.computeWindow({ ...base, scrollTop, direction: 0 });
            expect(scrollTop - w.start * ACTUAL_ROW_HEIGHT).to.be.at.least(1400);
            expect(w.end * ACTUAL_ROW_HEIGHT - (scrollTop + VIEWPORT)).to.be.at.least(1400);
        });

        it('includes the last row when scrollTop is past the end (scrollbar flung to the bottom)', () => {
            const w = VirtualWindow.computeWindow({ ...base, scrollTop: 10_000_000, direction: 1 });
            expect(w.end).to.equal(5000);
            expect(w.start).to.be.within(0, 5000);
            // The viewport's rows must be inside the window.
            const maxScrollTop = 5000 * ACTUAL_ROW_HEIGHT - VIEWPORT;
            expect(w.start * ACTUAL_ROW_HEIGHT).to.be.at.most(maxScrollTop);
        });

        it('starts at row 0 at the top', () => {
            const w = VirtualWindow.computeWindow({ ...base, scrollTop: -50, direction: -1 });
            expect(w.start).to.equal(0);
            expect(w.end).to.be.greaterThan(0);
        });

        it('returns an empty window for no rows', () => {
            const w = VirtualWindow.computeWindow({ ...base, totalRows: 0, scrollTop: 0, direction: 0 });
            expect(w).to.deep.equal({ start: 0, end: 0 });
        });

        it('renders everything when the data is shorter than viewport plus overscan', () => {
            const w = VirtualWindow.computeWindow({ ...base, totalRows: 20, scrollTop: 0, direction: 0 });
            expect(w).to.deep.equal({ start: 0, end: 20 });
        });

        it('does not divide by zero on an unmeasured row height', () => {
            const w = VirtualWindow.computeWindow({ ...base, rowHeight: 0, scrollTop: 0, direction: 0 });
            expect(Number.isFinite(w.start)).to.equal(true);
            expect(Number.isFinite(w.end)).to.equal(true);
        });
    });

    describe('needsRender', () => {
        const base = { viewportHeight: VIEWPORT, rowHeight: ACTUAL_ROW_HEIGHT, totalRows: 5000, marginPx: VIEWPORT };

        it('is true when nothing has been rendered yet', () => {
            expect(VirtualWindow.needsRender({ ...base, rendered: { start: -1, end: -1 }, scrollTop: 0 })).to.equal(true);
        });

        it('is false for a small scroll that stays well inside the rendered rows', () => {
            // Rendered 1000..1200 → 19390..23268px; viewport 20000..20467.
            const rendered = { start: 1000, end: 1200 };
            expect(VirtualWindow.needsRender({ ...base, rendered, scrollTop: 20000 })).to.equal(false);
        });

        it('is true when the viewport bottom nears the last rendered row', () => {
            const rendered = { start: 1000, end: 1200 };
            const scrollTop = 1200 * ACTUAL_ROW_HEIGHT - VIEWPORT - 100; // 100px of rows left below
            expect(VirtualWindow.needsRender({ ...base, rendered, scrollTop })).to.equal(true);
        });

        it('is true when the viewport top nears the first rendered row', () => {
            const rendered = { start: 1000, end: 1200 };
            const scrollTop = 1000 * ACTUAL_ROW_HEIGHT + 100;
            expect(VirtualWindow.needsRender({ ...base, rendered, scrollTop })).to.equal(true);
        });

        it('is true when the viewport has jumped outside the rendered rows entirely', () => {
            const rendered = { start: 1000, end: 1200 };
            expect(VirtualWindow.needsRender({ ...base, rendered, scrollTop: 80000 })).to.equal(true);
        });

        it('is false near an edge that is already the start or end of the data', () => {
            const atEnd = { start: 4800, end: 5000 };
            const bottomScroll = 5000 * ACTUAL_ROW_HEIGHT - VIEWPORT;
            expect(VirtualWindow.needsRender({ ...base, rendered: atEnd, scrollTop: bottomScroll })).to.equal(false);
            const atStart = { start: 0, end: 200 };
            expect(VirtualWindow.needsRender({ ...base, rendered: atStart, scrollTop: 0 })).to.equal(false);
        });
    });

    describe('paddings', () => {
        it('top + rows + bottom equals the full scroll height', () => {
            const p = VirtualWindow.paddings({ start: 1000, end: 1200, totalRows: 5000, rowHeight: ACTUAL_ROW_HEIGHT });
            const total = p.top + (1200 - 1000) * ACTUAL_ROW_HEIGHT + p.bottom;
            expect(total).to.be.closeTo(5000 * ACTUAL_ROW_HEIGHT, 1e-6);
            expect(p.top).to.be.closeTo(1000 * ACTUAL_ROW_HEIGHT, 1e-6);
        });

        it('is zero at both ends when every row is rendered', () => {
            expect(VirtualWindow.paddings({ start: 0, end: 50, totalRows: 50, rowHeight: 20 })).to.deep.equal({ top: 0, bottom: 0 });
        });
    });

    describe('averageRowHeight', () => {
        it('averages measured heights', () => {
            expect(VirtualWindow.averageRowHeight([19, 20, 21], 30)).to.equal(20);
        });

        it('ignores zero and non-finite heights (detached or hidden rows)', () => {
            expect(VirtualWindow.averageRowHeight([0, NaN, 19.5, 19.5], 30)).to.equal(19.5);
        });

        it('falls back when nothing usable was measured', () => {
            expect(VirtualWindow.averageRowHeight([], 30)).to.equal(30);
            expect(VirtualWindow.averageRowHeight([0, 0], 30)).to.equal(30);
        });
    });
});
