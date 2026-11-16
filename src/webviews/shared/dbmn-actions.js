// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Markup's event handlers without inline script (#372). The web app runs under a Content Security
 * Policy that refuses `onclick="…"` and every other inline handler, so markup names an action and
 * the screen's script says what each name does:
 *
 *   <button data-click="saveEndpoint">                 DbmnActions.register({ saveEndpoint })
 *   <button data-click="switchTab" data-arg="auth">    switchTab('auth', event, element)
 *   <select data-change="methodChanged">               methodChanged(undefined, event, element)
 *
 * Only registered names run: markup (or anything injected into it) can't reach a function the
 * screen didn't offer. An unregistered name is logged, so a missed registration shows in tests.
 *
 * Actions run in the capture phase at <html>, before the target's ancestors hear the event: the
 * same order an inline handler had, so `event.stopPropagation()` in an action still keeps
 * the event from a row or panel underneath. `this` is the element, as it was inline. Markup that
 * said `event.stopPropagation(); …` inline says `data-stop-propagation` (with or without an
 * action): the event goes no further than the action. Only for a leaf element such as a button:
 * stopped here, the event never reaches anything inside the element either.
 *
 * At <html>, not the document: help mode (help-mode.js) listens at the document in the capture
 * phase and stops a click on a control before it does its job. Capture reaches the document
 * before <html>, so help mode always decides first, whichever script loaded first.
 */
(function () {
    'use strict';
    if (window.DbmnActions) return;

    const actions = Object.create(null);
    const TYPES = ['click', 'change', 'input', 'keydown', 'dragover', 'dragleave', 'drop', 'wheel', 'scroll'];
    /** Markup that only stopped an event going further: a click (`data-stop-propagation`, for a
     *  button), or the wheel and scroll of a nested scroller (`data-stop-scroll`). */
    const STOPS = { click: 'data-stop-propagation', wheel: 'data-stop-scroll', scroll: 'data-stop-scroll' };
    /** Never cancelled here, so the browser needn't wait for us to scroll. */
    const PASSIVE = { wheel: true, scroll: true };

    function run(type, event) {
        const target = event.target instanceof Element ? event.target : null;
        const stop = STOPS[type];
        const element = target && target.closest('[data-' + type + ']' + (stop ? ', [' + stop + ']' : ''));
        if (!element) return;
        if (stop && element.hasAttribute(stop)) event.stopPropagation();
        const name = element.getAttribute('data-' + type);
        if (name === null) return;
        const action = actions[name];
        if (typeof action !== 'function') {
            console.error('[DbmnActions] nothing registered as "' + name + '" (data-' + type + ')');
            return;
        }
        const arg = element.getAttribute('data-arg');
        action.call(element, arg === null ? undefined : arg, event, element);
    }

    for (const type of TYPES) {
        document.documentElement.addEventListener(type, function (event) { run(type, event); }, { capture: true, passive: !!PASSIVE[type] });
    }

    window.DbmnActions = {
        /** What this screen's markup may call, by name. */
        register: function (map) { Object.assign(actions, map); }
    };
}());
