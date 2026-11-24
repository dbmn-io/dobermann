// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The order a computer writes dates in (data-loading/date-order): what Run Batch's Auto-detect reads a column that could
 * be either day or month first by. The same under TZ=Australia/Sydney, UTC and America/Los_Angeles.
 */
import { expect } from 'chai';
import { dateOrderOf, systemDateOrder } from '../../data-loading/date-order';

describe('This computer\'s date order', () => {
    it('day first: en-AU, en-GB, de-DE', () => {
        for (const locale of ['en-AU', 'en-GB', 'de-DE']) expect(dateOrderOf(locale), locale).to.equal('dmy');
    });
    it('month first: en-US', () => {
        expect(dateOrderOf('en-US')).to.equal('mdy');
    });
    it('year first: ja-JP, zh-CN, sv-SE', () => {
        for (const locale of ['ja-JP', 'zh-CN', 'sv-SE']) expect(dateOrderOf(locale), locale).to.equal('ymd');
    });
    it('the computer\'s own: its locale, and that locale\'s order', () => {
        const own = systemDateOrder();
        expect(own.locale).to.equal(new Intl.DateTimeFormat().resolvedOptions().locale);
        expect(own.order).to.equal(dateOrderOf(own.locale));
    });
});
