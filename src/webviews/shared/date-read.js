// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The one date reader: a value written in a given order, as YYYY-MM-DD, or null when it isn't a day in that
 * order. Moved unchanged from dt-type-coercion.js (2026-11-26) so the host's Read date step (column-functions.ts)
 * and Map's conversion at Next to Validate read a date the same way. The webview (window.DateRead, loaded
 * before dt-type-coercion.js) and the extension (module.exports) both use it.
 */

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root && typeof root === 'object') {
        root.DateRead = api;
    }
}(typeof window !== 'undefined' ? window : this, function () {
    'use strict';

    const pad2 = n => String(n).padStart(2, '0');

    /** YYYY-MM-DD for a real calendar day, else null (31/02 is not a day). */
    function calendarDay(y, m, d) {
        y = Number(y); m = Number(m); d = Number(d);
        if (!(y >= 1 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
        const day = new Date(Date.UTC(y, m - 1, d));
        if (day.getUTCFullYear() !== y || day.getUTCMonth() !== m - 1 || day.getUTCDate() !== d) return null;
        return `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;
    }
    const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
    const ISO_ANY = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
    const SLASHED = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;

    /**
     * A date read in one Source format: YYYY-MM-DD, or null when it isn't one in that format. A value already
     * YYYY-MM-DD is that day in every format (so converting twice changes nothing: Validate's grid holds them so).
     */
    function readDate(text, format) {
        const t = String(text == null ? '' : text).trim();
        if (!t) return null;
        const iso = ISO_DAY.exec(t);
        if (iso) return calendarDay(iso[1], iso[2], iso[3]);
        let m;
        switch (format) {
            case 'yyyy-mm-dd':
                m = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(t);
                return m ? calendarDay(m[1], m[2], m[3]) : null;
            case 'iso_8601':
                // (the day as written: a time and a zone after it don't move it)
                m = ISO_ANY.exec(t);
                return m ? calendarDay(m[1], m[2], m[3]) : null;
            case 'mm-dd-yyyy':
                m = SLASHED.exec(t);
                return m ? calendarDay(m[3], m[1], m[2]) : null;
            case 'dd-mm-yyyy':
                m = SLASHED.exec(t);
                return m ? calendarDay(m[3], m[2], m[1]) : null;
            case 'unix_timestamp': {
                // (seconds; 13 digits are milliseconds) the day in UTC, as a timestamp means
                if (!/^-?\d{9,13}$/.test(t)) return null;
                const n = Number(t);
                const at = new Date(t.replace('-', '').length === 13 ? n : n * 1000);
                return Number.isNaN(at.getTime()) ? null : calendarDay(at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate());
            }
            case 'excel_serial': {
                const serial = Number(t);
                if (!/^\d+(\.\d+)?$/.test(t) || !(serial >= 1)) return null;
                // Excel's epoch quirk: serial <= 60 uses 25567, > 60 uses 25569
                const at = new Date((Math.floor(serial) - (serial <= 60 ? 25567 : 25569)) * 86400000);
                return calendarDay(at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate());
            }
            default:
                return null;
        }
    }

    return { readDate, calendarDay, pad2, ISO_DAY, ISO_ANY, SLASHED };
}));
