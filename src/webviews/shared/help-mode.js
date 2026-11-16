// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Help mode — one way into the docs, DBMN-wide, instead of a "?" icon beside every control.
 *
 *   - The help button in the Hub header, or the ? key anywhere (when not typing), turns help
 *     mode on for the Hub AND every tab in it. Esc, or the button again, turns it off.
 *   - In help mode every control that has a docs section gets a dashed outline. Clicking one
 *     opens its dbmn.io section instead of doing its job. Other controls do nothing until help
 *     mode is off, so nothing runs by accident. No badges, no hover effects, no layout change.
 *
 * Which control documents where: static markup carries data-help="page#section"
 * (https://dbmn.io/docs/page#section); pages with controls built at runtime add
 * HelpMode.register([{ selector, help, first? }]). `first: true` is for repeated rows (every
 * endpoint, every run): only the first one currently visible is outlined, not the whole list.
 * Applied when help mode turns on, and again as the page changes or scrolls.
 *
 * One state across frames: the Hub page (top window) owns it and tells each tab iframe
 * ({ type: '__dbmnHelpMode', on }), including a tab that mounts later. A tab that toggles it
 * itself (? or Esc while focused there) tells the Hub ({ __dbmnHelpModeChanged, on }), which
 * passes it on. A webview opened on its own, outside the Hub, works alone.
 */
(function (window) {
    'use strict';

    // A tab inside the Hub — NOT "window.parent !== window": in VS Code every webview,
    // the Hub included, already runs inside a frame. The Hub's tab shim sets this.
    const isTab = () => !!window.__dbmnEmbeddedTab__;
    const hubFrames = () => Array.prototype.slice.call(document.querySelectorAll('iframe'));
    // Lucide shield-question-mark — the help button's glyph (icons.js role 'help'), inline so the
    // banner needs nothing else loaded.
    const SHIELD_ICON = '<svg class="help-mode-banner-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M9.1 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>';
    const targets = [];
    let on = false;
    let observer = null;
    let banner = null;
    let pending = false;

    function register(list) {
        (list || []).forEach(t => { if (t && t.selector && t.help) targets.push(t); });
        if (on) apply();
    }

    /** On screen, inside whatever scrolls it (the catalogue list, a tab body). */
    function isVisible(el) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || r.bottom <= 0 || r.top >= window.innerHeight) return false;
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
            const o = window.getComputedStyle(p).overflowY;
            if (o === 'auto' || o === 'scroll' || o === 'hidden') {
                const pr = p.getBoundingClientRect();
                if (r.bottom <= pr.top || r.top >= pr.bottom) return false;
            }
        }
        return true;
    }

    function assign(el, help) {
        if (el.hasAttribute('data-help')) return;
        el.setAttribute('data-help', help);
        el.__dbmnHelpAssigned = true;
    }

    function unassign(el) {
        if (!el.__dbmnHelpAssigned) return;
        el.removeAttribute('data-help');
        el.classList.remove('help-mode-target');
        el.__dbmnHelpAssigned = false;
    }

    function apply() {
        pending = false;
        targets.forEach(t => {
            let els = Array.prototype.slice.call(document.querySelectorAll(t.selector));
            if (t.first) {
                const chosen = els.find(isVisible);
                els = chosen ? [chosen] : [];
                (t.assigned || []).forEach(el => { if (els.indexOf(el) === -1) unassign(el); });
                t.assigned = els;
            }
            els.forEach(el => assign(el, t.help));
        });
        document.querySelectorAll('[data-help]').forEach(el => {
            if (el.classList.contains('help-mode-target')) return;
            if (el.matches('[data-help-toggle]') || el.querySelector('[data-help-toggle]')) return;   // the button only toggles
            el.classList.add('help-mode-target');
        });
    }

    function scheduleApply() {
        if (pending) return;
        pending = true;
        window.requestAnimationFrame(apply);
    }

    function showBanner() {
        if (isTab()) return;   // the Hub shows the one banner
        if (!banner) {
            banner = document.createElement('div');
            banner.className = 'help-mode-banner';
            banner.setAttribute('role', 'status');
            banner.innerHTML = SHIELD_ICON + '<span><strong>Help mode</strong> Click an outlined control to read about it on dbmn.io. <kbd>Esc</kbd> to leave.</span>';
        }
        document.body.appendChild(banner);
    }

    function tellFrames(value) {
        hubFrames().forEach(f => {
            try { f.contentWindow && f.contentWindow.postMessage({ type: '__dbmnHelpMode', on: value }, '*'); } catch (_e) { /* swallow */ }
        });
    }

    /** from: 'local' (this frame's button/keys), 'hub' (the Hub told us), 'tab' (a tab told the Hub). */
    function setOn(value, from) {
        value = !!value;
        if (value === on) return;
        on = value;
        document.body.classList.toggle('help-mode', on);
        document.querySelectorAll('[data-help-toggle]').forEach(b => b.setAttribute('aria-pressed', on ? 'true' : 'false'));
        if (on) {
            apply();
            showBanner();
            observer = observer || new MutationObserver(scheduleApply);
            observer.observe(document.body, { childList: true, subtree: true });
            document.addEventListener('scroll', scheduleApply, true);   // "first visible" moves
        } else {
            if (observer) observer.disconnect();
            document.removeEventListener('scroll', scheduleApply, true);
            if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
            document.querySelectorAll('.help-mode-target').forEach(el => el.classList.remove('help-mode-target'));
        }
        if (isTab()) {
            if (from === 'local') {
                try { window.parent.postMessage({ __dbmnHelpModeChanged: true, on }, '*'); } catch (_e) { /* swallow */ }
            }
        } else {
            tellFrames(on);
        }
    }

    function toggle(value) {
        setOn(typeof value === 'boolean' ? value : !on, 'local');
    }

    function isTyping(el) {
        if (!el) return false;
        const tag = (el.tagName || '').toLowerCase();
        return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
    }

    function open(help) {
        const hash = help.indexOf('#');
        const page = hash === -1 ? help : help.slice(0, hash);
        const section = hash === -1 ? '' : help.slice(hash + 1);
        const api = window.vscode;
        if (!api || typeof api.postMessage !== 'function') return;
        // Same message documentation-helpers.js sends; WebviewBase opens allowed dbmn.io URLs.
        api.postMessage({
            type: 'openExternalUrl',
            source: 'webview',
            target: 'extension',
            timestamp: Date.now(),
            payload: { url: 'https://dbmn.io/docs/' + page + '/' + (section ? '#' + section : '') }
        });
    }

    // [data-click]: a control's action without an inline handler (dbmn-actions.js, #372)
    const INTERACTIVE = 'button, a, input, select, textarea, label, summary, [role="button"], [role="tab"], .tab-item, .hub-tab, [onclick], [data-click]';

    // Capture phase: decide before any control's own handler runs.
    document.addEventListener('click', function (event) {
        const t = event.target;
        const toggleBtn = t.closest && t.closest('[data-help-toggle]');
        if (toggleBtn) {
            event.preventDefault();
            event.stopImmediatePropagation();
            toggle();
            return;
        }
        if (!on) return;
        if (banner && banner.contains(t)) return;
        const target = t.closest && t.closest('[data-help]');
        if (target) {
            event.preventDefault();
            event.stopImmediatePropagation();
            open(target.getAttribute('data-help'));
            return;
        }
        if (t.closest && t.closest(INTERACTIVE)) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }, true);

    document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && on) {
            event.preventDefault();
            event.stopImmediatePropagation();
            setOn(false, 'local');
            return;
        }
        if (event.key === '?' && !event.ctrlKey && !event.metaKey && !event.altKey && !isTyping(document.activeElement)) {
            event.preventDefault();
            toggle();
        }
    }, true);

    // Attached after the page's own script (DOMContentLoaded): in a Hub tab, the shim hands its
    // queue of early messages to the FIRST "message" listener — that must be the page's, not ours.
    function onMessage(event) {
        const data = event.data;
        if (!data || typeof data !== 'object') return;
        // Only the Hub may set a tab, and only the Hub's own tabs may set the Hub.
        const fromOwnTab = hubFrames().some(f => f.contentWindow === event.source);
        if (isTab() && data.type === '__dbmnHelpMode' && event.source === window.parent) {
            setOn(data.on, 'hub');
        } else if (!isTab() && fromOwnTab && data.__dbmnHelpModeChanged === true) {
            setOn(data.on, 'tab');
        } else if (!isTab() && fromOwnTab && on && data.__embeddedFromTab__ === true && data.payload && data.payload.type === '__embeddedReady__') {
            // A tab mounted while help mode is on: bring it in.
            try { event.source && event.source.postMessage({ type: '__dbmnHelpMode', on: true }, '*'); } catch (_e) { /* swallow */ }
        }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { window.addEventListener('message', onMessage); });
    } else {
        window.addEventListener('message', onMessage);
    }

    window.HelpMode = { register, toggle, isOn: () => on };
})(window);
