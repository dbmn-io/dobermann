// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * <dbmn-level level="error">: how serious a log line is, as an icon and a word, so the level is
 * never told by colour alone (the design system: src/webviews/design-system).
 *
 *   <dbmn-level level="warn"></dbmn-level>          Warn, with the triangle
 *   cell.append(DbmnLevel.make('error'));            from script, in a table's cell
 *
 * Levels: error, warn, info, debug (anything else shows as it is, with no icon). It draws in the
 * page (no shadow root) and only draws. Needs shared/icons.js; styles in shared/dbmn-log.css.
 */
(function () {
    'use strict';

    if (!window.customElements || customElements.get('dbmn-level')) return;

    const LEVELS = {
        error: { word: 'Error', icon: 'circle-x' },
        warn: { word: 'Warn', icon: 'triangle-alert' },
        info: { word: 'Info', icon: 'info' },
        debug: { word: 'Debug', icon: 'braces' }
    };

    class DbmnLevel extends HTMLElement {
        static get observedAttributes() { return ['level']; }

        /** A level element for `level`, ready to put in a cell. */
        static make(level) {
            const el = document.createElement('dbmn-level');
            el.setAttribute('level', level || '');
            return el;
        }

        connectedCallback() { this._draw(); }
        attributeChangedCallback() { if (this.isConnected) this._draw(); }

        _draw() {
            const level = (this.getAttribute('level') || '').toLowerCase();
            if (this._drawn === level) return;
            this._drawn = level;
            const known = LEVELS[level];
            const word = document.createElement('span');
            word.className = 'dbmn-level-word';
            word.textContent = known ? known.word : level;
            if (known && window.Icons) {
                const icon = document.createElement('span');
                icon.className = 'dbmn-level-icon';
                icon.setAttribute('aria-hidden', 'true');
                window.Icons.setIcon(icon, known.icon);
                this.replaceChildren(icon, word);
            } else {
                this.replaceChildren(word);
            }
        }
    }

    customElements.define('dbmn-level', DbmnLevel);
    window.DbmnLevel = DbmnLevel;
})();
