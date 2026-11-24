// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Run Batch walk-forward (GitHub Issue #247, made visible 2026-10-05).
 *
 * After Import Data, Dobermann presses Next for the user while nothing needs their attention,
 * and lands on Review (the JSON preview — always worth a look before Execute):
 *   - Map is passed when every required variable is mapped AND every mapping is one the user
 *     would not question: a column this endpoint remembered (#307), an exact name match
 *     ignoring case, or one ignoring punctuation (location.gln ↔ location_gln). A partial-name
 *     guess always stops on Map — until the user confirms it once (Next saves it, #307).
 *   - Validate is passed only when every row is valid. Its own Next runs the checks: blanks,
 *     rules, types. Anything they find stops on Validate, with only its INVALID rows shown.
 *
 * Each step it passes stays on screen for a moment (dwell), so the step bar
 * (batch-stepper.js) shows the walk: Map ticks off, then Validate, then Review.
 * Clicking a later step in the step bar walks to it the same way (walkTo).
 *
 * It only ever calls the same goToNextStep the Next button calls, so every step's own
 * validation still runs. Any click hands control back.
 *
 * Hooks: data-transformer.js (Import Data → begin, showCSVStep → onStep) and
 * dt-data-ingestion.js (mapping table ready → afterMapping).
 */
(function () {
    'use strict';

    let active = false;
    let target = 4;               // the step the walk stops on
    let needCertainMapping = false;
    let awaitingNext = false;     // a step's Next was pressed; its checks may still warn
    let dwellStep = null;         // the step on screen while the walk pauses on it
    let timer = null;
    let dwellMs = 1100;   // long enough to read "Checking…" once the step bar has slid there (#397)

    function handler() { return window.CSVHandler; }
    function state() { return handler() && (handler().csvState || (handler().getState && handler().getState())); }
    function refresh() { if (window.BatchStepper && window.BatchStepper.refresh) window.BatchStepper.refresh(); }

    function looseName(name) {
        if (window.TemplateRename && window.TemplateRename.looseName) return window.TemplateRename.looseName(name);
        return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    }

    function isUserVariable(v) {
        const name = String((v && v.name) || '').toUpperCase();
        return !!name && !name.startsWith('A8:') && !name.startsWith('ENV:');
    }

    /** A mapping the user would not question. */
    function isConfident(variable, s) {
        const column = variable.mappedTo;
        if (!column) return false;
        const remembered = s.endpointConfig && s.endpointConfig.dataLoadingConfig && s.endpointConfig.dataLoadingConfig.columnMappings;
        if (remembered && remembered[variable.name] === column) return true;
        if (String(column).toLowerCase() === String(variable.name).toLowerCase()) return true;
        const a = looseName(column);
        return !!a && a === looseName(variable.name);
    }

    function needsAttention(s) {
        const n = s.activeNotification;
        return !!(n && (n.blocking || n.type === 'warning' || n.type === 'error'));
    }

    /** Exposed for tests: would Map be passed right now? */
    function mappingIsCertain() {
        const s = state();
        const h = handler();
        if (!s || !h || !h.areAllRequiredVariablesMapped || !h.areAllRequiredVariablesMapped()) return false;
        if (s.coercionErrors && s.coercionErrors.length > 0) return false;
        const mapped = (s.templateVariables || []).filter(isUserVariable).filter(v => v.mappedTo);
        return mapped.every(v => isConfident(v, s));
    }

    function stop() {
        active = false;
        awaitingNext = false;
        dwellStep = null;
        clearTimeout(timer);
        refresh();
    }

    /** Leave `step` on screen for a moment, then press its Next. */
    function pressNextAfterDwell(step) {
        clearTimeout(timer);
        dwellStep = step;
        refresh();
        timer = setTimeout(function () {
            const s = state();
            if (!active || !s || s.modalStep !== step) { dwellStep = null; refresh(); return; }
            // Validate: wait for the grid to finish loading; if its full check found rows to
            // fix, stop here — the grid and the step bar already show them
            const nextBtn = document.getElementById('csvNextBtn');
            if (step === 3 && nextBtn && nextBtn.dataset.loadingProgress === 'true') {
                pressNextAfterDwell(step);
                return;
            }
            dwellStep = null;
            if (step === 3 && s.gridErrorRows && s.gridErrorRows.size > 0) { stop(); return; }
            awaitingNext = true;
            refresh();
            handler().goToNextStep();
        }, dwellMs);
    }

    /** Import Data pressed on Step 1 (file or paste): walk to Review. */
    function begin() {
        active = true;
        target = 4;
        needCertainMapping = true;
        awaitingNext = false;
        refresh();
    }

    /** A later step clicked in the step bar: walk there, running each step's checks on the way. */
    function walkTo(step) {
        const s = state();
        if (!s || step <= s.modalStep) return;
        active = true;
        target = step;
        needCertainMapping = false;
        awaitingNext = false;
        pressNextAfterDwell(s.modalStep);
    }

    /** The mapping table is built and the compatibility check passed. */
    function afterMapping() {
        const s = state();
        if (!active || !s || s.modalStep !== 2 || dwellStep === 2 || awaitingNext) return;
        if (needCertainMapping && (needsAttention(s) || !mappingIsCertain())) { stop(); return; }
        pressNextAfterDwell(2);
    }

    /** A warning or error was shown. Only a check the walk started (a step's Next) ends it here. */
    function onWarning() {
        if (awaitingNext) stop();
    }

    /** Every step change (showCSVStep). */
    function onStep(stepNumber) {
        if (document.body) document.body.dataset.csvStep = String(stepNumber);
        if (!active) { refresh(); return; }
        awaitingNext = false;
        if (stepNumber === 1) { stop(); return; }
        if (stepNumber >= target) { stop(); return; }
        if (stepNumber === 2) { refresh(); return; }   // afterMapping presses on, once the table is ready
        if (needsAttention(state())) { stop(); return; }
        pressNextAfterDwell(stepNumber);
    }

    /** For the step bar: is a walk running, and which step is it checking? */
    function status() {
        const s = state();
        return {
            walking: active,
            checkingStep: active ? (dwellStep || (awaitingNext && s ? s.modalStep : null)) : null
        };
    }

    // Any click is the user taking over: Next, Back, or answering a step's own question (the
    // blank-cells warning, a sort prompt). Capture phase, so it runs before the button's own
    // onclick — Import Data's begin() and a step bar walkTo() still follow it.
    document.addEventListener('click', function () { if (active) stop(); }, true);

    window.DTAutoAdvance = {
        begin, walkTo, afterMapping, onStep, onWarning, cancel: stop, status,
        mappingIsCertain, isConfident,
        setDwell: function (ms) { dwellMs = ms; }
    };
})();
