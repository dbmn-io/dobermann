// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * DbmnModal — shared dismissible modal for DBMN webviews.
 *
 * Designed as the in-house replacement for `vscode.window.showInformationMessage`
 * + `showWarningMessage` + `showQuickPick`. Reusable across the Hub, endpoint
 * editor, console, run-batch and account webviews so DBMN dialogs feel like
 * DBMN, not VS Code chrome.
 *
 * Three entry points:
 *   - DbmnModal.confirm({ title, body, confirmLabel?, cancelLabel?, confirmVariant? })
 *       → Promise<boolean>
 *   - DbmnModal.alert({ title, body, okLabel? })
 *       → Promise<void>
 *   - DbmnModal.show({ title, body, fields?, actions, dismissible?, size?, columns?, rowPaste?, maximisable? })
 *     (maximisable: a Maximise button in the header; the dialog then takes the whole window)
 *       → Promise<{ actionId, fields }>     // actionId === 'dismiss' on X/ESC/backdrop
 *       rowPaste: true — a footer Paste button (and Ctrl+V in any field)
 *       fills every matching field from a copied spreadsheet/CSV row, header
 *       + data row (Issue #302; needs shared/row-paste.js loaded too).
 *       help: { doc, section?, title? } — in help mode the title opens
 *       https://dbmn.io/docs/<doc>/#<section>, like every other documented control.
 *
 * Conventions:
 *   - `body` is either a string (rendered as plain text) or an HTMLElement
 *     (caller assembles and is responsible for escaping). No raw-HTML string
 *     path on purpose — keeps XSS surface tight.
 *   - `dismissible` defaults to true. X button + Escape key + backdrop click
 *     all resolve with `actionId: 'dismiss'`.
 *   - One modal at a time. A second `show()` while one is open auto-dismisses
 *     the first, unless it is shown `over: true` (a value opened in full from a
 *     table inside a dialog): then it opens over the first, which waits behind it
 *     untouched and is the one open again when it closes.
 *   - Auto-focuses the first form field, or failing that the primary action.
 *
 * Field schema:
 *   { id, type, label?, value?, placeholder?, required?, autoFocus?, options?, suggestions? }
 *     suggestions: ['EA', …] (text only): offered as it's typed in, filtered by the typing
 *     type ∈ 'text' | 'email' | 'password' | 'number' | 'textarea' | 'select'
 *     options: [{ value, label, group? }] (select only; `group` puts it under that heading)
 *
 * Action schema:
 *   { id, label, variant? }   variant ∈ 'primary' | 'secondary' | 'danger'
 */
(function () {
    'use strict';

    let activeModal = null;

    function el(tag, opts) {
        const node = document.createElement(tag);
        if (!opts) return node;
        if (opts.className) node.className = opts.className;
        if (opts.text != null) node.textContent = opts.text;
        if (opts.attrs) Object.entries(opts.attrs).forEach(([k, v]) => node.setAttribute(k, v));
        if (opts.children) opts.children.forEach((c) => c && node.appendChild(c));
        return node;
    }

    function buildField(field) {
        const wrap = el('div', { className: 'dbmn-modal-field' });

        // Radio groups render as a stack of clickable rows. No utility classes —
        // styled structurally in modals.css off `.dbmn-modal-field [role=radiogroup]`
        // plus the semantic elements (label / input[type=radio] / span / small).
        if (field.type === 'radio') {
            if (field.label) {
                // Plain heading label (no `for` — it heads several inputs).
                wrap.appendChild(el('label', { text: field.label }));
            }
            const group = el('div', { attrs: { role: 'radiogroup' } });
            const radios = [];
            (field.options || []).forEach((opt, i) => {
                const row = el('label');
                const radio = el('input');
                radio.type = 'radio';
                radio.name = field.id;
                radio.value = opt.value;
                const checked = field.value != null ? field.value === opt.value : i === 0;
                if (checked) radio.checked = true;
                row.appendChild(radio);
                row.appendChild(el('span', { text: opt.label }));
                if (opt.description) {
                    row.appendChild(el('small', { text: opt.description }));
                }
                group.appendChild(row);
                radios.push(radio);
            });
            wrap.appendChild(group);
            // Focus the selected radio (or the first) when this is the auto field.
            const focusTarget = radios.find((r) => r.checked) || radios[0];
            return { wrap, input: focusTarget, errorEl: null };
        }

        if (field.label) {
            wrap.appendChild(el('label', {
                text: field.label,
                attrs: { for: 'dbmn-modal-field-' + field.id }
            }));
        }

        let input;
        if (field.type === 'textarea') {
            input = el('textarea');
        } else if (field.type === 'select') {
            input = el('select');
            // Options with a `group` go under that heading (an <optgroup>), in the order given
            let group = null;
            (field.options || []).forEach((opt) => {
                const o = el('option', { text: opt.label });
                o.value = opt.value;
                if (field.value === opt.value) o.selected = true;
                if (!opt.group) {
                    group = null;
                    input.appendChild(o);
                    return;
                }
                if (!group || group.label !== opt.group) {
                    group = el('optgroup', { attrs: { label: opt.group } });
                    input.appendChild(group);
                }
                group.appendChild(o);
            });
        } else {
            input = el('input');
            input.type = field.type || 'text';
            if (field.value != null) input.value = field.value;
        }

        input.id = 'dbmn-modal-field-' + field.id;
        input.name = field.id;
        input.className = 'dbmn-modal-input';
        // Password managers and the browser's autofill belong only where a sign-in is asked for: an
        // email, a user name or a password (a field may say so with `autocomplete`, as 'username').
        // Everywhere else they stay out ("name" in the Rename dialog drew 1Password's button over
        // what was typed).
        const signIn = input.type === 'password' || input.type === 'email' || /^(username|email|current-password|new-password)$/.test(field.autocomplete || '');
        if (signIn) {
            input.setAttribute('autocomplete', field.autocomplete || (input.type === 'password' ? 'current-password' : 'email'));
        } else {
            input.setAttribute('autocomplete', 'off');
            input.setAttribute('data-1p-ignore', 'true');       // 1Password
            input.setAttribute('data-lpignore', 'true');        // LastPass
            input.setAttribute('data-bwignore', 'true');        // Bitwarden
            input.setAttribute('data-form-type', 'other');      // Dashlane
        }
        if (field.placeholder) input.placeholder = field.placeholder;
        if (field.required) input.required = true;
        if (field.type === 'textarea' && field.value != null) input.value = field.value;

        wrap.appendChild(input);

        // `suggestions`: values a text field offers as it's typed in, the typing filtering them (a
        // lookup table's valid values); any text can still be typed
        if (Array.isArray(field.suggestions) && field.suggestions.length && input.tagName === 'INPUT') {
            const list = el('datalist');
            list.id = 'dbmn-modal-field-' + field.id + '-options';
            field.suggestions.slice(0, 2000).forEach((value) => { const o = el('option'); o.value = String(value); list.appendChild(o); });
            input.setAttribute('list', list.id);
            wrap.appendChild(list);
        }

        // Inline validation error slot — hidden while empty via `.dbmn-modal-field-error:empty`.
        // Populated by validateField() when the field's declarative rules fail.
        const errorEl = el('span', { className: 'dbmn-modal-field-error' });
        wrap.appendChild(errorEl);
        return { wrap, input, errorEl };
    }

    /** Run a field's declarative validation rules against its current value.
     *  Rules are passed as data on `field.validate` since the spec crosses a
     *  postMessage boundary (functions get stripped).
     *
     *  Supported rules:
     *    required:      boolean
     *    pattern:       RegExp source string (no flags)
     *    integer:       true → whole numbers only (rejects decimals)
     *    min / max:     inclusive bounds (≥, ≤)
     *    gt / lt:       exclusive bounds (>, <)
     *    minLength / maxLength: string length bounds
     *    message:       terse override — shown as-is instead of the built-in
     *                   short message (kept short by design, no field name repeated)
     *
     *  Returns true if valid; false and paints .is-invalid + error text if not.
     *  Radio groups have no errorEl and are skipped (currently no validation
     *  need — the group always has a checked option).
     */
    function validateField(field, input, errorEl) {
        if (!errorEl) return true;
        const rules = field.validate;
        if (!rules) {
            errorEl.textContent = '';
            input.closest('.dbmn-modal-field')?.classList.remove('is-invalid');
            return true;
        }
        const value = (input.value || '').trim();
        // Concise error text — no repeated field label since the label is
        // right above the input; the messages read as terse constraints only.
        const say = (fallback) => rules.message || fallback;
        let error = '';

        if (rules.required && value === '') {
            error = say('required');
        } else if (value !== '') {
            // String length checks — applied to any non-empty value so string
            // fields work; numeric fields shouldn't set length rules.
            if (rules.minLength != null && value.length < rules.minLength) {
                error = say('≥ ' + rules.minLength + ' chars');
            } else if (rules.maxLength != null && value.length > rules.maxLength) {
                error = say('≤ ' + rules.maxLength + ' chars');
            } else if (rules.pattern) {
                try {
                    const re = new RegExp('^(?:' + rules.pattern + ')$');
                    if (!re.test(value)) error = say('invalid format');
                } catch { /* bad regex from caller — treat as pass */ }
            }

            // Numeric bounds (inclusive + exclusive) + integer check. Only run
            // when the caller declared one — string fields can pass a value
            // that's not a number without erroring.
            if (!error && (rules.integer || rules.min != null || rules.max != null
                            || rules.gt != null || rules.lt != null)) {
                const n = Number(value);
                if (Number.isNaN(n)) {
                    error = say('must be a number');
                } else if (rules.integer && !Number.isInteger(n)) {
                    error = say('whole number');
                } else if (rules.min != null && n < rules.min) {
                    error = say('≥ ' + rules.min);
                } else if (rules.max != null && n > rules.max) {
                    error = say('≤ ' + rules.max);
                } else if (rules.gt != null && n <= rules.gt) {
                    error = say('> ' + rules.gt);
                } else if (rules.lt != null && n >= rules.lt) {
                    error = say('< ' + rules.lt);
                }
            }
        }

        errorEl.textContent = error;
        const fieldEl = input.closest('.dbmn-modal-field');
        if (fieldEl) fieldEl.classList.toggle('is-invalid', !!error);
        return !error;
    }

    function collectFieldValues(form) {
        const out = {};
        form.querySelectorAll('[name]').forEach((el) => {
            // Radio groups: only the checked input contributes its value, so
            // unchecked siblings don't clobber it.
            if (el.type === 'radio') {
                if (el.checked) out[el.name] = el.value;
                return;
            }
            out[el.name] = el.value;
        });
        return out;
    }

    function trapFocus(modalEl, e) {
        if (e.key !== 'Tab') return;
        const focusables = modalEl.querySelectorAll(
            'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    }

    /**
     * Render and show a modal.
     * @returns {Promise<{ actionId: string, fields: Record<string, string> }>}
     */
    function show(opts) {
        // Shown over the open one (`over`): it waits behind, and is the open one again when this closes.
        // Otherwise every open one is dismissed, so the new one doesn't stack.
        const under = opts.over ? activeModal : null;
        while (activeModal && !under) {
            const was = activeModal;
            was.dismiss('dismiss');
            if (activeModal === was) break;   // (a modal that would not close: never loop)
        }

        const dismissible = opts.dismissible !== false;
        // An explicit empty array means "no footer" (e.g. a read-only viewer
        // that closes via the header ×, Escape, or Ctrl/Cmd+W). Omitting actions
        // still falls back to a single OK button.
        const explicitNoActions = Array.isArray(opts.actions) && opts.actions.length === 0;
        const actions = explicitNoActions
            ? []
            : (Array.isArray(opts.actions) && opts.actions.length > 0
                ? opts.actions
                : [{ id: 'ok', label: 'OK', variant: 'primary' }]);

        return new Promise((resolve, reject) => {
            // (where focus was: back there when this closes; per modal, so one shown over another keeps its own)
            const previouslyFocused = document.activeElement;

            const backdrop = el('div', {
                className: 'dbmn-modal-backdrop',
                attrs: { role: 'presentation' }
            });

            const titleId = 'dbmn-modal-title-' + Date.now();
            const modal = el('div', {
                className: 'dbmn-modal dbmn-modal-' + (opts.size || 'md'),
                attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }
            });

            // ── Header ────────────────────────────────────────────────
            const header = el('header', { className: 'dbmn-modal-header' });
            const title = el('h2', {
                className: 'dbmn-modal-title',
                text: opts.title || '',
                attrs: { id: titleId }
            });
            header.appendChild(title);
            const help = opts.help && opts.help.doc ? opts.help : null;
            if (help) {
                // Help mode (shared/help-mode.js) is the one way into the docs: the title is the
                // help target, no "?" icon in the header.
                title.setAttribute('data-help', help.doc + (help.section ? '#' + help.section : ''));
            }
            if (opts.maximisable) {
                // Maximise: the dialog takes the whole window (the editors' Maximise icon); again restores it
                const maxBtn = el('button', {
                    className: 'editor-window-btn icon dbmn-modal-max',
                    attrs: { type: 'button', 'data-icon': 'maximize-2', title: 'Maximise', 'aria-label': 'Maximise', 'aria-pressed': 'false' }
                });
                maxBtn.addEventListener('click', () => {
                    const on = modal.classList.toggle('is-maximised');
                    backdrop.classList.toggle('has-maximised', on);
                    if (window.Icons) window.Icons.setIcon(maxBtn, on ? 'minimize-2' : 'maximize-2');
                    maxBtn.title = on ? 'Restore' : 'Maximise';
                    maxBtn.setAttribute('aria-label', maxBtn.title);
                    maxBtn.setAttribute('aria-pressed', String(on));
                });
                header.appendChild(maxBtn);
                if (window.Icons) window.Icons.injectIcons(header);
            }
            if (dismissible) {
                const closeBtn = el('button', {
                    className: 'dbmn-modal-close',
                    text: '×',
                    attrs: { type: 'button', 'aria-label': 'Close', title: 'Close' }
                });
                closeBtn.addEventListener('click', () => dismiss('dismiss'));
                header.appendChild(closeBtn);
            }
            modal.appendChild(header);

            // ── Body + optional fields ───────────────────────────────
            const form = el('form', { className: 'dbmn-modal-form' });
            // Our own checks (validateAllFields, inline), not the browser's popup: Enter goes
            // through the button's click below, as a click does
            form.noValidate = true;
            form.addEventListener('submit', (e) => {
                e.preventDefault();
                // Enter inside a field triggers the primary action. Route
                // through the primary button's own click handler so field
                // validation and onHostSubmit run exactly as if the user
                // clicked it — no separate code path. Never a danger button:
                // a delete is clicked, not entered.
                const danger = (a) => a.variant === 'danger' || a.variant === 'destructive';
                const primary = actions.find((a) => a.variant === 'primary')
                    || (actions.length === 1 && !danger(actions[0]) ? actions[0] : null);
                if (!primary) { if (dismissible && actions.length === 0) dismiss('dismiss'); return; }
                const btn = footer && footer.querySelector('[data-action-id="' + primary.id + '"]');
                if (btn) btn.click();
                else dismiss(primary.id);
            });

            const body = el('div', { className: 'dbmn-modal-body' });
            if (opts.body instanceof HTMLElement) {
                body.appendChild(opts.body);
            } else if (typeof opts.body === 'string' && opts.body.length > 0) {
                body.appendChild(el('p', { text: opts.body }));
            }
            form.appendChild(body);

            const fieldInputs = [];
            // Issue #302 — set by setupRowPaste(); shared by the Ctrl+V handler
            // and the footer Paste button (built later, once the footer exists).
            // Declared before the fields block because that block assigns it.
            let applyRowText = null;
            if (Array.isArray(opts.fields) && opts.fields.length > 0) {
                // Two-column layout is opt-in via `columns: 2` — see .is-2col in modals.css.
                // Useful for Run API when the endpoint has many template variables and
                // stacking them vertically would push the primary action off-screen.
                const fieldsWrap = el('div', {
                    className: 'dbmn-modal-fields' + (opts.columns === 2 ? ' is-2col' : '')
                });
                opts.fields.forEach((field) => {
                    const { wrap, input, errorEl } = buildField(field);
                    fieldsWrap.appendChild(wrap);
                    fieldInputs.push({ field, input, errorEl });

                    // No live validation — feels nagging, and the fields typically
                    // start blank/invalid on open. Validation runs when the user
                    // clicks the primary action (see validateAllFields below). Once
                    // an error is showing, typing more into that field clears it.
                    if (field.validate && errorEl) {
                        input.addEventListener('input', () => {
                            if (errorEl.textContent) validateField(field, input, errorEl);
                        });
                    }
                });
                form.appendChild(fieldsWrap);

                // Issue #302: `rowPaste: true` lets the user paste a spreadsheet
                // row (header + one data row) into ANY field and have every
                // matching field filled. The parse lives in shared/row-paste.js
                // (pure, unit-tested); this is only the DOM glue. Opt-in via a
                // serialisable flag because the spec crosses postMessage.
                if (opts.rowPaste) {
                    setupRowPaste(fieldsWrap, fieldInputs);
                }
            }

            /** Issue #302 — wire the paste-a-row behaviour onto the fields block.
             *  No instructions in the form itself: the footer carries a Paste
             *  button and a help icon that opens the dbmn.io section. */
            function setupRowPaste(fieldsWrap, inputs) {
                const status = el('p', {
                    className: 'dbmn-modal-paste-status',
                    attrs: { role: 'status', 'aria-live': 'polite' }
                });
                fieldsWrap.insertAdjacentElement('afterend', status);

                /** Fill the form from clipboard text. Returns false when the
                 *  text isn't a row for this form. `explicit` = the user asked
                 *  for a row paste (button), so a miss is worth explaining. */
                applyRowText = function (text, explicit) {
                    const RowPaste = window.RowPaste;
                    const ids = inputs.map((f) => f.field.id);
                    const result = RowPaste && text ? RowPaste.fillFromPaste(text, ids) : null;
                    if (!result) {
                        if (explicit) {
                            status.classList.add('is-error');
                            status.textContent = 'Nothing to paste — copy a header row and one data row first.';
                        }
                        return false;
                    }

                    let filledCount = 0;
                    inputs.forEach(({ field, input, errorEl }) => {
                        if (!(field.id in result.filled)) return;
                        if (applyPastedValue(field, input, result.filled[field.id])) {
                            filledCount++;
                            if (errorEl) {
                                errorEl.textContent = '';
                                input.closest('.dbmn-modal-field')?.classList.remove('is-invalid');
                            }
                        }
                    });

                    const parts = ['Filled ' + filledCount + ' of ' + inputs.length + ' fields from the pasted row.'];
                    if (result.unfilledFields.length > 0) {
                        parts.push('Still empty: ' + result.unfilledFields.join(', ') + '.');
                    }
                    if (result.unmatchedColumns.length > 0) {
                        parts.push('Ignored columns: ' + result.unmatchedColumns.join(', ') + '.');
                    }
                    status.classList.remove('is-error');
                    status.textContent = parts.join(' ');
                    return true;
                };

                // Ctrl+V in any field does the same as the Paste button. Capture
                // phase so the fill wins over the focused input's own paste; a
                // paste that isn't a row falls through untouched.
                form.addEventListener('paste', (e) => {
                    if (!e.clipboardData) return;
                    if (applyRowText(e.clipboardData.getData('text/plain'), false)) {
                        e.preventDefault();
                        e.stopPropagation();
                    }
                }, true);
            }

            /** Clipboard text for the Paste button. Inside VS Code the webview
             *  can't be relied on to read the clipboard, so ask the host
             *  (`dbmnModalReadClipboard` → `dbmnModalClipboardText`, see
             *  webview-base.ts); outside it, or if the host never answers, use
             *  the browser API. Promise chains, not async/await — webview lint. */
            function readClipboardText() {
                const browserRead = function () {
                    if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
                        return navigator.clipboard.readText();
                    }
                    return Promise.reject(new Error('Clipboard unavailable'));
                };
                const vscodeApi = window.vscode;
                if (!vscodeApi || typeof vscodeApi.postMessage !== 'function') return browserRead();

                return new Promise(function (resolve, reject) {
                    const readId = 'clip-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
                    let settled = false;
                    const onMessage = function (ev) {
                        const m = ev.data;
                        if (!m || m.type !== 'dbmnModalClipboardText' || m.readId !== readId) return;
                        finish();
                        resolve(typeof m.text === 'string' ? m.text : '');
                    };
                    const finish = function () {
                        settled = true;
                        clearTimeout(timer);
                        window.removeEventListener('message', onMessage);
                    };
                    const timer = setTimeout(function () {
                        if (settled) return;
                        finish();
                        browserRead().then(resolve, reject);
                    }, 2000);
                    window.addEventListener('message', onMessage);
                    vscodeApi.postMessage({ type: 'dbmnModalReadClipboard', readId: readId });
                });
            }

            /** Footer-left control: the row Paste button (rowPaste modals). */
            function buildFooterLeft() {
                const wantsPaste = !!applyRowText;
                if (!wantsPaste) return null;
                const left = el('div', { className: 'dbmn-modal-footer-left' });

                if (wantsPaste) {
                    const pasteBtn = el('button', {
                        className: 'btn btn-secondary',
                        attrs: {
                            type: 'button',
                            'data-modal-paste': 'row',
                            title: 'Paste a copied spreadsheet row (header row + data row) to fill every field. Ctrl+V in any field does the same.'
                        }
                    });
                    const glyph = window.Icons && window.Icons.roleIcon ? window.Icons.roleIcon('paste-row') : '';
                    if (glyph) {
                        const iconSpan = el('span', { className: 'btn-icon icon' });
                        iconSpan.innerHTML = glyph; // static SVG from the icon registry
                        pasteBtn.appendChild(iconSpan);
                    }
                    pasteBtn.appendChild(document.createTextNode('Paste'));
                    pasteBtn.addEventListener('click', function () {
                        readClipboardText().then(
                            function (text) { applyRowText(text, true); },
                            function () { applyRowText('', true); }
                        );
                    });
                    left.appendChild(pasteBtn);
                }

                return left;
            }

            /** Put a pasted value into a field, respecting its type. Returns
             *  true when the field took the value. Selects and radios only
             *  accept a value that is one of their options. */
            function applyPastedValue(field, input, value) {
                if (field.type === 'select') {
                    const match = Array.from(input.options).find((o) => o.value === value)
                        || Array.from(input.options).find((o) => o.value.toLowerCase() === String(value).toLowerCase());
                    if (!match) return false;
                    input.value = match.value;
                } else if (field.type === 'radio') {
                    const radio = Array.from(form.querySelectorAll('input[type=radio][name="' + field.id + '"]'))
                        .find((r) => r.value === value || r.value.toLowerCase() === String(value).toLowerCase());
                    if (!radio) return false;
                    radio.checked = true;
                } else {
                    input.value = value;
                }
                input.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
            }

            /** Run every field's validation; return true if all pass. Any that
             *  fail get their .is-invalid + error text painted; the first one
             *  gets keyboard focus so the user can fix it without hunting. */
            function validateAllFields() {
                let firstInvalid = null;
                for (const { field, input, errorEl } of fieldInputs) {
                    if (!validateField(field, input, errorEl) && !firstInvalid) {
                        firstInvalid = input;
                    }
                }
                if (firstInvalid) {
                    try { firstInvalid.focus(); } catch { /* focus can fail on detached nodes */ }
                    return false;
                }
                return true;
            }

            /** Paint per-field error text supplied by an async `onSubmit`
             *  handler on the host side — used when host-run validation
             *  (e.g. the batch prep `applyModifiers`) rejects specific fields.
             *  Keeps the modal open; focuses the first flagged field. */
            function paintFieldErrors(fieldErrors) {
                let firstInvalid = null;
                for (const { field, input, errorEl } of fieldInputs) {
                    if (!errorEl) continue;
                    const msg = fieldErrors[field.id];
                    if (msg) {
                        errorEl.textContent = msg;
                        input.closest('.dbmn-modal-field')?.classList.add('is-invalid');
                        if (!firstInvalid) firstInvalid = input;
                    } else {
                        errorEl.textContent = '';
                        input.closest('.dbmn-modal-field')?.classList.remove('is-invalid');
                    }
                }
                if (firstInvalid) {
                    try { firstInvalid.focus(); } catch { /* focus can fail */ }
                }
            }

            // Enter submits the form only if it has a submit button once it holds two or more
            // fields (the browser's rule): the footer's buttons are outside it. This one, unseen and
            // out of the tab order, makes Enter work the same with one field or several.
            form.appendChild(el('button', { className: 'dbmn-modal-implicit-submit', attrs: { type: 'submit', tabindex: '-1', 'aria-hidden': 'true' } }));
            modal.appendChild(form);

            /** "Not yet: try again in N seconds" from the host (ModalWait in modal.types.ts): the
             *  action's button stays off and the field's line counts down, then both clear. */
            let waitTimer = null;
            function startWait(wait) {
                clearInterval(waitTimer);
                const target = fieldInputs.find((f) => f.field.id === wait.field);
                const button = actionButtons.find((b) => b.getAttribute('data-action-id') === wait.actionId);
                const ends = Date.now() + Math.max(1, Math.ceil(Number(wait.seconds) || 0)) * 1000;
                const paint = () => {
                    const left = Math.ceil((ends - Date.now()) / 1000);
                    if (left <= 0) {
                        clearInterval(waitTimer);
                        waitTimer = null;
                        if (button) button.disabled = false;
                        if (target && target.errorEl) target.errorEl.textContent = '';
                        return;
                    }
                    if (button) button.disabled = true;
                    if (target && target.errorEl) {
                        target.errorEl.textContent = String(wait.text || '').replace('{seconds}', left === 1 ? '1 second' : left + ' seconds');
                    }
                };
                paint();
                waitTimer = setInterval(paint, 250);
            }

            // ── Footer / actions ─────────────────────────────────────
            // Actions can carry `awaitsHostSubmit: true` to indicate the
            // host needs to run async work before the modal closes. The
            // caller passes `opts.onHostSubmit(actionId, fields)` — a
            // Promise-returning callback that the modal awaits while it
            // keeps the modal open with a spinner on the clicked button.
            // (Direct function callbacks on the action can't be used here
            // because the spec crosses a postMessage boundary that strips
            // functions; awaitsHostSubmit is a serialisable flag.)
            let footer = null;
            const actionButtons = [];
            if (actions.length > 0) {
                footer = el('footer', { className: 'dbmn-modal-footer' });
            }
            actions.forEach((action) => {
                const btn = el('button', {
                    className: 'btn btn-' + (action.variant || 'secondary'),
                    text: action.label,
                    attrs: { type: 'button', 'data-action-id': action.id }
                });
                actionButtons.push(btn);
                btn.addEventListener('click', async () => {
                    // Committing actions (primary / danger) validate the fields
                    // before doing anything. Cancel/secondary skip validation
                    // so the user can always back out without fixing errors.
                    const shouldValidate =
                        (action.variant === 'primary' || action.variant === 'danger')
                        && fieldInputs.length > 0;
                    if (shouldValidate && !validateAllFields()) {
                        return; // first invalid field is already focused
                    }
                    var _fields = collectFieldValues(form);
                    if (!action.awaitsHostSubmit || typeof opts.onHostSubmit !== 'function') {
                        dismiss(action.id);
                        return;
                    }
                    // Busy state: disable all action buttons, swap clicked
                    // button to spinner + "${label}…".
                    actionButtons.forEach((b) => { b.disabled = true; });
                    btn.classList.add('is-busy');
                    btn.textContent = '';
                    const spinner = el('span', { className: 'btn-spinner' });
                    btn.appendChild(spinner);
                    btn.appendChild(document.createTextNode(action.label + '…'));
                    try {
                        const outcome = await opts.onHostSubmit(action.id, _fields);
                        // Host can reject softly by resolving with `{fieldErrors}`
                        // — we paint each error inline, reset the button, and
                        // keep the modal open so the user can fix and retry
                        // without losing what they typed.
                        if (outcome && outcome.fieldErrors && Object.keys(outcome.fieldErrors).length > 0) {
                            paintFieldErrors(outcome.fieldErrors);
                            restoreActionButtons();
                            return;
                        }
                        if (outcome && outcome.wait) {
                            restoreActionButtons();
                            startWait(outcome.wait);
                            return;
                        }
                        dismiss(action.id);
                    } catch (err) {
                        dismissWithError(action.id, err);
                    }
                });

                // Reset all action buttons after a soft validation failure so
                // the user can edit + retry. Called only from the field-errors
                // branch above — a real reject still dismisses via the catch.
                function restoreActionButtons() {
                    actionButtons.forEach((b) => { b.disabled = false; });
                    btn.classList.remove('is-busy');
                    btn.textContent = '';
                    btn.appendChild(document.createTextNode(action.label));
                }
                footer.appendChild(btn);
            });
            if (footer) {
                const footerLeft = buildFooterLeft();
                if (footerLeft) footer.insertBefore(footerLeft, footer.firstChild);
                modal.appendChild(footer);
            }

            backdrop.appendChild(modal);
            document.body.appendChild(backdrop);

            // ── Behaviour ────────────────────────────────────────────
            const onKeydown = (e) => {
                // (a modal waiting behind another hears nothing: Escape closes the one on top only)
                if (activeModal !== handle) return;
                if (e.key === 'Escape' && dismissible) {
                    e.preventDefault();
                    dismiss('dismiss');
                    return;
                }
                // Ctrl/Cmd+W closes the modal (not the whole webview panel) while
                // one is open — matches Escape.
                if ((e.key === 'w' || e.key === 'W') && (e.ctrlKey || e.metaKey) && dismissible) {
                    e.preventDefault();
                    e.stopPropagation();
                    dismiss('dismiss');
                    return;
                }
                trapFocus(modal, e);
            };
            const onBackdropClick = (e) => {
                if (!dismissible) return;
                if (e.target === backdrop) dismiss('dismiss');
            };

            document.addEventListener('keydown', onKeydown);
            backdrop.addEventListener('mousedown', onBackdropClick);

            function dismiss(actionId) {
                if (activeModal !== handle) return;
                clearInterval(waitTimer);
                document.removeEventListener('keydown', onKeydown);
                backdrop.removeEventListener('mousedown', onBackdropClick);
                backdrop.remove();
                // (the one it was shown over is the open one again)
                activeModal = under;
                if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
                    try { previouslyFocused.focus(); } catch { /* gone from DOM */ }
                }
                resolve({ actionId, fields: collectFieldValues(form) });
            }

            // Same teardown as dismiss(), but the show() promise rejects so
            // callers using `action.onSubmit` see the thrown error rather
            // than a normal `{actionId, fields}` resolution.
            function dismissWithError(actionId, err) {
                if (activeModal !== handle) return;
                clearInterval(waitTimer);
                document.removeEventListener('keydown', onKeydown);
                backdrop.removeEventListener('mousedown', onBackdropClick);
                backdrop.remove();
                // (the one it was shown over is the open one again)
                activeModal = under;
                if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
                    try { previouslyFocused.focus(); } catch { /* gone from DOM */ }
                }
                void actionId;
                reject(err);
            }

            const handle = { dismiss, dismissible };
            activeModal = handle;

            // Auto-focus: first field marked autoFocus, else first field, else
            // the primary action button.
            const auto = fieldInputs.find((f) => f.field.autoFocus) || fieldInputs[0];
            if (auto) {
                auto.input.focus();
                if (auto.input.select) try { auto.input.select(); } catch { /* select() can fail */ }
            } else {
                // (a dialog with no actions has no footer: the cell value window)
                const primaryBtn = footer && (footer.querySelector('.btn-primary') || footer.querySelector('button'));
                primaryBtn?.focus();
            }
        });
    }

    /**
     * Yes/No-style confirm. Returns Promise<boolean>.
     */
    function confirm(opts) {
        return show({
            title: opts.title || 'Confirm',
            body: opts.body || '',
            dismissible: opts.dismissible !== false,
            actions: [
                { id: 'cancel', label: opts.cancelLabel || 'Cancel', variant: 'secondary' },
                { id: 'confirm', label: opts.confirmLabel || 'OK', variant: opts.confirmVariant || 'primary' }
            ]
        }).then((result) => result.actionId === 'confirm');
    }

    /**
     * Info modal — single OK button. Returns Promise<void>.
     */
    function alert(opts) {
        return show({
            title: opts.title || 'Notice',
            body: opts.body || '',
            dismissible: opts.dismissible !== false,
            actions: [{ id: 'ok', label: opts.okLabel || 'OK', variant: 'primary' }]
        }).then(() => undefined);
    }

    /**
     * True while a modal is on screen. Lets callers (e.g. the Hub's Ctrl/Cmd+W
     * handler) check whether the modal owns the keystroke before acting.
     */
    function isOpen() {
        return activeModal !== null;
    }

    /**
     * The Escape equivalent for external callers. Returns whether a modal was
     * present (and therefore the keystroke should be considered consumed):
     *   - no modal open         → false (nothing to do)
     *   - dismissible modal     → dismiss it, return true
     *   - non-dismissible modal → swallow (do nothing), return true
     */
    function requestDismiss() {
        if (!activeModal) return false;
        if (activeModal.dismissible) activeModal.dismiss('dismiss');
        return true;
    }

    window.DbmnModal = { show, confirm, alert, isOpen, requestDismiss };

    /**
     * Auto-bridge listener: any webview that loads dbmn-modal.js + has
     * `window.vscode` set automatically becomes a host for extension-host
     * modal requests. Extension-host code posts `{ type: 'dbmnModalRequest',
     * requestId, spec }` and gets back `{ type: 'dbmnModalResult', requestId,
     * result }`. No per-webview wiring needed.
     */
    function attachAutoBridge() {
        const vscode = window.vscode;
        if (!vscode) return; // host script hasn't initialized vscode API yet
        if (window.__dbmnModalBridgeAttached) return;
        window.__dbmnModalBridgeAttached = true;
        window.addEventListener('message', function (event) {
            const msg = event.data;
            if (!msg || msg.type !== 'dbmnModalRequest' || !msg.requestId) return;
            const requestId = msg.requestId;
            // BUGFIX: `show(opts)` takes a SINGLE argument. onHostSubmit was
            // previously passed as a 2nd arg here and silently dropped, so
            // `opts.onHostSubmit` was always undefined → the modal dismissed
            // WITHOUT ever running the host `onSubmit`. That broke every
            // backend-driven modal (magic-link + password sign-in, etc.) — the
            // success toast fired but no work happened. It must live ON the spec.
            const hostSpec = msg.spec || {};
            // Bridge the modal's "host needs to do async work" callback to a
            // postMessage roundtrip. Each call gets a fresh submitId so
            // concurrent submits can't collide. Awaits a matching
            // `dbmnModalActionResult` reply, resolves/rejects accordingly.
            hostSpec.onHostSubmit = function (actionId, fields) {
                    return new Promise(function (resolve, reject) {
                        const submitId = 'sub-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
                        const handler = function (ev) {
                            const m = ev.data;
                            if (!m || m.type !== 'dbmnModalActionResult' || m.submitId !== submitId) return;
                            window.removeEventListener('message', handler);
                            if (m.success) {
                                resolve();
                                return;
                            }
                            // "Not yet": the modal stays open and counts the wait down.
                            if (m.wait) {
                                resolve({ wait: m.wait });
                                return;
                            }
                            // Soft-fail path: host has per-field validation errors.
                            // Resolve with them so show() paints the inline errors
                            // and keeps the modal open rather than dismissing.
                            if (m.fieldErrors && Object.keys(m.fieldErrors).length > 0) {
                                resolve({ fieldErrors: m.fieldErrors });
                                return;
                            }
                            reject(new Error(m.error || 'Sign-in failed.'));
                        };
                        window.addEventListener('message', handler);
                        vscode.postMessage({
                            type: 'dbmnModalActionPending',
                            requestId: requestId,
                            submitId: submitId,
                            actionId: actionId,
                            fields: fields
                        });
                    });
                };
            show(hostSpec).then(function (result) {
                vscode.postMessage({ type: 'dbmnModalResult', requestId: requestId, result: result });
            }, function (err) {
                // show() rejected — the host's onSubmit threw. Surface it
                // back as a result with the actionId and an `error` field so
                // showModal can convert it into a rejected promise.
                vscode.postMessage({
                    type: 'dbmnModalResult',
                    requestId: requestId,
                    result: { actionId: 'error', fields: {}, error: err instanceof Error ? err.message : String(err) }
                });
            });
        });
    }
    // Retry every 50ms until vscode API is available (some webviews wire
    // `window.vscode` after dbmn-modal.js loads). Stops after ~5s.
    if (window.vscode) {
        attachAutoBridge();
    } else {
        let tries = 0;
        const interval = setInterval(function () {
            if (window.vscode || tries++ > 100) {
                clearInterval(interval);
                attachAutoBridge();
            }
        }, 50);
    }
})();
