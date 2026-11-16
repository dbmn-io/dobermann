// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/* The Console's first script (#312's boot timing). It was inline; it is a file so the web app's
 * Content Security Policy (#372) lets it run. */
// Issue #312: boot breakdown — how long this page took to fetch and run its
// scripts before it could signal ready. Logged once at DOMContentLoaded.
window.__dbmnBootStart = performance.now();
document.addEventListener('DOMContentLoaded', function () {
    try {
        var entries = performance.getEntriesByType('resource').filter(function (e) { return e.initiatorType === 'script' || e.initiatorType === 'link'; });
        var total = entries.reduce(function (n, e) { return n + e.duration; }, 0);
        var slowest = entries.slice().sort(function (a, b) { return b.duration - a.duration; }).slice(0, 3)
            .map(function (e) { return (e.name.split('/').pop().split('?')[0]) + ' ' + Math.round(e.duration) + 'ms'; });
        console.log('[DBMN timing] page boot: DOMContentLoaded at', Math.round(performance.now()), 'ms;', entries.length, 'resources, fetch time summed', Math.round(total), 'ms; slowest:', slowest.join(', '),
            '; script execution (boot minus fetch, roughly)', Math.round(performance.now() - window.__dbmnBootStart - Math.max.apply(null, entries.map(function (e) { return e.responseEnd; }).concat([0]))), 'ms after last fetch');
    } catch (e) { /* diagnostics only */ }
});
