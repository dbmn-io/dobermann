// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The order this computer writes a date in: day, month and year (James, 2026-11-25: "Not US style, we should read it
 * from the system preferences … System must be predictable"). Run Batch's Auto-detect uses it for a column where every
 * date could be day first or month first; a format chosen on Map always wins, and a day over 12 in the column still
 * settles it from the data. Map says, on the row, when a column was read this way.
 *
 * "This computer" is the locale the host runs in: in VS Code, the extension host's (the operating system's regional
 * setting, through LANG/LC_ALL on Linux and macOS); in the web app, the browser's language setting.
 */

/** Day, month, year: 'dmy' (en-AU, en-GB), 'mdy' (en-US), 'ymd' (year first: ja-JP, zh-CN, sv-SE, and any other). */
export type DateOrder = 'dmy' | 'mdy' | 'ymd';

/** The order, and the locale it came from (Map names it, so a browser set to en-US in Australia is plain to see). */
export interface SystemDateOrder { order: DateOrder; locale: string }

/** The order a locale writes a short date in. */
export function dateOrderOf(locale?: string): DateOrder {
    const parts = new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' })
        .formatToParts(new Date(Date.UTC(2024, 0, 25)));
    const order = parts.filter(p => p.type === 'day' || p.type === 'month' || p.type === 'year').map(p => p.type[0]).join('');
    return order === 'dmy' || order === 'mdy' ? order : 'ymd';
}

/** The order this computer writes dates in, and its locale. */
export function systemDateOrder(): SystemDateOrder {
    const locale = new Intl.DateTimeFormat().resolvedOptions().locale;
    return { order: dateOrderOf(locale), locale };
}
