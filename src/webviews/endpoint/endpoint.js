// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
// Endpoint webview JavaScript
(function () {
    // Get vscode API - only acquire once
    let vscode = window.vscode;
    if (!vscode) {
        try {
            vscode = acquireVsCodeApi();
            window.vscode = vscode; // Share with modules
        } catch (error) {
            vscode = window.vscode; // Use existing
        }
    }

    // Hydrate icon placeholders + wire the window-controls cluster (min/max/close).
    if (window.EditorWindowControls) window.EditorWindowControls.wire(vscode);

    // Undo/Redo state tracking
    let initialVersionId = null;
    let canRedo = false;

    // Global keyboard shortcuts - intercept before VS Code can grab them
    document.addEventListener('keydown', function (e) {
        const isCtrlOrCmd = e.ctrlKey || e.metaKey;

        // Ctrl+S or Cmd+S - Save endpoint
        if (isCtrlOrCmd && e.key === 's') {
            e.preventDefault();
            e.stopPropagation();
            if (typeof saveEndpoint === 'function') {
                saveEndpoint();
            } else if (window.saveEndpoint) {
                window.saveEndpoint();
            }
            return false;
        }

        // Ctrl+/ or Cmd+/ - Toggle line comment (only when Monaco editor is focused)
        // Check multiple key representations for cross-platform compatibility
        const isSlashKey = e.key === '/' || e.code === 'Slash' || e.keyCode === 191;
        if (isCtrlOrCmd && isSlashKey) {
            if (window.monacoEditor) {
                e.preventDefault();
                e.stopPropagation();

                // Try Monaco's built-in action first
                const action = window.monacoEditor.getAction('editor.action.commentLine');

                if (action) {
                    action.run();
                } else {
                    // Fallback: manually toggle line comment
                    toggleLineComment();
                }
                return false;
            }
        }

        // Ctrl+D or Cmd+D - Delete line
        if (isCtrlOrCmd && (e.key === 'd' || e.key === 'D') && window.monacoEditor) {
            e.preventDefault();
            e.stopPropagation();
            deleteCurrentLine();
            return false;
        }

        // Ctrl+M or Cmd+M - Line Variable action (cycle on key-value lines)
        // Only works on single line (not multi-line selection)
        if (isCtrlOrCmd && !e.shiftKey && (e.key === 'm' || e.key === 'M') && window.monacoEditor) {
            const selection = window.monacoEditor.getSelection();
            const isMultiLine = selection && selection.startLineNumber !== selection.endLineNumber;
            if (!isMultiLine) {
                e.preventDefault();
                e.stopPropagation();
                cycleLineVariable();
                return false;
            }
        }

        // Ctrl+Shift+M or Cmd+Shift+M - Insert/Remove {{}} at cursor
        if (isCtrlOrCmd && e.shiftKey && (e.key === 'm' || e.key === 'M') && window.monacoEditor) {
            e.preventDefault();
            e.stopPropagation();
            toggleInsertVariable();
            return false;
        }
    }, true); // Use capture phase to intercept before bubbling

    // Manual line comment toggle for JSONC (fallback if Monaco action unavailable)
    function toggleLineComment() {
        if (!window.monacoEditor) return;

        const model = window.monacoEditor.getModel();
        const selections = window.monacoEditor.getSelections();
        if (!model || !selections || selections.length === 0) return;

        const edits = [];
        const selection = selections[0];
        const startLine = selection.startLineNumber;
        const endLine = selection.endLineNumber;

        // Check if all selected lines are already commented
        let allCommented = true;
        for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
            const lineContent = model.getLineContent(lineNum);
            const trimmed = lineContent.trimStart();
            if (trimmed && !trimmed.startsWith('//')) {
                allCommented = false;
                break;
            }
        }

        // Toggle comments
        for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
            const lineContent = model.getLineContent(lineNum);

            if (allCommented) {
                // Remove comment - find first // and remove it
                const commentIndex = lineContent.indexOf('//');
                if (commentIndex !== -1) {
                    // Remove // and one space after if present
                    const removeLength = lineContent[commentIndex + 2] === ' ' ? 3 : 2;
                    edits.push({
                        range: new monaco.Range(lineNum, commentIndex + 1, lineNum, commentIndex + 1 + removeLength),
                        text: ''
                    });
                }
            } else {
                // Add comment at the start of the line (after leading whitespace)
                const firstNonWhitespace = lineContent.search(/\S/);
                const insertCol = firstNonWhitespace === -1 ? 1 : firstNonWhitespace + 1;
                edits.push({
                    range: new monaco.Range(lineNum, insertCol, lineNum, insertCol),
                    text: '// '
                });
            }
        }

        if (edits.length > 0) {
            window.monacoEditor.executeEdits('toggle-comment', edits);
        }
    }

    // ================================================
    // Editor Toolbar Functions
    // ================================================

    /**
     * Delete the current line(s)
     */
    function deleteCurrentLine() {
        if (!window.monacoEditor) return;
        if (deleteBlockAtCursor()) return;
        const action = window.monacoEditor.getAction('editor.action.deleteLines');
        if (action) action.run();
    }

    /**
     * On a line that opens an object or array (`"buyer": {`), delete the whole
     * block rather than just its first line, and the comma it leaves dangling if
     * it was the last member (see shared/line-block.js). Single-line cursor or
     * selection only — a multi-line selection deletes exactly what's selected.
     * @returns {boolean} true when a block was deleted
     */
    function deleteBlockAtCursor() {
        const editor = window.monacoEditor;
        const model = editor.getModel();
        const sel = editor.getSelection();
        if (!window.LineBlock || !model || !sel || sel.startLineNumber !== sel.endLineNumber) return false;

        const block = window.LineBlock.findBlock(model.getLinesContent(), sel.startLineNumber);
        if (!block) return false;

        const { startLine, endLine, commaAt } = block;
        const lineCount = model.getLineCount();
        const range = endLine < lineCount
            ? new monaco.Range(startLine, 1, endLine + 1, 1)
            : startLine > 1
                ? new monaco.Range(startLine - 1, model.getLineMaxColumn(startLine - 1), endLine, model.getLineMaxColumn(endLine))
                : new monaco.Range(1, 1, endLine, model.getLineMaxColumn(endLine));
        const edits = [{ range, text: '' }];
        if (commaAt) {
            edits.push({ range: new monaco.Range(commaAt.line, commaAt.column, commaAt.line, commaAt.column + 1), text: '' });
        }

        editor.pushUndoStop();
        editor.executeEdits('delete-block', edits);
        editor.pushUndoStop();
        const line = Math.min(startLine, model.getLineCount());
        editor.setPosition({ lineNumber: line, column: model.getLineFirstNonWhitespaceColumn(line) || 1 });
        return true;
    }

    /**
     * Infer the type from a JSON value
     * @param {string} value - The JSON value string
     * @returns {string|null} - The inferred type, or null if cannot infer
     */
    function inferType(value) {
        if (value === 'null') return null; // Cannot infer
        if (value === 'true' || value === 'false') return 'boolean';
        if (/^-?\d+$/.test(value)) return 'number';
        if (/^-?\d+\.\d+$/.test(value)) return 'number';
        if (value.startsWith('"') && value.endsWith('"')) return 'string';
        if (value.startsWith('[')) return 'string'; // Arrays become string by default
        if (value.startsWith('{')) return 'string'; // Objects become string by default
        return 'string'; // Default fallback
    }

    /**
     * Cycle through variable states on current line (4-way toggle with Ctrl+M)
     * 1. Regular value → Input Variable: "key": 123 → "key": "{{key:number}}", //123
     * 2. Input Variable → ENV Variable: "key": "{{key:number}}", //123 → "key": "{{ENV:}}", //123
     * 3. ENV Variable → A8 Variable: "key": "{{ENV:xyz}}", //123 → "key": "{{A8:}}", //123
     * 4. A8 Variable → Restore: "key": "{{A8:xyz}}", //123 → "key": 123
     */
    function cycleLineVariable() {
        if (!window.monacoEditor) return;

        const model = window.monacoEditor.getModel();
        const position = window.monacoEditor.getPosition();
        const lineContent = model.getLineContent(position.lineNumber);

        // Parse JSON key-value pattern with optional trailing comment: "key": value, //comment
        const match = lineContent.match(/^(\s*)"([^"]+)":\s*(.+?)(,?)(\s*)(\/\/(.*))?$/);
        if (!match) {
            showFooterNotification('warning', 'Place cursor on a key-value line', { persistent: false });
            return;
        }

        const [, indent, key, value, comma, whitespace, commentPart, commentValue] = match;
        const trimmedValue = value.trim();

        // Check current state and cycle to next
        const isA8Variable = trimmedValue.includes('{{A8:');
        const isEnvVariable = trimmedValue.includes('{{ENV:') && !isA8Variable;
        const isInputVariable = trimmedValue.includes('{{') && !isEnvVariable && !isA8Variable;

        if (isA8Variable) {
            // State 4 → State 1: A8 Variable → Restore original from comment (or cycle to blank)
            if (commentValue !== undefined && commentValue.trim()) {
                // Restore original value from comment
                const originalValue = commentValue.trim();
                const newLine = `${indent}"${key}": ${originalValue}${comma}`;

                window.monacoEditor.executeEdits('restore-from-variable', [{
                    range: new monaco.Range(position.lineNumber, 1, position.lineNumber, lineContent.length + 1),
                    text: newLine
                }]);

                // Dismiss autocomplete when restoring original value
                window.monacoEditor.trigger('keyboard', 'hideSuggestWidget', {});

                window.TemplateCompletions.updateDecorations();
                return;
            } else {
                // No original to restore - cycle back to blank input variable
                const newLine = `${indent}"${key}": "{{}}"${comma}`;

                window.monacoEditor.executeEdits('cycle-to-blank-variable', [{
                    range: new monaco.Range(position.lineNumber, 1, position.lineNumber, lineContent.length + 1),
                    text: newLine
                }]);

                // Position cursor inside {{}} for typing
                const cursorColumn = indent.length + key.length + 4 + 3; // after "{{
                window.monacoEditor.setPosition({ lineNumber: position.lineNumber, column: cursorColumn });

                window.TemplateCompletions.updateDecorations();
                return;
            }
        } else if (isEnvVariable) {
            // State 3 → State 4: ENV Variable → A8 Variable (keep comment)
            const comment = commentValue !== undefined ? ` //${commentValue}` : '';
            const newLine = `${indent}"${key}": "{{A8:}}"${comma}${comment}`;

            window.monacoEditor.executeEdits('convert-to-a8-variable', [{
                range: new monaco.Range(position.lineNumber, 1, position.lineNumber, lineContent.length + 1),
                text: newLine
            }]);

            // Position cursor after A8: and trigger autocomplete
            const cursorColumn = indent.length + key.length + 4 + 6 + 1; // "{{A8: = 6 chars
            window.monacoEditor.setPosition({ lineNumber: position.lineNumber, column: cursorColumn });
            window.monacoEditor.trigger('keyboard', 'editor.action.triggerSuggest', {});

            window.TemplateCompletions.updateDecorations();
            return;
        } else if (isInputVariable) {
            // State 2 → State 3: Input Variable → ENV Variable (keep comment)
            const comment = commentValue !== undefined ? ` //${commentValue}` : '';
            const newLine = `${indent}"${key}": "{{ENV:}}"${comma}${comment}`;

            window.monacoEditor.executeEdits('convert-to-env-variable', [{
                range: new monaco.Range(position.lineNumber, 1, position.lineNumber, lineContent.length + 1),
                text: newLine
            }]);

            // Position cursor after ENV: and trigger autocomplete
            const cursorColumn = indent.length + key.length + 4 + 7 + 1; // "{{ENV: = 7 chars
            window.monacoEditor.setPosition({ lineNumber: position.lineNumber, column: cursorColumn });
            window.monacoEditor.trigger('keyboard', 'editor.action.triggerSuggest', {});

            window.TemplateCompletions.updateDecorations();
            return;
        } else {
            // State 1 → State 2: Regular value → Input Variable
            const inferredType = inferType(trimmedValue);

            if (inferredType === null) {
                showFooterNotification('info', 'Cannot infer type from null value. Use string, number, or boolean.', { persistent: false });
                return;
            }

            const newValue = `"{{${key}:${inferredType}}}"`;
            const newLine = `${indent}"${key}": ${newValue}${comma} //${trimmedValue}`;

            window.monacoEditor.executeEdits('convert-to-variable', [{
                range: new monaco.Range(position.lineNumber, 1, position.lineNumber, lineContent.length + 1),
                text: newLine
            }]);

            window.TemplateCompletions.updateDecorations();
        }
    }

    /**
     * Check if cursor is inside a template variable {{...}}
     * Returns { inside: boolean, varStart: number, varEnd: number }
     * Handles edge cases like cursor between { and { or between } and }
     */
    function isCursorInsideVariable() {
        if (!window.monacoEditor) return { inside: false };

        const model = window.monacoEditor.getModel();
        const position = window.monacoEditor.getPosition();
        if (!model || !position) return { inside: false };

        const lineContent = model.getLineContent(position.lineNumber);
        const col = position.column - 1; // 0-indexed cursor position

        const textBefore = lineContent.substring(0, col);
        const textAfter = lineContent.substring(col);

        // Find opening {{ before cursor
        let lastOpen = textBefore.lastIndexOf('{{');

        // Edge case: cursor is between { and { (e.g., "{|{...")
        // textBefore ends with { and textAfter starts with {
        if (lastOpen === -1 && textBefore.endsWith('{') && textAfter.startsWith('{')) {
            lastOpen = col - 1; // The { before cursor is start of {{
        }

        if (lastOpen === -1) return { inside: false };

        // Check there's no }} between {{ and cursor (would mean we're outside)
        const betweenOpenAndCursor = lineContent.substring(lastOpen, col);
        if (betweenOpenAndCursor.includes('}}')) {
            return { inside: false };
        }

        // Find closing }} after the opening
        const searchAfterOpen = lineContent.substring(lastOpen + 2);
        let closeIndex = searchAfterOpen.indexOf('}}');

        // Edge case: cursor is between } and }
        if (closeIndex === -1 && textBefore.endsWith('}') && textAfter.startsWith('}')) {
            // Cursor is between }}, calculate relative position
            closeIndex = col - 1 - lastOpen - 2;
        }

        if (closeIndex === -1) {
            // No closing }} found - incomplete variable, still consider inside
            return {
                inside: true,
                varStart: lastOpen,
                varEnd: lineContent.length
            };
        }

        // Calculate absolute position of }} end
        const closeEnd = lastOpen + 2 + closeIndex + 2;

        return {
            inside: true,
            varStart: lastOpen,
            varEnd: closeEnd
        };
    }

    /**
     * GitHub Issue #180: Detect variable type at cursor for modifier insertion
     * Returns the data type of the variable the cursor is inside, or null
     */
    function getVariableTypeAtCursor() {
        if (!window.monacoEditor) return null;

        const model = window.monacoEditor.getModel();
        const position = window.monacoEditor.getPosition();
        if (!model || !position) return null;

        const lineContent = model.getLineContent(position.lineNumber);
        const col = position.column - 1;

        // Find the {{...}} containing the cursor
        const textBefore = lineContent.substring(0, col);
        const lastOpen = textBefore.lastIndexOf('{{');
        if (lastOpen === -1) return null;

        const afterOpen = lineContent.substring(lastOpen + 2);
        const closeIdx = afterOpen.indexOf('}}');
        if (closeIdx === -1) return null;

        const varContent = afterOpen.substring(0, closeIdx);

        // Parse type from variable content: NAME:type or :type or NAME:type|modifiers
        const colonIdx = varContent.indexOf(':');
        if (colonIdx === -1) return null;

        const afterFirstColon = varContent.substring(colonIdx + 1);
        // Type is up to the next : or | or end
        const typeMatch = afterFirstColon.match(/^(string|number|boolean|date|datetime)/i);
        if (typeMatch) return typeMatch[1].toLowerCase();

        return null;
    }

    /**
     * GitHub Issue #180: Get modifier items for a given data type
     */
    function getModifierItemsForType(dataType) {
        const universal = [
            { label: 'asString', detail: 'Output as JSON string' },
            { label: 'opt', detail: 'Omit key if empty' },
            { label: 'null', detail: 'null if empty' }
        ];
        switch (dataType) {
            case 'string':
                return [
                    { label: 'upper', detail: 'UPPERCASE' },
                    { label: 'lower', detail: 'lowercase' },
                    { label: 'noTrim', detail: 'Keep whitespace' },
                    { label: '3-50', detail: 'Length 3-50', prompt: true },
                    ...universal
                ];
            case 'number':
                return [
                    { label: 'rnd(2)', detail: 'Round to 2 decimals', prompt: true },
                    { label: 'int', detail: 'Integer only' },
                    { label: 'floor', detail: 'Round down' },
                    { label: 'ceil', detail: 'Round up' },
                    { label: '>0', detail: 'Positive', prompt: true },
                    { label: '>=0', detail: 'Non-negative', prompt: true },
                    ...universal
                ];
            case 'boolean':
                return universal;
            case 'date':
            case 'datetime':
                return [
                    { label: '+1d', detail: 'Add 1 day' },
                    { label: '-1d', detail: 'Subtract 1 day' },
                    { label: '+4h', detail: 'Add 4 hours' },
                    { label: '+30m', detail: 'Add 30 minutes' },
                    ...universal
                ];
            default:
                return universal;
        }
    }

    /**
     * GitHub Issue #180: Populate modifier dropdown menu based on detected variable type
     */
    function populateModifierDropdown() {
        const menu = document.getElementById('modifierDropdownMenu');
        if (!menu) return;

        const dataType = getVariableTypeAtCursor();
        const items = getModifierItemsForType(dataType);

        menu.innerHTML = '';
        items.forEach(item => {
            const btn = document.createElement('button');
            btn.className = 'toolbar-dropdown-item';
            btn.setAttribute('data-modifier', item.label);
            btn.textContent = `${item.label}  —  ${item.detail}`;
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                insertModifierAtCursor(item.label);
                document.getElementById('modifierDropdown')?.classList.remove('open');
            });
            menu.appendChild(btn);
        });
    }

    /**
     * GitHub Issue #180: Insert a modifier (|modifier) before the closing }} of the variable at cursor
     */
    function insertModifierAtCursor(modifier) {
        if (!window.monacoEditor) return;

        const model = window.monacoEditor.getModel();
        const position = window.monacoEditor.getPosition();
        if (!model || !position) return;

        const lineContent = model.getLineContent(position.lineNumber);
        const col = position.column - 1;

        // Find the {{...}} containing the cursor
        const textBefore = lineContent.substring(0, col);
        const lastOpen = textBefore.lastIndexOf('{{');
        if (lastOpen === -1) {
            showFooterNotification('warning', 'Place cursor inside a {{variable}}', { persistent: false });
            return;
        }

        const afterOpen = lineContent.substring(lastOpen + 2);
        const closeIdx = afterOpen.indexOf('}}');
        if (closeIdx === -1) {
            showFooterNotification('warning', 'Incomplete variable — missing }}', { persistent: false });
            return;
        }

        // Insert |modifier just before the }}
        const insertPos = lastOpen + 2 + closeIdx; // 0-indexed position of first }
        const insertCol = insertPos + 1; // 1-indexed for Monaco

        window.monacoEditor.executeEdits('insert-modifier', [{
            range: new monaco.Range(position.lineNumber, insertCol, position.lineNumber, insertCol),
            text: `|${modifier}`
        }]);

        // Position cursor after the inserted modifier
        window.monacoEditor.setPosition({
            lineNumber: position.lineNumber,
            column: insertCol + modifier.length + 1
        });

        window.monacoEditor.focus();
        window.TemplateCompletions.updateDecorations();
        updateToolbarButtonStates();
    }

    /**
     * Toggle {{}} at cursor position - simple insert/remove
     * Insert: adds {{}} at cursor and triggers autocomplete
     * Remove: removes the entire {{...}} variable (including all content)
     */
    function toggleInsertVariable() {
        if (!window.monacoEditor) return;

        const model = window.monacoEditor.getModel();
        const position = window.monacoEditor.getPosition();
        const varInfo = isCursorInsideVariable();

        if (varInfo.inside) {
            // We're inside {{...}} - remove the entire variable
            window.monacoEditor.executeEdits('remove-variable', [{
                range: new monaco.Range(position.lineNumber, varInfo.varStart + 1, position.lineNumber, varInfo.varEnd + 1),
                text: '' // Remove entirely
            }]);

            window.monacoEditor.setPosition({ lineNumber: position.lineNumber, column: varInfo.varStart + 1 });
            window.monacoEditor.trigger('keyboard', 'hideSuggestWidget', {});
            window.TemplateCompletions.updateDecorations();
            updateToolbarButtonStates(); // Update button text
            return;
        }

        // Not inside {{}} - insert it
        window.monacoEditor.executeEdits('insert-variable', [{
            range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
            text: '{{}}'
        }]);

        window.monacoEditor.setPosition({ lineNumber: position.lineNumber, column: position.column + 2 });
        window.monacoEditor.trigger('keyboard', 'editor.action.triggerSuggest', {});
        window.TemplateCompletions.updateDecorations();
        updateToolbarButtonStates(); // Update button text
    }

    /**
     * Apply specific variable type to current line
     * @param {string} type - 'input', 'env', or 'a8'
     */
    function applyLineVariable(type) {
        if (!window.monacoEditor) return;

        const model = window.monacoEditor.getModel();
        const position = window.monacoEditor.getPosition();
        const lineContent = model.getLineContent(position.lineNumber);

        // Parse JSON key-value pattern with optional trailing comment
        const match = lineContent.match(/^(\s*)"([^"]+)":\s*(.+?)(,?)(\s*)(\/\/(.*))?$/);
        if (!match) {
            showFooterNotification('warning', 'Place cursor on a key-value line', { persistent: false });
            return;
        }

        const [, indent, key, value, comma, whitespace, commentPart, commentValue] = match;
        const trimmedValue = value.trim();

        // Preserve existing comment or use current value
        let comment = '';
        if (commentValue !== undefined && commentValue.trim()) {
            comment = ` //${commentValue}`;
        } else if (!trimmedValue.includes('{{')) {
            comment = ` //${trimmedValue}`;
        }

        let newLine;
        let cursorColumn;

        switch (type) {
            case 'input':
                const inferredType = inferType(trimmedValue.includes('{{') ? 'string' : trimmedValue);
                const typeStr = inferredType || 'string';
                newLine = `${indent}"${key}": "{{${key}:${typeStr}}}"${comma}${comment}`;
                break;
            case 'env':
                newLine = `${indent}"${key}": "{{ENV:}}"${comma}${comment}`;
                cursorColumn = indent.length + key.length + 4 + 7 + 1;
                break;
            case 'a8':
                newLine = `${indent}"${key}": "{{A8:}}"${comma}${comment}`;
                cursorColumn = indent.length + key.length + 4 + 6 + 1;
                break;
            default:
                return;
        }

        window.monacoEditor.executeEdits('apply-line-variable', [{
            range: new monaco.Range(position.lineNumber, 1, position.lineNumber, lineContent.length + 1),
            text: newLine
        }]);

        // Position cursor and trigger autocomplete for env/a8
        if (cursorColumn) {
            window.monacoEditor.setPosition({ lineNumber: position.lineNumber, column: cursorColumn });
            window.monacoEditor.trigger('keyboard', 'editor.action.triggerSuggest', {});
        }

        window.TemplateCompletions.updateDecorations();
    }

    /**
     * Insert specific variable type at cursor position
     * @param {string} type - 'input', 'env', or 'a8'
     */
    function insertVariable(type) {
        if (!window.monacoEditor) return;

        const position = window.monacoEditor.getPosition();
        let textToInsert;
        let cursorOffset;

        switch (type) {
            case 'input':
                textToInsert = '{{}}';
                cursorOffset = 2;
                break;
            case 'env':
                textToInsert = '{{ENV:}}';
                cursorOffset = 6;
                break;
            case 'a8':
                textToInsert = '{{A8:}}';
                cursorOffset = 5;
                break;
            default:
                return;
        }

        window.monacoEditor.executeEdits('insert-variable', [{
            range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
            text: textToInsert
        }]);

        const cursorColumn = position.column + cursorOffset;
        window.monacoEditor.setPosition({ lineNumber: position.lineNumber, column: cursorColumn });
        window.monacoEditor.trigger('keyboard', 'editor.action.triggerSuggest', {});

        window.TemplateCompletions.updateDecorations();
    }

    // Keep convertToVariable as alias for backward compatibility
    function convertToVariable() {
        cycleLineVariable();
    }

    /**
     * Toggle BASE64 marker on key (toggle)
     * - If no :BASE64: converts "key": value to "key:BASE64": value
     * - If has :BASE64: converts "key:BASE64": value to "key": value
     */
    function encodeKey() {
        if (!window.monacoEditor) return;

        const model = window.monacoEditor.getModel();
        const position = window.monacoEditor.getPosition();
        const lineContent = model.getLineContent(position.lineNumber);

        // Parse JSON key-value pattern with optional comment: "key": value, //comment
        const match = lineContent.match(/^(\s*)"([^"]+)":\s*(.+?)(,?)(\s*)(\/\/(.*))?$/);
        if (!match) {
            showFooterNotification('warning', 'Place cursor on a key-value line', { persistent: false });
            return;
        }

        const [, indent, key, value, comma, whitespace, commentPart] = match;
        let newKey;

        // Toggle BASE64
        if (key.endsWith(':BASE64')) {
            // Remove :BASE64
            newKey = key.slice(0, -7);
        } else {
            // Add :BASE64
            newKey = `${key}:BASE64`;
        }

        // Preserve the comment if it exists
        const commentSuffix = commentPart ? ` ${commentPart}` : '';
        const newLine = `${indent}"${newKey}": ${value}${comma}${commentSuffix}`;

        window.monacoEditor.executeEdits('toggle-encode-key', [{
            range: new monaco.Range(position.lineNumber, 1, position.lineNumber, lineContent.length + 1),
            text: newLine
        }]);

        window.TemplateCompletions.updateDecorations();
    }

    /**
     * Update toolbar button states based on current cursor position
     * Line-specific buttons are enabled only on valid key-value lines
     */
    function updateToolbarButtonStates() {
        if (!window.monacoEditor) return;

        const model = window.monacoEditor.getModel();
        if (!model) return;

        const position = window.monacoEditor.getPosition();
        if (!position) return;

        // Check if multiple lines are selected (disable single-line operations)
        const selection = window.monacoEditor.getSelection();
        const isMultiLineSelection = selection && selection.startLineNumber !== selection.endLineNumber;

        const lineContent = model.getLineContent(position.lineNumber);

        // Check if line is commented
        const trimmed = lineContent.trimStart();
        const isCommented = trimmed.startsWith('//');

        // Update Comment button text
        const commentBtn = document.getElementById('commentBtn');
        if (commentBtn) {
            commentBtn.textContent = isCommented ? 'Uncomment' : 'Comment';
        }

        // Parse key-value pattern with optional comment (ignore commented lines for Variable/Encode)
        const match = lineContent.match(/^(\s*)"([^"]+)":\s*(.+?)(,?)(\s*)(\/\/(.*))?$/);
        const isKeyValueLine = !!match && !isCommented;

        // Check variable state for 4-way cycle (Value → Input → ENV → A8 → Value)
        const trimmedValue = match ? match[3].trim() : '';
        const isA8Variable = trimmedValue.includes('{{A8:');
        const isEnvVariable = trimmedValue.includes('{{ENV:') && !isA8Variable;
        const isInputVariable = trimmedValue.includes('{{') && !isEnvVariable && !isA8Variable;
        const hasCommentToRestore = match && match[7] !== undefined && match[7].trim();

        // Line Variable button: 4-way cycle - enabled for key-value lines
        // Disabled for A8 without comment (nothing to restore)
        const canCycleLineVariable = isKeyValueLine && !isMultiLineSelection &&
            (!isA8Variable || hasCommentToRestore);

        // Insert button: always enabled (can insert anywhere)
        const canInsertVariable = !isMultiLineSelection;

        // Update button states - separate Line Variable and Insert buttons
        const lineVariableBtn = document.getElementById('lineVariableBtn');
        const insertBtn = document.getElementById('insertBtn');
        const encodeBtn = document.getElementById('encodeBtn');

        if (lineVariableBtn) {
            lineVariableBtn.disabled = !canCycleLineVariable;
        }
        // Check cursor position once for Insert and Modifier buttons
        const varInfo = isCursorInsideVariable();

        if (insertBtn) {
            insertBtn.disabled = !canInsertVariable;
            insertBtn.textContent = varInfo.inside ? 'Remove Var' : 'Insert Var';
        }
        if (encodeBtn) {
            // Encode: disabled for multi-line selection (single-line operation only)
            encodeBtn.disabled = !isKeyValueLine || isMultiLineSelection;
        }

        // GitHub Issue #180: Modifier button - enabled only when cursor is inside a typed {{variable:type}}
        const modifierBtn = document.getElementById('modifierBtn');
        if (modifierBtn) {
            modifierBtn.disabled = !(varInfo.inside && getVariableTypeAtCursor() !== null);
        }

        // Update Format button state - disabled on single line or empty content
        const formatBtn = document.getElementById('formatJsonBtn');
        if (formatBtn) {
            const content = model.getValue();
            const lineCount = model.getLineCount();
            // Disable if single line (already compact) or empty
            formatBtn.disabled = lineCount <= 1 || !content.trim();
        }
    }

    /**
     * Setup toolbar button click handlers and keyboard shortcuts
     */
    function setupToolbarHandlers() {
        // Line Variable Dropdown - toggle open/close
        const variableDropdown = document.getElementById('variableDropdown');
        const lineVariableBtn = document.getElementById('lineVariableBtn');
        if (lineVariableBtn && variableDropdown) {
            lineVariableBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                variableDropdown.classList.toggle('open');
            });
        }

        // Dropdown menu items - Line Variable specific types
        const dropdownItems = document.querySelectorAll('.toolbar-dropdown-item');
        dropdownItems.forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const type = item.getAttribute('data-type');
                if (type && window.monacoEditor) {
                    window.monacoEditor.focus();
                    applyLineVariable(type);
                }
                // Close dropdown
                variableDropdown?.classList.remove('open');
            });
        });

        // GitHub Issue #180: Modifier Dropdown - toggle open/close with dynamic menu
        const modifierDropdown = document.getElementById('modifierDropdown');
        const modifierBtn = document.getElementById('modifierBtn');
        if (modifierBtn && modifierDropdown) {
            modifierBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                populateModifierDropdown();
                modifierDropdown.classList.toggle('open');
            });
        }

        // Close all dropdowns when clicking outside
        document.addEventListener('click', () => {
            variableDropdown?.classList.remove('open');
            modifierDropdown?.classList.remove('open');
        });

        // Insert button - simple toggle to insert/remove {{}}
        const insertBtn = document.getElementById('insertBtn');
        if (insertBtn) {
            insertBtn.addEventListener('click', () => {
                if (window.monacoEditor) {
                    window.monacoEditor.focus();
                    toggleInsertVariable();
                }
            });
        }

        // Comment button
        const commentBtn = document.getElementById('commentBtn');
        if (commentBtn) {
            commentBtn.addEventListener('click', () => {
                if (window.monacoEditor) {
                    window.monacoEditor.focus();
                    toggleLineComment();
                }
            });
        }

        // Encode button
        const encodeBtn = document.getElementById('encodeBtn');
        if (encodeBtn) {
            encodeBtn.addEventListener('click', () => {
                if (window.monacoEditor) {
                    window.monacoEditor.focus();
                    encodeKey();
                }
            });
        }

        // Delete line button
        const deleteLineBtn = document.getElementById('deleteLineBtn');
        if (deleteLineBtn) {
            deleteLineBtn.addEventListener('click', () => {
                if (window.monacoEditor) {
                    window.monacoEditor.focus();
                    deleteCurrentLine();
                }
            });
        }

        // Undo button
        const undoBtn = document.getElementById('undoBtn');
        if (undoBtn) {
            undoBtn.addEventListener('click', () => {
                if (window.monacoEditor) {
                    window.monacoEditor.focus();
                    window.monacoEditor.trigger('toolbar', 'undo', null);
                    canRedo = true;
                    updateUndoRedoButtons();
                }
            });
        }

        // Redo button
        const redoBtn = document.getElementById('redoBtn');
        if (redoBtn) {
            redoBtn.addEventListener('click', () => {
                if (window.monacoEditor) {
                    window.monacoEditor.focus();
                    window.monacoEditor.trigger('toolbar', 'redo', null);
                    updateUndoRedoButtons();
                }
            });
        }
    }

    /**
     * Update Undo/Redo button states based on editor history
     */
    function updateUndoRedoButtons() {
        if (!window.monacoEditor) return;

        const model = window.monacoEditor.getModel();
        if (!model) return;

        const undoBtn = document.getElementById('undoBtn');
        const redoBtn = document.getElementById('redoBtn');

        const currentVersion = model.getAlternativeVersionId();
        const canUndo = initialVersionId !== null && currentVersion !== initialVersionId;

        if (undoBtn) {
            undoBtn.disabled = !canUndo;
        }
        if (redoBtn) {
            redoBtn.disabled = !canRedo;
        }
    }

    /**
     * Register Monaco editor cursor position listener for toolbar state updates
     */
    function setupToolbarCursorListener() {
        if (!window.monacoEditor) return;

        const model = window.monacoEditor.getModel();

        // Track initial version for undo/redo
        if (model) {
            initialVersionId = model.getAlternativeVersionId();
        }

        window.monacoEditor.onDidChangeCursorPosition(() => {
            updateToolbarButtonStates();
        });

        // Also update on selection change (for multi-line selection detection)
        window.monacoEditor.onDidChangeCursorSelection(() => {
            updateToolbarButtonStates();
        });

        // Track content changes for undo/redo buttons
        window.monacoEditor.onDidChangeModelContent(() => {
            // New edit clears redo stack
            canRedo = false;
            updateUndoRedoButtons();
        });

        // Initial state update
        updateToolbarButtonStates();
        updateUndoRedoButtons();
    }

    // Unified Execution Status Constants
    // Matches UnifiedExecutionStatus enum from types/unified-execution-status.ts
    const EXECUTION_STATUS = {
        PENDING: 'pending',
        RUNNING: 'running',
        COMPLETED: 'completed',
        ERROR: 'error',
        CANCELLED: 'cancelled',
        WARNING: 'warning',
        SKIPPED: 'skipped',
        BLOCKED: 'blocked',
        PAUSED: 'paused'
    };
    let currentEndpointId = document.body.getAttribute('data-endpoint-id');

    /**
     * Issue #291: an endpoint is a draft until it has a persisted id. The Hub
     * mounts drafts with `new-<timestamp>` tab ids (see HubManager
     * openEndpointAsTab) and the manager stamps that into data-endpoint-id, so
     * the old `=== 'NEW'` check treated every Hub draft as a SAVED endpoint —
     * hiding Paste, enabling Copy to Share and skipping the Ctrl+V mapping.
     */
    function isDraftEndpointId(id) {
        return !id || id === '' || id === 'NEW' || id === 'new' || id === '{{ENDPOINT_ID}}' ||
            id.startsWith('new-') || id.startsWith('temp_');
    }
    let isNewEndpoint = isDraftEndpointId(currentEndpointId);
    let currentEndpointData = null; // Store the loaded endpoint data
    let currentEndpointFolder = document.getElementById('endpointFolder')?.value || ''; // Track folder internally even though not shown in UI

    let hasUnsavedChanges = false;

    // Helper function to get unsaved changes status from module or local state
    function getHasUnsavedChanges() {
        if (window.FormManager) {
            return window.FormManager.hasUnsavedChanges();
        }
        return hasUnsavedChanges;
    }
    let initialEndpointStateJSON = ''; // Store serialized initial state for object-based change detection
    // Set when populateEndpointFormData runs for a Duplicate (id-less endpoint).
    // resetChangeTracking honours this so the duplicate stays dirty across the
    // deferred Monaco-late-load reset. Cleared on save.
    let pendingDuplicateMarkDirty = false;

    function generateTemporaryId() {
        // Generate a temporary ID for new endpoints using timestamp and random number
        return 'temp_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    // ================================================
    // Footer Notification System
    // Shows errors/warnings inline in footer instead of VS Code messages
    // ================================================

    let activeNotificationTimeout = null;

    /**
     * Show a notification in the footer area
     * @param {string} type - 'error' | 'warning' | 'info'
     * @param {string} message - The message to display
     * @param {object} options - { persistent: false, shake: false }
     */
    // Delegates to the shared fixed-overlay DbmnToast (no content shift). Kept
    // as a wrapper so existing call sites are unchanged. `duration` → `durationMs`.
    function showFooterNotification(type, message, options = {}) {
        if (window.DbmnToast) {
            window.DbmnToast.show(type, message, {
                durationMs: options.duration,
                persistent: options.persistent,
                shake: options.shake,
                dismissible: options.dismissible
            });
            return;
        }
        // Fallback if DbmnToast somehow isn't loaded.
        vscode.postMessage({ type: type === 'error' ? 'showError' : type === 'warning' ? 'showWarning' : 'showInfo', message: message });
    }

    /**
     * Clear the footer notification
     */
    function clearFooterNotification() {
        const container = document.getElementById('footerNotification');
        if (container) {
            container.classList.add('hidden');
            container.classList.remove('notification-shake');
        }
        if (activeNotificationTimeout) {
            clearTimeout(activeNotificationTimeout);
            activeNotificationTimeout = null;
        }
    }

    // Expose to global scope for onclick handler
    window.clearFooterNotification = clearFooterNotification;

    window.addEventListener('load', () => {
        // Reset endpoint context based on template substitution
        if (isNewEndpoint) {
            // This is a new endpoint
            currentEndpointId = null; // Clear the template placeholder
            resetEndpointContext();
        }

        vscode.postMessage({ type: 'ready' });
        updateSectionVisibility();
        initTagChipInput();
        setupFormChangeTracking();
        setupTemplateVariableDetection();
        // Set initial button states
        updateButtonStates();
        // Set initial page heading
        updatePageHeading();

        setupMonacoEditor();
        // Drag and drop is now handled by data-transformer.js module
        setupButtonClickHandlers();

        // Footer button overflow into the existing More dropdown
        setupFooterOverflow();

        // Initialize contextual help icons
        if (window.initializeAllHelpIcons) {
            window.initializeAllHelpIcons();
        }

        // Issue #126: Request current environment data for inherited headers display
        vscode.postMessage({ type: 'getCurrentEnvironment' });

        // Note: Endpoint data loading is handled by the extension's initializeWebview()
        // method, which is triggered by the 'ready' message above
    });

    // Legacy drag and drop removed - now handled by data-transformer.js module

    // Handle messages from the extension
    window.addEventListener('message', event => {
        const message = event.data;

        switch (message.type) {
            case 'dbmnRenamed':
                // Renamed from the Hub's list while open here with nothing unsaved: the name follows, still saved
                if (!hasUnsavedChanges && typeof message.name === 'string') {
                    const field = document.getElementById('endpointName');
                    if (field) field.value = message.name;
                    if (currentEndpointData) currentEndpointData.name = message.name;
                    resetChangeTracking();
                }
                break;
            case 'endpointData':
                // Store the endpoint data globally
                currentEndpointData = message.endpoint;
                if (message.endpoint && message.endpoint.dataLoadingConfig) {
                    populateDataLoadingConfig(message.endpoint.dataLoadingConfig);
                }
                break;
            case 'populateEndpointData':
                handlePopulateEndpointData(message);
                break;
            case 'endpointDataError':
                break;
            case 'csvModalParsed':
            case 'csvCompatibilityVerified':
            case 'csvCompatibilityError':
            case 'fileDialogResult':
            case 'fileDialogError':
            case 'formatDetected':
            case 'formatConversionComplete':
            case 'formatConversionError':
                // Delegate CSV and format conversion message handling to CSV Handler module
                if (window.CSVHandler && window.CSVHandler.handleMessage) {
                    window.CSVHandler.handleMessage(message);
                } else {
                    console.error('CSVHandler not available for message:', message.type);
                }
                break;
            case 'jsonPreviewGenerated':
                // Skip - handled by CSV Handler module's message listener
                break;
            case 'currentEnvironmentData':
                handleCurrentEnvironmentData(message);
                break;
            case 'workspaceValidationResult':
                handleWorkspaceValidationResult(message);
                break;
            // GitHub Issue #164: Handle pasted endpoint data from clipboard
            case 'pastedEndpointData':
                handlePastedEndpointData(message.endpoint);
                break;
            // Issue #291: user chose "Paste as text" (or the text didn't parse)
            case 'insertPastedText':
                insertPastedTextRaw(message.text);
                break;
            // GitHub Issue #188: Handle confirmed pasted headers from backend modal
            case 'addPastedHeaders':
                if (message.headers && Array.isArray(message.headers)) {
                    for (const header of message.headers) {
                        addCustomHeader(header.key, header.value, header.enabled);
                    }
                    updateSectionVisibility();
                    hasUnsavedChanges = true;
                    updateButtonStates();
                    updateTitle();
                    showFooterNotification('info', message.headers.length + ' header' + (message.headers.length > 1 ? 's' : '') + ' added to endpoint', { persistent: false });
                }
                break;
            // GitHub Issue #165: Handle ENV variables added response
            case 'envVariablesAdded':
                handleEnvVariablesAdded(message);
                break;
            case 'environmentDataUpdated':
                // Environment was updated (e.g., variables added), refresh our local copy
                if (message.environment) {
                    window.currentActiveEnvironment = message.environment;
                    // Re-validate template decorations now that ENV variables are available
                    window.TemplateCompletions.updateDecorations();
                }
                break;
            // GitHub Issue #230: Create Template response handlers
            case 'templateSaveComplete':
                showFooterNotification('info', 'Template saved: ' + message.fileName, { persistent: false });
                break;
            case 'templateError':
                showFooterNotification('error', message.error, { persistent: false });
                break;
            // Note: Dead handler functions have been removed as they were not being called
            // Add other message handlers here as needed
        }
    });

    /**
     * GitHub Issue #165: Handle response after ENV variables are added
     */
    function handleEnvVariablesAdded(message) {
        if (message.success) {
            // Update our local copy of environment variables
            if (message.environment) {
                window.currentActiveEnvironment = message.environment;
                // Re-validate template decorations now that new ENV variables are available
                window.TemplateCompletions.updateDecorations();
            }
            // Show success notification
            showFooterNotification('info', `Added ${message.addedCount} environment variable(s)`, { persistent: false });
            // Now proceed with opening Run Batch webview
            if (message.proceedWithBatch && currentEndpointId) {
                vscode.postMessage({
                    type: 'openRunBatchWebview',
                    endpointId: currentEndpointId
                });
            }
        } else {
            showFooterNotification('warning', message.error || 'Failed to add environment variables', { persistent: false });
        }
    }


    function resetEndpointContext() {
        // Clear form for new endpoint
        document.getElementById('endpointName').value = '';
        document.getElementById('endpointPath').value = '';
        document.getElementById('endpointDescription').value = '';
        if (window.monacoEditor) {
            window.monacoEditor.setValue('');
        }
        document.getElementById('endpointMethod').value = 'GET';

        // Clear dynamic headers and query params
        const headersContainer = document.getElementById('headersContainer');
        if (headersContainer) headersContainer.innerHTML = '';

        const queryParamsContainer = document.getElementById('queryParamsContainer');
        if (queryParamsContainer) queryParamsContainer.innerHTML = '';

        // Clear test scripts
        const testScriptsContainer = document.getElementById('testScriptsContainer');
        if (testScriptsContainer) testScriptsContainer.innerHTML = '';

        isNewEndpoint = true;

        // GitHub Issue #164: Update Paste/More menu visibility for new endpoints
        updateMoreActionsVisibility();
    }

    function handlePopulateEndpointData(message) {
        // Store the entire endpoint data globally
        currentEndpointData = message.endpoint;

        if (message.body !== undefined) {
            // Use bodyWithComments for editor display, fallback to body for legacy endpoints
            const editorContent = message.endpoint?.bodyWithComments || message.endpoint?.body || message.body;

            if (window.monacoEditor) {
                window.monacoEditor.setValue(editorContent);

                // Reset change tracking after setting the body
                resetChangeTracking();
            } else {
                // Store the body to set later when Monaco Editor is ready
                window.pendingEndpointBody = editorContent;
            }
        }

        // Handle other endpoint data population if needed
        if (message.endpoint && message.endpoint.dataLoadingConfig) {
            populateDataLoadingConfig(message.endpoint.dataLoadingConfig);
        }

    }

    function setupFormChangeTracking() {
        // For new endpoints, capture state immediately
        // For existing endpoints, loadEndpointData will call resetChangeTracking when done
        if (isNewEndpoint) {
            resetChangeTracking();
        }

        // Add change listeners to form fields (Monaco Editor handled separately)
        const formFields = ['endpointName', 'endpointPath', 'endpointDescription', 'singleTestScript'];
        formFields.forEach(fieldId => {
            const field = document.getElementById(fieldId);
            if (field) {
                field.addEventListener('input', () => {
                    checkForChanges();
                    updateTitle();

                    // Update page heading when endpoint name changes
                    if (fieldId === 'endpointName') {
                        updatePageHeading();
                    }

                    // Clear test preview results when test script changes
                    if (fieldId === 'singleTestScript') {
                        clearTestPreviewResults();
                    }
                });
            }
        });

        // Add listener for method changes to update page heading
        const methodSelect = document.getElementById('endpointMethod');
        if (methodSelect) {
            methodSelect.addEventListener('change', () => {
                updatePageHeading();
            });
        }

        // Setup data loading configuration event listeners
        setupDataLoadingEventListeners();

        // Note: endpointMethod change tracking is handled by toggleBodyTab() function
    }

    // Template Variable Detection Functions
    function setupTemplateVariableDetection() {
        // Set up real-time template variable detection for relevant fields
        const fieldsToWatch = [
            { id: 'endpointPath', indicator: 'urlTemplateIndicator' },
            // Query params and headers are handled dynamically
        ];

        fieldsToWatch.forEach(field => {
            const element = document.getElementById(field.id);
            if (element) {
                // Initial detection
                updateTemplateIndicator(field.id, field.indicator);

                // Real-time detection on input
                element.addEventListener('input', () => {
                    updateTemplateIndicator(field.id, field.indicator);
                });
            }
        });

        // Watch for Monaco editor changes (body template variables)
        if (window.monaco && window.monacoEditor) {
            window.monacoEditor.onDidChangeModelContent(() => {
                updateBodyTemplateIndicators();
            });
        }

        // Watch for dynamic query params and headers
        observeDynamicFields();
    }

    function updateTemplateIndicator(fieldId, indicatorId) {
        const field = document.getElementById(fieldId);
        const indicator = document.getElementById(indicatorId);

        if (!field || !indicator) return;

        const value = field.value || '';
        const variables = extractTemplateVariables(value);

        if (variables.length > 0) {
            field.classList.add('has-template-variables');
            indicator.classList.remove('hidden');
            indicator.classList.add('visible');
            indicator.title = `Contains ${variables.length} template variable${variables.length > 1 ? 's' : ''}: ${variables.join(', ')}`;
        } else {
            field.classList.remove('has-template-variables');
            indicator.classList.add('hidden');
            indicator.classList.remove('visible');
        }
    }

    function updateBodyTemplateIndicators() {
        if (!window.monacoEditor) return;

        const bodyContent = window.monacoEditor.getValue() || '';
        const variables = extractTemplateVariables(bodyContent);

        // Update any body template indicators if they exist
        const bodyIndicator = document.getElementById('bodyTemplateIndicator');
        if (bodyIndicator) {
            if (variables.length > 0) {
                bodyIndicator.classList.remove('hidden');
                bodyIndicator.classList.add('visible');
                bodyIndicator.title = `Body contains ${variables.length} template variable${variables.length > 1 ? 's' : ''}: ${variables.join(', ')}`;
            } else {
                bodyIndicator.classList.add('hidden');
                bodyIndicator.classList.remove('visible');
            }
        }
    }

    function extractTemplateVariables(text) {
        if (!text) return [];

        const variables = [];
        const regex = /\{\{([^}]+)\}\}/g;
        let match;

        while ((match = regex.exec(text)) !== null) {
            const variable = match[1].trim();
            // Extract variable name (before : if type is specified)
            const variableName = variable.split(':')[0].trim();

            // Skip auto-generated variables and loop syntax.
            // GitHub Issue #257: test the FULL variable for A8:/V8: prefixes —
            // splitting on ':' first turns `{{A8:PAGE:0}}` into "A8", which
            // never matched `startsWith('A8:')` and was wrongly counted as a
            // user variable (making pagination-only endpoints show "Run Batch").
            if (!variable.startsWith('A8:') &&
                !variable.startsWith('V8:') &&
                !variableName.startsWith('#') &&
                !variableName.startsWith('/') &&
                !variables.includes(variableName)) {
                variables.push(variableName);
            }
        }

        return variables;
    }

    function observeDynamicFields() {
        // Watch for changes in query params and headers containers
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.type === 'childList') {
                    // Check if query params or headers were added/removed
                    updateDynamicFieldIndicators();
                }
            });
        });

        // Observe query params container
        const queryParamsContainer = document.getElementById('queryParamsContainer');
        if (queryParamsContainer) {
            observer.observe(queryParamsContainer, { childList: true, subtree: true });
        }

        // Observe headers container
        const headersContainer = document.getElementById('headersContainer');
        if (headersContainer) {
            observer.observe(headersContainer, { childList: true, subtree: true });
            // A header kept on the endpoint (added, loaded or pasted): recommend the environment's
            new MutationObserver(updateEndpointHeadersWarning).observe(headersContainer, { childList: true });
            updateEndpointHeadersWarning();
        }
    }

    /**
     * The DBMN way is headers on the environment (added to every request). While this endpoint
     * has a header row of its own, say so, with a link to the docs. Inherited (environment)
     * rows don't count.
     */
    function updateEndpointHeadersWarning() {
        const warning = document.getElementById('endpointHeadersWarning');
        if (!warning) return;
        const own = document.querySelectorAll('#headersContainer .header-row:not(.inherited)').length;
        warning.classList.toggle('hidden', own === 0);
    }

    function updateDynamicFieldIndicators() {
        // Update indicators for query params
        const queryParamRows = document.querySelectorAll('#queryParamsContainer .param-row');
        queryParamRows.forEach((row, index) => {
            const valueInput = row.querySelector('.param-value, [data-field="value"]');
            if (valueInput) {
                const indicatorId = `queryParamIndicator_${index}`;
                let indicator = document.getElementById(indicatorId);

                if (!indicator) {
                    // Create indicator if it doesn't exist
                    indicator = document.createElement('span');
                    indicator.id = indicatorId;
                    indicator.className = 'template-indicator hidden';
                    indicator.innerHTML = '🔗';

                    // Insert indicator after input
                    const wrapper = valueInput.parentElement;
                    if (wrapper && !wrapper.classList.contains('position-relative')) {
                        wrapper.classList.add('position-relative');
                        wrapper.appendChild(indicator);
                    }
                }

                const variables = extractTemplateVariables(valueInput.value || '');
                if (variables.length > 0) {
                    valueInput.classList.add('has-template-variables');
                    indicator.classList.remove('hidden');
                    indicator.classList.add('visible');
                    indicator.title = `Contains ${variables.length} template variable${variables.length > 1 ? 's' : ''}: ${variables.join(', ')}`;
                } else {
                    valueInput.classList.remove('has-template-variables');
                    indicator.classList.add('hidden');
                    indicator.classList.remove('visible');
                }
            }
        });

        // Update indicators for headers
        const headerRows = document.querySelectorAll('#headersContainer .header-row:not(.inherited)');
        headerRows.forEach((row, index) => {
            const valueInput = row.querySelector('.header-value, [data-field="value"]');
            if (valueInput) {
                const indicatorId = `headerIndicator_${index}`;
                let indicator = document.getElementById(indicatorId);

                if (!indicator) {
                    // Create indicator if it doesn't exist
                    indicator = document.createElement('span');
                    indicator.id = indicatorId;
                    indicator.className = 'template-indicator hidden';
                    indicator.innerHTML = '🔗';

                    // Insert indicator after input
                    const wrapper = valueInput.parentElement;
                    if (wrapper && !wrapper.classList.contains('position-relative')) {
                        wrapper.classList.add('position-relative');
                        wrapper.appendChild(indicator);
                    }
                }

                const variables = extractTemplateVariables(valueInput.value || '');
                if (variables.length > 0) {
                    valueInput.classList.add('has-template-variables');
                    indicator.classList.remove('hidden');
                    indicator.classList.add('visible');
                    indicator.title = `Contains ${variables.length} template variable${variables.length > 1 ? 's' : ''}: ${variables.join(', ')}`;
                } else {
                    valueInput.classList.remove('has-template-variables');
                    indicator.classList.add('hidden');
                    indicator.classList.remove('visible');
                }
            }
        });
    }

    function captureInitialFormState() {
        try {
            // Capture complete endpoint object state for comprehensive change detection
            const currentEndpointState = collectCurrentEndpointData();
            initialEndpointStateJSON = JSON.stringify(currentEndpointState);
        } catch (error) {
            // If collection fails, set empty state to prevent false positives
            initialEndpointStateJSON = '';
        }
    }

    function checkForChanges() {
        try {
            // Object-based change detection: compare complete endpoint objects
            const currentEndpointState = collectCurrentEndpointData();
            const initialEndpointState = initialEndpointStateJSON ? JSON.parse(initialEndpointStateJSON) : {};

            const currentStateJSON = JSON.stringify(currentEndpointState);
            const initialStateJSONForComparison = JSON.stringify(initialEndpointState);

            hasUnsavedChanges = (currentStateJSON !== initialStateJSONForComparison);

        } catch (error) {
            // If collection fails, assume no changes to prevent false alarms
            hasUnsavedChanges = false;
        }

        // Update button states after checking for changes
        updateButtonStates();
    }

    function updateTitle() {
        const headingText = document.getElementById('headingText');
        if (headingText) {
            const baseTitle = isNewEndpoint ? 'Create New Endpoint:' : 'Edit Endpoint:';
            headingText.textContent = hasUnsavedChanges ? baseTitle + ' *' : baseTitle;
        }
        updateNewEndpointStart();
    }

    function updatePageHeading() {
        const pageHeading = document.getElementById('pageHeading');
        const methodSelect = document.getElementById('endpointMethod');
        const nameInput = document.getElementById('endpointName');

        if (pageHeading && methodSelect && nameInput) {
            const method = methodSelect.value;
            const name = nameInput.value.trim() || 'Untitled Endpoint';
            pageHeading.textContent = `${method}: ${name}`;
        }
        updateNewEndpointStart();
    }

    /**
     * Issue #291: a pristine draft shows the "New Endpoint" start strip (with
     * the Paste Endpoint call-to-action) IN PLACE of the "GET: Untitled
     * Endpoint" heading. The moment the form is touched — typed into, pasted
     * into, or saved — the ordinary heading takes over.
     */
    function updateNewEndpointStart() {
        const strip = document.getElementById('newEndpointStart');
        const pageHeading = document.getElementById('pageHeading');
        if (!strip || !pageHeading) return;
        const pristineDraft = isNewEndpoint && !hasUnsavedChanges;
        strip.classList.toggle('hidden', !pristineDraft);
        pageHeading.classList.toggle('hidden', pristineDraft);
    }


    // Two-button model: Run API is always present; Run Batch appears when the
    // endpoint has template variables. Users with variables get to choose
    // between typing values into the DBMN modal (Run API) or uploading a CSV
    // (Run Batch) — previously the batch flow was forced, making single-shot
    // parameterised runs unreachable.
    function updateButtonStates() {
        var saveBtn = document.getElementById('save-endpoint-btn');
        var runApiBtn = document.getElementById('run-api-btn');
        var runBatchBtn = document.getElementById('run-batch-btn');

        if (saveBtn) {
            saveBtn.disabled = !hasUnsavedChanges;
        }
        // The footer's few words (dbmn-status): saved, or not yet
        // (nothing until the endpoint is loaded and its changes are tracked: "Saved" before then would be a guess)
        var status = document.getElementById('endpointStatus');
        if (status) {
            var tracking = !!initialEndpointStateJSON;
            status.textContent = !tracking ? '' : hasUnsavedChanges ? 'Not saved yet' : isNewEndpoint ? 'New: not saved yet' : 'Saved';
            if (tracking) status.setAttribute('tone', hasUnsavedChanges || isNewEndpoint ? 'warn' : 'ok'); else status.removeAttribute('tone');
        }

        var hasVars = getTemplateVariableCount() > 0;
        var savedNote = hasUnsavedChanges ? 'Save your changes before running' : null;

        if (runApiBtn) {
            runApiBtn.disabled = hasUnsavedChanges;
            runApiBtn.title = savedNote || (hasVars
                ? 'Execute API — you fill in the template values in a modal'
                : 'Execute API endpoint');
        }

        if (runBatchBtn) {
            runBatchBtn.disabled = hasUnsavedChanges;
            runBatchBtn.classList.toggle('hidden', !hasVars);
            runBatchBtn.title = savedNote || 'Execute in batch — drive the endpoint from a CSV';
        }

        // GitHub Issue #230: Update Download Template visibility
        updateCreateTemplateVisibility();

        // GitHub Issue #164: Update Paste/Copy/Duplicate visibility
        updateMoreActionsVisibility();
    }

    // GitHub Issue #232: Count template variables across all sources
    // GitHub Issue #255: Strip JSON comments from the body so commented-out
    //   placeholders (e.g. `// "Query": "{{SKU}}"`) do NOT count as batch vars.
    // GitHub Issue #257: Use the correct rendered input classes
    //   (.query-param-value / .header-value) so query-param and header
    //   placeholders are actually counted and enable "Run Batch".
    function getTemplateVariableCount() {
        var allText = '';
        if (window.monacoEditor) {
            var bodyText = window.monacoEditor.getValue();
            var cleanBody = window.stripJsonComments ? window.stripJsonComments(bodyText) : bodyText;
            allText += cleanBody + ' ';
        }
        var pathInput = document.getElementById('endpointPath');
        if (pathInput) { allText += pathInput.value + ' '; }
        document.querySelectorAll('#queryParamsContainer .param-row .query-param-value').forEach(function(input) {
            allText += input.value + ' ';
        });
        document.querySelectorAll('#headersContainer .header-row:not(.inherited) .header-value').forEach(function(input) {
            allText += input.value + ' ';
        });
        return extractTemplateVariables(allText).length;
    }

    // GitHub Issue #230: Show/hide Download Template item in More menu based on template variables
    // GitHub Issue #241: Item is always clickable when shown — the click handler surfaces a
    // footer notification when unsaved/new. Previously `disabled-item` set `pointer-events: none`,
    // swallowing the click silently and making the button look broken.
    function updateCreateTemplateVisibility() {
        var btn = document.getElementById('downloadTemplateBtn');
        if (!btn) { return; }

        var hasVars = getTemplateVariableCount() > 0;
        if (hasVars) {
            btn.classList.remove('hidden');
        } else {
            btn.classList.add('hidden');
        }

        // Visible-button set just changed; re-evaluate footer overflow.
        if (window._footerOverflowAdjust) {
            requestAnimationFrame(window._footerOverflowAdjust);
        }
    }

    function resetChangeTracking() {
        captureInitialFormState();
        hasUnsavedChanges = pendingDuplicateMarkDirty;
        updateTitle();
        updateButtonStates();
    }

    /**
     * The form fields the user typed into before Monaco was ready, by their key in
     * collectCurrentEndpointData. Programmatic fills (the System list arriving, the body) don't count.
     */
    const TYPED_FIELDS = { endpointName: 'name', endpointPath: 'path', endpointMethod: 'method', endpointDescription: 'description' };
    const typedBeforeEditorReady = new Set();
    ['input', 'change'].forEach(type => document.addEventListener(type, event => {
        const key = event.isTrusted && event.target && TYPED_FIELDS[event.target.id];
        if (key && !window.monacoEditor) typedBeforeEditorReady.add(key);
    }, true));

    /** The starting point taken again now the editor is ready, keeping what the user typed as a change. */
    function rebaseExceptTyped() {
        let before = {};
        try { before = initialEndpointStateJSON ? JSON.parse(initialEndpointStateJSON) : {}; } catch (_e) { before = {}; }
        const baseline = collectCurrentEndpointData();
        typedBeforeEditorReady.forEach(key => { baseline[key] = before[key]; });
        typedBeforeEditorReady.clear();
        initialEndpointStateJSON = JSON.stringify(baseline);
        checkForChanges();
        updateTitle();
    }

    function loadEndpointData() {
        // Load headers and query params for existing endpoint
        // This is handled by the template substitution, but we need to add listeners
        // to any pre-loaded headers/params

        // Add listeners to any existing headers/params that were loaded
        document.querySelectorAll('#headersContainer .header-row:not(.inherited) input').forEach(input => {
            input.addEventListener('input', () => {
                checkForChanges();
                updateTitle();
            });
            input.addEventListener('change', () => {
                checkForChanges();
                updateTitle();
            });
        });



        document.querySelectorAll('#queryParamsContainer .param-row input').forEach(input => {
            input.addEventListener('input', () => {
                checkForChanges();
                updateTitle();
            });
        });

        // Add listeners to any existing test scripts that were loaded
        document.querySelectorAll('#testScriptsContainer .test-script-row input, #testScriptsContainer .test-script-row textarea').forEach(element => {
            element.addEventListener('input', () => {
                checkForChanges();
                updateTitle();
            });
        });

        // Load data loading configuration for existing endpoints
        if (!isNewEndpoint && currentEndpointId) {
            loadDataLoadingConfiguration();
        }

        resetChangeTracking();
    }

    function loadDataLoadingConfiguration() {
        // Request the full endpoint data including data loading config
        vscode.postMessage({
            type: 'getEndpointData',
            endpointId: currentEndpointId
        });
    }

    function populateDataLoadingConfig(dataLoadingConfig) {
        if (!dataLoadingConfig) {
            return; // No saved config, use defaults
        }

        try {
            // Restore error handling mode
            const errorMode = dataLoadingConfig.errorHandling?.mode || 'stopOnFirst';
            const errorModeRadio = document.querySelector(`input[name="errorMode"][value="${errorMode}"]`);
            if (errorModeRadio) {
                errorModeRadio.checked = true;

                // Show/hide continue options based on mode
                const continueOptions = document.getElementById('continueOptions');
                if (continueOptions) {
                    continueOptions.style.display = errorMode === 'continue' ? 'block' : 'none';
                }
            }

            // Restore error tolerance settings
            if (errorMode === 'continue' && dataLoadingConfig.errorHandling) {
                const enableErrorTolerance = dataLoadingConfig.errorHandling.enableErrorTolerance || false;
                const enableToleranceCheckbox = document.getElementById('enableErrorTolerance');
                if (enableToleranceCheckbox) {
                    enableToleranceCheckbox.checked = enableErrorTolerance;

                    // Show/hide tolerance container
                    const toleranceContainer = document.getElementById('errorToleranceContainer');
                    if (toleranceContainer) {
                        toleranceContainer.style.display = enableErrorTolerance ? 'block' : 'none';
                    }
                }

                // Restore tolerance mode
                const toleranceMode = dataLoadingConfig.errorHandling.toleranceMode || 'absolute';
                const toleranceModeRadio = document.querySelector(`input[name="toleranceMode"][value="${toleranceMode}"]`);
                if (toleranceModeRadio) {
                    toleranceModeRadio.checked = true;

                    // Show/hide tolerance input containers
                    const absoluteContainer = document.getElementById('absoluteModeContainer');
                    const percentageContainer = document.getElementById('percentageModeContainer');
                    if (absoluteContainer) {
                        absoluteContainer.style.display = toleranceMode === 'absolute' ? 'block' : 'none';
                    }
                    if (percentageContainer) {
                        percentageContainer.style.display = toleranceMode === 'percentage' ? 'block' : 'none';
                    }
                }

                // Restore tolerance limits (using schema-defined fields)
                const absoluteErrorLimit = document.getElementById('absoluteErrorLimit');
                const savedAbsoluteLimit = dataLoadingConfig.errorHandling.absoluteErrorLimit;
                if (absoluteErrorLimit && savedAbsoluteLimit !== undefined) {
                    absoluteErrorLimit.value = savedAbsoluteLimit;
                }

                const percentageErrorLimit = document.getElementById('percentageErrorLimit');
                const savedPercentageLimit = dataLoadingConfig.errorHandling.percentageErrorLimit;
                if (percentageErrorLimit && savedPercentageLimit !== undefined) {
                    percentageErrorLimit.value = savedPercentageLimit;
                }

                // Restore retry settings
                const savedRetryAttempts = dataLoadingConfig.errorHandling.retryConfig?.maxAttempts;
                const savedRetryDelay = dataLoadingConfig.errorHandling.retryConfig?.delaySeconds;

                const retryAttempts = document.getElementById('retryAttempts');
                if (retryAttempts && savedRetryAttempts !== undefined) {
                    retryAttempts.value = savedRetryAttempts;
                }

                const retryDelay = document.getElementById('retryDelay');
                if (retryDelay && savedRetryDelay !== undefined) {
                    retryDelay.value = savedRetryDelay;
                }
            }

            // Restore data validation settings
            const enforceDataTypes = document.getElementById('enforceDataTypes');
            if (enforceDataTypes && dataLoadingConfig.dataValidation) {
                enforceDataTypes.checked = dataLoadingConfig.dataValidation.enforceDataTypes || false;
            }

            // Store array repetition settings for later restoration when UI is created
            if (dataLoadingConfig.repeatableArrays && dataLoadingConfig.repeatableArrays.length > 0) {
                window.savedArrayRepetitionData = dataLoadingConfig.repeatableArrays;
            } else {
                window.savedArrayRepetitionData = null;
            }

        } catch (error) {
        }
    }

    /**
     * Collect current endpoint data from all form fields
     * Used by both saveEndpoint and change detection
     */
    function collectCurrentEndpointData() {
        const tempOrRealId = isNewEndpoint ? generateTemporaryId() : currentEndpointId;

        // Get the current body content from editor
        const bodyWithComments = window.monacoEditor ? window.monacoEditor.getValue().trim() : '';

        // Strip comments for the clean body version
        const cleanBody = window.stripJsonCommentsSafe ?
            window.stripJsonCommentsSafe(bodyWithComments) : bodyWithComments;

        const selectedSystemId = endpointSystemPicker
            ? endpointSystemPicker.getSelected()
            : undefined;

        const basicData = {
            id: tempOrRealId,
            name: document.getElementById('endpointName').value.trim(),
            path: document.getElementById('endpointPath').value.trim(),
            method: document.getElementById('endpointMethod').value,
            description: document.getElementById('endpointDescription').value.trim(),
            folder: currentEndpointFolder || undefined,
            systemId: selectedSystemId,
            tags: getTagChipValues(),
            body: cleanBody,
            bodyWithComments: bodyWithComments
        };

        const headers = collectAllHeaders(); // Include both custom and JWT headers
        const queryParams = collectQueryParams();
        const dataLoadingConfig = collectDataLoadingConfig();

        // Issue #126: useEnvironmentHeaders toggle
        const useEnvironmentHeaders = document.getElementById('useEnvironmentHeaders')?.checked !== false;

        return {
            ...basicData,
            headers: headers,
            queryParams: queryParams,
            dataLoadingConfig: dataLoadingConfig,
            useEnvironmentHeaders: useEnvironmentHeaders
        };
    }

    /**
     * Collect all template variable errors from the body
     * @returns {Array} Array of error objects { variable, error, isWarning }
     */
    function collectTemplateErrors() {
        if (!window.monacoEditor) return [];

        const text = window.monacoEditor.getValue();
        if (!text.trim()) return [];

        const errors = [];
        const regex = /\{\{([^}]*)\}\}/g;
        let match;

        while ((match = regex.exec(text)) !== null) {
            const innerContent = match[1];
            const validation = window.TemplateCompletions.validate(innerContent);

            if (!validation.valid) {
                errors.push({
                    variable: match[0],
                    error: validation.error,
                    isWarning: validation.isWarning || false,
                    isBlocking: validation.isBlocking || false
                });
            }
        }

        return errors;
    }

    /**
     * GitHub Issue #165: Extract all ENV variables used in the template
     * @returns {Array} Array of ENV variable names used in template
     */
    function extractEnvVariablesFromTemplate() {
        if (!window.monacoEditor) return [];

        const text = window.monacoEditor.getValue();
        if (!text.trim()) return [];

        const envVars = [];
        const regex = /\{\{ENV:([^}:]+)\}\}/gi;
        let match;

        while ((match = regex.exec(text)) !== null) {
            const varName = match[1].trim();
            if (varName && !envVars.includes(varName)) {
                envVars.push(varName);
            }
        }

        return envVars;
    }

    /**
     * GitHub Issue #165: Check if all ENV variables in template exist in current environment
     * @returns {Object} { valid: boolean, missing: string[], empty: string[] }
     * - missing: variables that don't exist in environment (need to be added)
     * - empty: variables that exist but have no value (need value to be set)
     */
    function validateEnvVariables() {
        const templateEnvVars = extractEnvVariablesFromTemplate();
        if (templateEnvVars.length === 0) {
            return { valid: true, missing: [], empty: [] };
        }

        const currentEnvVars = window.currentActiveEnvironment?.variables || {};

        // Separate truly missing (not in object) from empty (in object but no value)
        const missing = [];
        const empty = [];

        for (const varName of templateEnvVars) {
            if (!(varName in currentEnvVars)) {
                // Variable doesn't exist at all
                missing.push(varName);
            } else if (!currentEnvVars[varName] || currentEnvVars[varName].trim() === '') {
                // Variable exists but has empty value
                empty.push(varName);
            }
        }

        return {
            valid: missing.length === 0 && empty.length === 0,
            missing: missing,
            empty: empty,
            found: templateEnvVars.filter(varName => currentEnvVars[varName] && currentEnvVars[varName].trim() !== '')
        };
    }

    function saveEndpoint() {
        // Helper: notify + post a save-failed signal so the extension host's
        // saveCurrentContext() resolves immediately (rather than waiting out
        // the 5s timeout) and the swap-to-another-endpoint flow can react.
        // The footer error stays in the editor where the user can see + fix
        // it; the swap aborts cleanly.
        function failSave(message) {
            showFooterNotification('error', message, { shake: true });
            vscode.postMessage({ type: 'saveEndpointError', reason: message });
        }

        try {
            // Clear any existing notifications
            clearFooterNotification();

            // Check JSON syntax FIRST - before formatting (which would remove duplicate keys)
            const bodyText = window.monacoEditor ? window.monacoEditor.getValue() : '';
            if (bodyText.trim()) {
                const jsonValidation = validateJSONSyntax(bodyText);
                if (!jsonValidation.isValid) {
                    failSave(`JSON Error: ${jsonValidation.error}`);
                    return;
                }
            }

            // Format JSON template (only after validation passes)
            formatJsonTemplate();

            const endpointData = collectCurrentEndpointData();

            // Basic validation - use footer notifications
            if (!endpointData.name) {
                failSave('Please enter an endpoint name');
                return;
            }

            if (!endpointData.path) {
                failSave('Please enter an endpoint path');
                return;
            }

            if (!endpointData.path.startsWith('/')) {
                failSave('Endpoint path must start with /');
                return;
            }

            // Check template errors - WARNING allows save but notifies user
            const templateErrors = collectTemplateErrors();

            // GitHub Issue #245: blocking errors (e.g. invalid A8:PAGE/A8:SIZE) prevent saving.
            const blockingErrors = templateErrors.filter(e => e.isBlocking);
            if (blockingErrors.length > 0) {
                failSave(blockingErrors.length === 1
                    ? blockingErrors[0].error
                    : `${blockingErrors.length} template errors must be fixed before saving`);
                return;
            }

            const hardErrors = templateErrors.filter(e => !e.isWarning && !e.isBlocking);
            const warnings = templateErrors.filter(e => e.isWarning);

            if (hardErrors.length > 0) {
                // Template errors are warnings - inform but don't block
                const errorMsg = hardErrors.length === 1
                    ? `Template warning: ${hardErrors[0].error}`
                    : `${hardErrors.length} template warnings found`;
                showFooterNotification('warning', errorMsg, { persistent: false });
            } else if (warnings.length > 0) {
                const warnMsg = warnings.length === 1
                    ? `Template: ${warnings[0].error}`
                    : `${warnings.length} template warnings`;
                showFooterNotification('warning', warnMsg, { persistent: false });
            }

            // Proceed with save
            vscode.postMessage({ type: 'saveEndpoint', endpoint: endpointData });

        } catch (error) {
            failSave('Error saving endpoint: ' + error.message);
        }
    }

    // GitHub Issue #98: Delete endpoint functionality
    function deleteEndpoint() {
        if (!currentEndpointId) {
            vscode.postMessage({ type: 'showWarning', message: 'Cannot delete - no endpoint loaded' });
            return;
        }

        // Request transaction count before showing confirmation
        vscode.postMessage({
            type: 'checkEndpointTransactions',
            endpointId: currentEndpointId
        });
    }

    // Two-click arm-and-confirm wrapper for the direct Delete button.
    // Mirrors the pattern in console.html deleteViewFromEditor (line ~999):
    // first click swaps the label to "Click again to confirm" with a red bg;
    // second click within 4s fires the real delete (which still goes through
    // the existing tx-count + native-confirm flow as a final safety net).
    let _deleteEndpointArmed = false;
    let _deleteEndpointArmTimer = null;
    let _deleteEndpointOriginalLabel = '';
    function deleteEndpointWithConfirm() {
        const btn = document.getElementById('deleteEndpointBtn');
        if (!btn) { return; }

        if (!_deleteEndpointArmed) {
            _deleteEndpointArmed = true;
            _deleteEndpointOriginalLabel = btn.textContent;
            btn.textContent = 'Click again to confirm';
            btn.classList.add('btn-armed');
            clearTimeout(_deleteEndpointArmTimer);
            _deleteEndpointArmTimer = setTimeout(() => {
                _deleteEndpointArmed = false;
                if (btn && document.getElementById('deleteEndpointBtn') === btn) {
                    btn.textContent = _deleteEndpointOriginalLabel || 'Delete';
                    btn.classList.remove('btn-armed');
                }
            }, 4000);
            return;
        }

        clearTimeout(_deleteEndpointArmTimer);
        _deleteEndpointArmed = false;
        btn.textContent = _deleteEndpointOriginalLabel || 'Delete';
        btn.classList.remove('btn-armed');
        deleteEndpoint();
    }

    function confirmDeleteWithTransactionCount(transactionCount) {
        const endpointName = document.getElementById('endpointName').value.trim();

        // Send confirmation request to backend (VS Code will show native dialog)
        vscode.postMessage({
            type: 'confirmDeleteEndpoint',
            endpointId: currentEndpointId,
            endpointName: endpointName,
            transactionCount: transactionCount
        });
    }

    /**
     * GitHub Issue #98: Open Run Batch webview
     * GitHub Issue #165: Validate ENV variables before opening
     */
    function openRunBatchWebview() {
        // Check for unsaved changes
        if (hasUnsavedChanges) {
            vscode.postMessage({
                type: 'showWarning',
                message: 'Please save your changes before running batch'
            });
            return;
        }

        if (!currentEndpointId || currentEndpointId === 'NEW') {
            vscode.postMessage({
                type: 'showWarning',
                message: 'Please save the endpoint first'
            });
            return;
        }

        // GitHub Issue #165: Check for missing or empty ENV variables in template
        const envValidation = validateEnvVariables();
        if (!envValidation.valid) {
            if (envValidation.missing.length > 0) {
                // Variables don't exist - offer to add them
                vscode.postMessage({
                    type: 'confirmAddMissingEnvVariables',
                    endpointId: currentEndpointId,
                    missingVariables: envValidation.missing,
                    environmentId: window.currentActiveEnvironment?.id,
                    environmentName: window.currentActiveEnvironment?.name
                });
            } else if (envValidation.empty.length > 0) {
                // Variables exist but have empty values - just open environment
                vscode.postMessage({
                    type: 'openEnvironmentForEmptyVars',
                    emptyVariables: envValidation.empty,
                    environmentId: window.currentActiveEnvironment?.id,
                    environmentName: window.currentActiveEnvironment?.name
                });
            }
            return;
        }

        // Send message to backend to open Run Batch webview
        vscode.postMessage({
            type: 'openRunBatchWebview',
            endpointId: currentEndpointId
        });
    }





    function switchTab(tabName) {
        // Prevent switching to body tab if it's disabled
        if (tabName === 'body') {
            const bodyTab = document.getElementById('bodyTab');
            if (bodyTab && bodyTab.classList.contains('disabled')) {
                // Don't switch to disabled body tab
                return;
            }
        }

        document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
        event.target.classList.add('active');
        document.querySelectorAll('.tab-content').forEach(content => content.classList.add('hidden'));

        // Fix: Map tab names to correct element IDs
        let targetElementId;
        switch (tabName) {
            case 'body':
                targetElementId = 'bodyTabContent';
                break;
            case 'tests':
                targetElementId = 'testsTabContent';
                break;
            case 'headers':
                targetElementId = 'headersTab';
                break;
            case 'queryParams':
                targetElementId = 'queryParamsTab';
                break;
            default:
                targetElementId = tabName + 'Tab';
        }

        const targetElement = document.getElementById(targetElementId);
        if (targetElement) {
            targetElement.classList.remove('hidden');
        }

        // Auto-trigger Analyze Template when Body tab is shown
        if (tabName === 'body') {
            analyzeTemplate();
        }
    }

    function toggleBodyTab() {
        const method = document.getElementById('endpointMethod').value;
        const bodyTab = document.getElementById('bodyTab');
        const arrayRepetitionConfig = document.getElementById('arrayRepetitionConfig');
        const batchProcessingConfig = document.getElementById('batchProcessingConfig');

        // Always enable Body tab for all methods to support mock testing with template variables
        bodyTab.style.display = 'block';
        bodyTab.classList.remove('disabled');
        bodyTab.style.opacity = '1';
        bodyTab.style.cursor = 'pointer';

        // Show array repetition config only for POST/PUT endpoints (requires request body)
        if (method === 'POST' || method === 'PUT') {
            arrayRepetitionConfig.style.display = 'block';
        } else {
            arrayRepetitionConfig.style.display = 'none';
        }

        // Batch Processing Configuration is always visible for all methods
        // (GET/POST/PUT/DELETE all support batch operations with error handling)
        batchProcessingConfig.style.display = 'block';

        // Check for changes when method changes
        checkForChanges();
        updateTitle();
    }

    // Track if user explicitly added body section via menu (GitHub Issue #164)
    let bodyWasExplicitlyAdded = false;

    function updateSectionVisibility() {
        const method = document.getElementById('endpointMethod').value;
        const bodySection = document.getElementById('bodySection');
        const bodyNotSentIndicator = document.getElementById('bodyNotSentIndicator');
        const queryParamsSection = document.getElementById('queryParamsSection');
        const testsSection = document.getElementById('testsSection');

        // Check if body has content
        let hasBodyContent = false;
        if (window.monacoEditor) {
            hasBodyContent = window.monacoEditor.getValue().trim() !== '';
        }

        // Body section visibility logic (GitHub Issue #164)
        if (bodySection) {
            if (method === 'GET' || method === 'DELETE') {
                // Show body for GET/DELETE if it has content OR user explicitly added it
                if (hasBodyContent || bodyWasExplicitlyAdded) {
                    bodySection.classList.remove('hidden');
                    // Show "body not sent" indicator
                    if (bodyNotSentIndicator) {
                        bodyNotSentIndicator.classList.remove('hidden');
                    }
                } else {
                    bodySection.classList.add('hidden');
                    if (bodyNotSentIndicator) {
                        bodyNotSentIndicator.classList.add('hidden');
                    }
                }
            } else {
                // POST/PUT/PATCH - always show body section
                // Hide the "not sent" indicator since body IS sent for these methods
                if (bodyNotSentIndicator) {
                    bodyNotSentIndicator.classList.add('hidden');
                }

                // For existing endpoints, always show body section
                if (!isNewEndpoint) {
                    bodySection.classList.remove('hidden');
                } else {
                    // For new endpoints with POST/PUT/PATCH, auto-show body section
                    // This makes it easy to start typing the request body immediately
                    bodySection.classList.remove('hidden');
                }
            }
        }

        // Query params section visibility
        if (queryParamsSection) {
            const hasParams = document.getElementById('queryParamsContainer').children.length > 0;
            if (hasParams) {
                queryParamsSection.classList.remove('hidden');
            } else {
                queryParamsSection.classList.add('hidden');
            }
        }

        // Tests section: show if there are tests
        if (testsSection) {
            const hasTests = document.getElementById('singleTestScript').value.trim() !== '';
            if (hasTests) {
                testsSection.classList.remove('hidden');
            } else {
                testsSection.classList.add('hidden');
            }
        }

        // Check for changes when method changes
        checkForChanges();
        updateTitle();
    }

    function toggleSection(sectionId) {
        const section = document.getElementById(sectionId);
        if (section) {
            const isCollapsed = section.classList.contains('collapsed');
            if (isCollapsed) {
                section.classList.remove('collapsed');
                // Update arrow icon
                const header = section.querySelector('h3');
                if (header) {
                    header.textContent = header.textContent.replace('▶', '▼');
                }
            } else {
                section.classList.add('collapsed');
                // Update arrow icon
                const header = section.querySelector('h3');
                if (header) {
                    header.textContent = header.textContent.replace('▼', '▶');
                }
            }
        }
    }

    function switchTabProgrammatically(tabName) {
        document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
        const targetTab = document.querySelector('[data-click="switchTab"][data-arg="' + tabName + '"]');
        if (targetTab) targetTab.classList.add('active');
        document.querySelectorAll('.tab-content').forEach(content => content.classList.add('hidden'));

        // Fix: Use the same mapping logic as switchTab
        let targetElementId;
        switch (tabName) {
            case 'body':
                targetElementId = 'bodyTabContent';
                break;
            case 'tests':
                targetElementId = 'testsTabContent';
                break;
            case 'headers':
                targetElementId = 'headersTab';
                break;
            case 'queryParams':
                targetElementId = 'queryParamsTab';
                break;
            default:
                targetElementId = tabName + 'Tab';
        }

        const targetElement = document.getElementById(targetElementId);
        if (targetElement) {
            targetElement.classList.remove('hidden');
        }

        // Auto-trigger Analyze Template when Body tab is shown programmatically
        if (tabName === 'body') {
            analyzeTemplate();
        }
    }

    function addCustomHeader(key = '', value = '', enabled = true) {
        // Show headers section if hidden
        const headersSection = document.getElementById('headersSection');
        if (headersSection && headersSection.classList.contains('hidden')) {
            headersSection.classList.remove('hidden');
        }

        const container = document.getElementById('headersContainer');
        const div = document.createElement('div');
        div.className = 'header-row';
        div.innerHTML =
            '<input type="checkbox" ' + (enabled ? 'checked' : '') + ' title="Enable/disable this header" />' +
            '<input type="text" class="header-key" placeholder="Header Key" value="' + key + '" />' +
            '<input type="text" class="header-value" placeholder="Header Value" value="' + value + '" />' +
            '<button class="remove-btn" data-click="removeRow">Remove</button>';
        container.appendChild(div);

        // Show custom headers section when first header is added
        const headerCount = container.children.length;
        if (headerCount >= 1) {
            // Section visibility is already handled above
        }

        // Add change listeners to all inputs including checkbox
        const inputs = div.querySelectorAll('input');
        inputs.forEach(input => {
            input.addEventListener('input', () => {
                checkForChanges();
                updateTitle();
            });
            input.addEventListener('change', () => {
                checkForChanges();
                updateTitle();
            });
        });

        // Add visual feedback for disabled headers
        const checkbox = div.querySelector('input[type="checkbox"]');
        setupRowDisabledState(checkbox, div);

        // Check for changes after adding header
        checkForChanges();
        updateTitle();
    }

    function addQueryParam(key = '', value = '', enabled = true) {
        // Show query params section if hidden
        const queryParamsSection = document.getElementById('queryParamsSection');
        if (queryParamsSection && queryParamsSection.classList.contains('hidden')) {
            queryParamsSection.classList.remove('hidden');
        }

        const container = document.getElementById('queryParamsContainer');
        const div = document.createElement('div');
        div.className = 'param-row';
        div.innerHTML =
            '<input type="checkbox" ' + (enabled ? 'checked' : '') + ' title="Enable/disable this query parameter" />' +
            '<input type="text" class="query-param-key" placeholder="Parameter Key" value="' + key + '" />' +
            '<input type="text" class="query-param-value" placeholder="Parameter Value" value="' + value + '" />' +
            '<button class="remove-btn" data-click="removeRow">Remove</button>';
        container.appendChild(div);

        // Show the inline add button after first param is added
        const addBtn = document.getElementById('addQueryParamBtn');
        const paramCount = container.children.length;
        if (addBtn && paramCount >= 1) {
            addBtn.classList.remove('hidden');
        }

        // Add change listeners to all inputs including checkbox
        const inputs = div.querySelectorAll('input');
        inputs.forEach(input => {
            // Use 'change' event for checkboxes, 'input' for text fields
            const eventType = input.type === 'checkbox' ? 'change' : 'input';
            input.addEventListener(eventType, () => {
                checkForChanges();
                updateTitle();
            });
        });

        // Add visual feedback for disabled query params (GitHub Issue #101)
        const checkbox = div.querySelector('input[type="checkbox"]');
        setupRowDisabledState(checkbox, div);

        // Check for changes after adding param
        checkForChanges();
        updateTitle();
    }

    // Reusable function to add visual feedback for disabled rows (GitHub Issue #101)
    function setupRowDisabledState(checkbox, row) {
        const updateRowState = () => {
            if (checkbox.checked) {
                row.classList.remove('row-disabled');
            } else {
                row.classList.add('row-disabled');
            }
        };

        checkbox.addEventListener('change', updateRowState);
        updateRowState(); // Set initial state
    }

    function removeElement(element) {
        const parent = element.parentElement;
        element.remove();

        // Check if parent container is now empty
        if (parent && parent.id === 'queryParamsContainer') {
            const paramCount = parent.children.length;
            if (paramCount === 0) {
                const addBtn = document.getElementById('addQueryParamBtn');
                if (addBtn) {
                    addBtn.classList.add('hidden');
                }
            }
        }

        // Update section visibility
        updateSectionVisibility();

        // Check for changes after removing element
        checkForChanges();
        updateTitle();
    }

    function collectCustomHeaders() {
        const headers = {};

        try {
            // Only collect endpoint headers (not inherited environment headers)
            const headerRows = document.querySelectorAll('#headersContainer .header-row:not(.inherited)');

            if (headerRows && headerRows.length > 0) {
                headerRows.forEach(row => {
                    const checkbox = row.querySelector('input[type="checkbox"]');
                    const keyInput = row.querySelector('.header-key');
                    const valueInput = row.querySelector('.header-value');

                    if (keyInput && valueInput) {
                        const key = keyInput.value.trim();
                        const value = valueInput.value.trim();
                        const enabled = checkbox ? checkbox.checked : true;

                        if (key) {
                            headers[key] = {
                                value: value,
                                enabled: enabled
                            };
                        }
                    }
                });
            }
        } catch (error) {
        }

        return headers;
    }

    // The endpoint's own headers (the environment's are inherited at run time)
    function collectAllHeaders() {
        return collectCustomHeaders();
    }


    function collectQueryParams() {
        const params = {};

        try {
            const paramRows = document.querySelectorAll('#queryParamsContainer .param-row');

            if (paramRows && paramRows.length > 0) {
                paramRows.forEach(row => {
                    const enabledCheckbox = row.querySelector('input[type="checkbox"]');
                    const keyInput = row.querySelector('.query-param-key');
                    const valueInput = row.querySelector('.query-param-value');

                    if (keyInput && valueInput) {
                        const key = keyInput.value.trim();
                        const value = valueInput.value.trim();

                        // Save all query params with enabled state (GitHub Issue #108 - fix hidden params not saving)
                        const isEnabled = enabledCheckbox ? enabledCheckbox.checked : true;

                        if (key) {
                            // Store as object with value and enabled state (matches header format)
                            params[key] = {
                                value: value,
                                enabled: isEnabled
                            };
                        }
                    }
                });
            }
        } catch (error) {
        }

        return params;
    }

    function collectSingleTestScript() {
        const singleTestScript = document.getElementById('singleTestScript')?.value.trim() || '';
        return {
            script: singleTestScript,
            enabled: singleTestScript.length > 0 // Enable if script is not empty
        };
    }

    function collectDataLoadingConfig() {
        try {
            const testScript = collectSingleTestScript();
            const method = document.getElementById('endpointMethod').value;

            // For non-POST endpoints, return a clean config to avoid validation issues
            if (method !== 'POST') {
                // Return a clean data loading config with empty/default values
                // This prevents validation errors when switching from POST to GET
                const errorHandling = {
                    mode: 'stopOnFirst',
                    retryConfig: {
                        maxAttempts: 1,
                        delaySeconds: 5,
                        retryConditions: {
                            networkErrors: true,
                            serverErrors: true,
                            rateLimiting: true,
                            clientErrors: false
                        }
                    }
                };

                return {
                    jsonTemplate: '', // Empty template - won't trigger validation error
                    detectArrays: true,
                    repeatableArrays: [], // Empty arrays - won't trigger validation error
                    testScripts: [], // Empty array - no test scripts for non-POST methods
                    errorHandling: errorHandling,
                    dataValidation: {
                        enforceDataTypes: false,
                        variableDataTypes: {}
                    }
                };
            }

            const body = window.monacoEditor ? window.monacoEditor.getValue().trim() : '';

            // Collect array repetition configuration
            const repeatableArrays = [];
            const arrayCheckboxes = document.querySelectorAll('.array-repeat-enabled:checked');
            if (arrayCheckboxes && arrayCheckboxes.length > 0) {
                arrayCheckboxes.forEach(checkbox => {
                    const arrayPath = checkbox.dataset.arrayPath;
                    const maxInput = document.querySelector(`.array-max-repetitions[data-array-path="${arrayPath}"]`);
                    const maxRepetitions = maxInput ? parseInt(maxInput.value) || 1 : 1;


                    if (arrayPath) {
                        const arrayConfig = {
                            arrayPath: arrayPath,
                            maxRepetitions: maxRepetitions,
                            enabled: true
                        };
                        repeatableArrays.push(arrayConfig);
                    }
                });
            }

            // Collect error handling configuration
            const errorModeElement = document.querySelector('input[name="errorMode"]:checked');
            const errorMode = errorModeElement ? errorModeElement.value : 'stopOnFirst';

            const retryAttemptsElement = document.getElementById('retryAttempts');
            const retryAttempts = retryAttemptsElement ? parseInt(retryAttemptsElement.value) || 1 : 1;

            const retryDelayElement = document.getElementById('retryDelay');
            const retryDelay = retryDelayElement ? parseInt(retryDelayElement.value) || 5 : 5;

            // Collect enhanced error tolerance configuration
            const enableErrorToleranceElement = document.getElementById('enableErrorTolerance');
            const enableErrorTolerance = enableErrorToleranceElement ? enableErrorToleranceElement.checked : false;

            const toleranceModeElement = document.querySelector('input[name="toleranceMode"]:checked');
            const toleranceMode = toleranceModeElement ? toleranceModeElement.value : 'absolute';

            const absoluteErrorLimitElement = document.getElementById('absoluteErrorLimit');
            const absoluteErrorLimit = absoluteErrorLimitElement ? parseInt(absoluteErrorLimitElement.value) || 10 : 10;

            const percentageErrorLimitElement = document.getElementById('percentageErrorLimit');
            const percentageErrorLimit = percentageErrorLimitElement ? parseInt(percentageErrorLimitElement.value) || 5 : 5;

            // Collect data validation configuration
            const enforceDataTypesElement = document.getElementById('enforceDataTypes');
            const enforceDataTypes = enforceDataTypesElement ? enforceDataTypesElement.checked : false;

            const config = {
                jsonTemplate: body,
                detectArrays: true,
                repeatableArrays: repeatableArrays,
                testScripts: testScript.script.trim() ? [{
                    name: 'PostExecutionTest',
                    script: testScript.script,
                    enabled: testScript.enabled,
                    priority: 0
                }] : [],
                errorHandling: {
                    mode: errorMode,
                    enableErrorTolerance: enableErrorTolerance,
                    toleranceMode: toleranceMode,
                    absoluteErrorLimit: absoluteErrorLimit,
                    percentageErrorLimit: percentageErrorLimit,
                    maxErrorTolerance: (errorMode === 'continue' && enableErrorTolerance) ? {
                        enabled: true,
                        type: toleranceMode,
                        value: toleranceMode === 'absolute' ? absoluteErrorLimit : percentageErrorLimit
                    } : {
                        enabled: false,
                        type: toleranceMode,
                        value: toleranceMode === 'absolute' ? absoluteErrorLimit : percentageErrorLimit
                    },
                    retryConfig: {
                        maxAttempts: retryAttempts,
                        delaySeconds: retryDelay,
                        retryConditions: {
                            networkErrors: true,
                            serverErrors: true,
                            rateLimiting: true,
                            clientErrors: false
                        }
                    }
                },
                dataValidation: {
                    enforceDataTypes: enforceDataTypes,
                    variableDataTypes: {} // Will be populated by template analysis
                }
            };


            // Validate the configuration using Zod if available
            if (typeof window.ZodValidation !== 'undefined') {
                const validation = window.ZodValidation.validateDataLoadingConfig(config);

                if (!validation.success) {
                    const errorMessages = validation.errors.join(', ');

                    // Show validation error to user and block save
                    vscode.postMessage({
                        type: 'validationError',
                        message: `Data loading configuration is invalid: ${errorMessages}`
                    });
                    return undefined; // Return undefined to prevent save
                }
            }

            return config;

        } catch (error) {
            return undefined;
        }
    }

    function addTestScript(name = '', script = '', enabled = true) {
        const container = document.getElementById('testScriptsContainer');
        const div = document.createElement('div');
        div.className = 'test-script-row';

        // Generate a unique ID for this test script
        const testId = 'test_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

        div.innerHTML = `
            <div class="test-header">
                <input type="text" class="test-name" placeholder="Test Name" value="${name}" />
                <label class="checkbox-label">
                    <input type="checkbox" class="test-enabled" ${enabled ? 'checked' : ''} />
                    Enabled
                </label>
                <button class="remove-btn" data-click="removeRow">Remove</button>
            </div>
            <textarea class="test-script" rows="8" placeholder="// Write your test here using Chai.js assertions&#10;// Available objects: response, request, csvRow, expect, assert&#10;&#10;// Example:&#10;expect(response.status).to.equal(200);&#10;expect(response.json().success).to.be.true;&#10;&#10;// Data correlation:&#10;// expect(response.json().data[0].itemId).to.include(csvRow['SKU']);">${script}</textarea>
        `;

        container.appendChild(div);

        // Add change listeners to the new elements
        div.querySelectorAll('input, textarea').forEach(element => {
            element.addEventListener('input', () => {
                checkForChanges();
                updateTitle();
            });
        });

        checkForChanges();
        updateTitle();

        return div;
    }

    function validateSingleTest() {
        const testScript = collectSingleTestScript();

        if (!testScript.script) {
            showTestPreviewResults(null, 'No test script to validate');
            return;
        }

        // Send single test script to backend for validation
        vscode.postMessage({
            type: 'validateTests',
            testConfigs: [{ name: 'PostExecutionTest', script: testScript.script, enabled: testScript.enabled }]
        });
    }

    function runTestsPreview() {
        const testScript = collectSingleTestScript();

        if (!testScript.script) {
            showTestPreviewResults(null, 'No test script to preview. Write some test code first.');
            return;
        }

        // Create sample data for preview (serialize functions to data)
        const responseBody = '{"success": true, "data": [{"id": "123", "name": "Sample Item"}]}';
        const requestBodyValue = document.getElementById('endpointBody').value.trim();
        let requestBodyJson = {};
        try {
            // Strip comments before parsing for validation
            const cleanBody = window.stripJsonCommentsSafe ? window.stripJsonCommentsSafe(requestBodyValue || '{}') : (requestBodyValue || '{}');
            requestBodyJson = JSON.parse(cleanBody);
        } catch {
            requestBodyJson = {};
        }

        const sampleData = {
            response: {
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: responseBody,
                jsonData: { success: true, data: [{ id: "123", name: "Sample Item" }] }, // Pre-parsed JSON
                textData: responseBody
            },
            request: {
                method: document.getElementById('endpointMethod').value,
                url: document.getElementById('endpointPath').value,
                headers: collectAllHeaders(),
                body: requestBodyValue,
                jsonData: requestBodyJson // Pre-parsed JSON
            },
            csvRow: { 'SKU': 'SAMPLE123', 'QUANTITY': '10', 'LOCATION': 'LOC001' }
        };

        // Get custom sample data from user input
        const customSampleData = collectSampleData();
        const finalSampleData = customSampleData ? customSampleData : sampleData;

        // Send to backend for preview execution
        vscode.postMessage({
            type: 'runTestsPreview',
            testConfigs: [{ name: 'PostExecutionTest', script: testScript.script, enabled: testScript.enabled }],
            sampleData: finalSampleData
        });
    }

    function collectSampleData() {
        // Get custom CSV row data
        const csvDataField = document.getElementById('sampleCsvData');
        const responseDataField = document.getElementById('sampleResponseData');

        let csvData = { 'SKU': 'SAMPLE123', 'QUANTITY': '10', 'LOCATION': 'LOC001' };
        let responseData = { success: true, data: [{ id: "123", name: "Sample Item" }] };

        // Parse custom CSV data if provided
        if (csvDataField && csvDataField.value.trim()) {
            try {
                csvData = JSON.parse(csvDataField.value.trim());
            } catch (error) {
            }
        }

        // Parse custom response data if provided
        if (responseDataField && responseDataField.value.trim()) {
            try {
                responseData = JSON.parse(responseDataField.value.trim());
            } catch (error) {
            }
        }

        // Create combined sample data
        const responseBody = JSON.stringify(responseData);
        const requestBodyValue = document.getElementById('endpointBody').value.trim();
        let requestBodyJson = {};
        try {
            // Strip comments before parsing for validation
            const cleanBody = window.stripJsonCommentsSafe ? window.stripJsonCommentsSafe(requestBodyValue || '{}') : (requestBodyValue || '{}');
            requestBodyJson = JSON.parse(cleanBody);
        } catch {
            requestBodyJson = {};
        }

        return {
            response: {
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: responseBody,
                jsonData: responseData,
                textData: responseBody
            },
            request: {
                method: document.getElementById('endpointMethod').value,
                url: document.getElementById('endpointPath').value,
                headers: collectAllHeaders(),
                body: requestBodyValue,
                jsonData: requestBodyJson
            },
            csvRow: csvData
        };
    }

    function switchSampleTab(tabName) {
        // Remove active class from all tabs
        document.querySelectorAll('.sample-tab').forEach(tab => {
            tab.classList.remove('active');
        });

        // Hide all tab content
        document.querySelectorAll('.sample-tab-content').forEach(content => {
            content.classList.add('hidden');
        });

        // Show selected tab
        const selectedTab = document.querySelector(`.sample-tab[data-click="switchSampleTab"][data-arg="${tabName}"]`);
        if (selectedTab) {
            selectedTab.classList.add('active');
        }

        const contentMap = {
            'csv': 'csvSampleTab',
            'response': 'responseSampleTab',
            'api': 'apiSampleTab'
        };

        const contentId = contentMap[tabName];
        if (contentId) {
            const content = document.getElementById(contentId);
            if (content) {
                content.classList.remove('hidden');
            }
        }
    }

    function makeTestAPICall() {
        // Collect current endpoint configuration
        const endpointData = {
            method: document.getElementById('endpointMethod').value,
            path: document.getElementById('endpointPath').value,
            headers: collectAllHeaders(),
            body: document.getElementById('endpointBody').value.trim()
        };

        // Show loading state
        const resultsDiv = document.getElementById('apiCallResults');
        const responseData = document.getElementById('apiResponseData');

        resultsDiv.style.display = 'block';
        responseData.textContent = 'Making API call...';

        // Send test call request to backend
        vscode.postMessage({
            type: 'testAPICall',
            endpoint: endpointData
        });
    }

    function handleAPICallResults(success, data, error) {
        const resultsDiv = document.getElementById('apiCallResults');
        const responseData = document.getElementById('apiResponseData');

        if (!resultsDiv || !responseData) return;

        resultsDiv.style.display = 'block';

        if (success && data) {
            responseData.textContent = JSON.stringify(data, null, 2);

            // Automatically populate response sample data
            const responseDataField = document.getElementById('sampleResponseData');
            if (responseDataField) {
                responseDataField.value = JSON.stringify(data, null, 2);
            }

            // Switch to response tab to show the populated data
            switchSampleTab('response');

        } else {
            responseData.textContent = `API Call Failed: ${error || 'Unknown error'}`;
        }
    }

    function showValidationResults(results) {
        const resultsDiv = document.getElementById('testValidationResults');

        if (!resultsDiv) {
            return;
        }

        if (results.length === 0) {
            resultsDiv.style.display = 'none';
            return;
        }

        let hasErrors = false;
        const result = results[0]; // Single test result
        const isValid = result.validation.isValid;

        if (!isValid) hasErrors = true;

        // Use the new validation results styling
        resultsDiv.className = `test-validation-results ${hasErrors ? 'error' : 'success'}`;
        resultsDiv.style.display = 'block';

        let html = `
            <h4>
                <span class="test-result-icon">${isValid ? '✅' : '❌'}</span>
                Test Validation Results
            </h4>
            <div>${isValid ?
                'Test script is valid and ready to use' :
                `Test script has syntax errors: ${result.validation.error}`
            }</div>
        `;

        resultsDiv.innerHTML = html;
    }

    function analyzeTemplate() {
        const templateText = window.monacoEditor ? window.monacoEditor.getValue().trim() : '';

        if (!templateText) {
            showTemplateAnalysisResults([], []);
            return;
        }

        // Validate JSON syntax first
        const validation = validateJSONSyntax(templateText);

        if (!validation.isValid) {
            // Show error to user and stop analysis
            vscode.postMessage({
                type: 'showError',
                message: `Cannot analyze template: ${validation.error}`
            });
            return;
        }

        // Auto-format JSON if it's valid JSON (strip comments first)
        try {
            const cleanTemplate = window.stripJsonCommentsSafe ? window.stripJsonCommentsSafe(templateText) : templateText;
            const parsed = JSON.parse(cleanTemplate);
            const formatted = JSON.stringify(parsed, null, 2);
            if (formatted !== templateText && window.monacoEditor) {
                window.monacoEditor.setValue(formatted);
                // Monaco change listener will trigger change tracking automatically
            }
        } catch (error) {
            // This shouldn't happen since we validated above, but just in case
            return;
        }

        // Send template to backend for analysis
        vscode.postMessage({
            type: 'analyzeTemplate',
            template: window.monacoEditor ? window.monacoEditor.getValue().trim() : ''
        });
    }

    function showTemplateAnalysisResults(variables, arrays) {
        // Update variables display
        const variablesDisplay = document.getElementById('templateVariablesDisplay');

        if (variables.length === 0) {
            variablesDisplay.innerHTML = '<p class="placeholder-text">Variables will appear as you type...</p>';
        } else {
            let html = '';
            variables.forEach(variable => {
                html += `
                    <div class="variable-item-simple">
                        <span class="variable-name-simple">${variable.name}</span>
                        <span class="variable-type-simple">${variable.dataType}</span>
                    </div>
                `;
            });
            variablesDisplay.innerHTML = html;
        }

        // Update arrays display in the new seamless section
        const arraysDisplay = document.getElementById('templateArraysDisplay');
        if (arraysDisplay) {
            if (arrays.length === 0) {
                arraysDisplay.innerHTML = '<p class="placeholder-text">Array patterns will be detected automatically...</p>';
            } else {
                let html = '';
                arrays.forEach(array => {
                    html += `
                        <div class="array-item-simple">
                            <span class="array-name-simple">${array.path}[]</span>
                            <span class="array-badge-simple">repeatable</span>
                        </div>
                    `;
                });
                arraysDisplay.innerHTML = html;
            }
        }

        // Update arrays display
        const arraysContainer = document.getElementById('repeatableArraysContainer');

        if (arrays.length === 0) {
            arraysContainer.innerHTML = '<p class="placeholder-text">No arrays detected in template.</p>';
        } else {
            let html = '';
            arrays.forEach((arrayInfo, index) => {
                const arrayPath = arrayInfo.path;
                html += `
                    <div class="array-item">
                        <span class="array-path">${arrayPath}</span>
                        <div class="array-controls">
                            <label class="checkbox-label">
                                <input type="checkbox" class="array-repeat-enabled" data-array-path="${arrayPath}" />
                                Enable repetition
                            </label>
                            <label>Max elements:</label>
                            <input type="number" class="array-max-repetitions" data-array-path="${arrayPath}" value="1" min="1" max="100" disabled />
                        </div>
                    </div>
                `;
            });
            arraysContainer.innerHTML = html;

            // Add event listeners for array controls
            document.querySelectorAll('.array-repeat-enabled').forEach(checkbox => {
                checkbox.addEventListener('change', function () {
                    const maxInput = document.querySelector(`.array-max-repetitions[data-array-path="${this.dataset.arrayPath}"]`);
                    if (maxInput) {
                        maxInput.disabled = !this.checked;
                        if (this.checked) {
                            maxInput.value = Math.max(1, parseInt(maxInput.value) || 1);
                        }
                    }
                    checkForChanges();
                    updateTitle();
                });
            });

            document.querySelectorAll('.array-max-repetitions').forEach(input => {
                input.addEventListener('input', () => {
                    checkForChanges();
                    updateTitle();
                });
            });

            // Restore array repetition settings if we have saved data
            if (window.savedArrayRepetitionData) {
                restoreArrayRepetitionSettings(window.savedArrayRepetitionData);
                window.savedArrayRepetitionData = null; // Clear after use
            } else if (currentEndpointData && currentEndpointData.dataLoadingConfig && currentEndpointData.dataLoadingConfig.repeatableArrays) {
                // BUGFIX: Restore from cached endpoint data when window.savedArrayRepetitionData is not available
                // This happens when analyzeTemplate() is called during tab switches after the initial load
                restoreArrayRepetitionSettings(currentEndpointData.dataLoadingConfig.repeatableArrays);
            }
        }

        // Recapture initial form state after arrays are created/updated
        // This ensures array repetition changes are properly tracked for both new and restored arrays
        captureInitialFormState();
    }

    function setupDataLoadingEventListeners() {
        // Error handling radio buttons
        document.querySelectorAll('input[name="errorMode"]').forEach(radio => {
            radio.addEventListener('change', function () {
                const continueOptions = document.getElementById('continueOptions');
                if (this.value === 'continue') {
                    continueOptions.style.display = 'block';
                } else {
                    continueOptions.style.display = 'none';
                }
                checkForChanges();
                updateTitle();
            });
        });

        // Error tolerance enable/disable checkbox
        const enableErrorTolerance = document.getElementById('enableErrorTolerance');
        if (enableErrorTolerance) {
            enableErrorTolerance.addEventListener('change', function () {
                const errorToleranceContainer = document.getElementById('errorToleranceContainer');
                if (this.checked) {
                    errorToleranceContainer.style.display = 'block';
                } else {
                    errorToleranceContainer.style.display = 'none';
                }
                checkForChanges();
                updateTitle();
            });
        }

        // Tolerance mode radio buttons (absolute vs percentage)
        document.querySelectorAll('input[name="toleranceMode"]').forEach(radio => {
            radio.addEventListener('change', function () {
                const absoluteContainer = document.getElementById('absoluteModeContainer');
                const percentageContainer = document.getElementById('percentageModeContainer');

                if (this.value === 'absolute') {
                    absoluteContainer.style.display = 'flex';
                    percentageContainer.style.display = 'none';
                } else if (this.value === 'percentage') {
                    absoluteContainer.style.display = 'none';
                    percentageContainer.style.display = 'flex';
                }
                checkForChanges();
                updateTitle();
            });
        });

        // Error handling numeric inputs (updated for new structure)
        const errorHandlingInputs = ['absoluteErrorLimit', 'percentageErrorLimit', 'retryAttempts', 'retryDelay'];
        errorHandlingInputs.forEach(inputId => {
            const input = document.getElementById(inputId);
            if (input) {
                input.addEventListener('input', () => {
                    checkForChanges();
                    updateTitle();
                });
            }
        });

        // Data validation checkbox
        const enforceDataTypes = document.getElementById('enforceDataTypes');
        if (enforceDataTypes) {
            enforceDataTypes.addEventListener('change', function () {
                const helpDiv = document.getElementById('dataValidationHelp');
                if (helpDiv) {
                    helpDiv.style.display = this.checked ? 'block' : 'none';
                }
                checkForChanges();
                updateTitle();
            });
        }
    }

    // Listen for messages from extension
    window.addEventListener('message', event => {
        const message = event.data;

        switch (message.type) {
            case 'endpointSaved':
                handleEndpointSaved(message.endpoint);
                break;
            case 'endpointSaveError':
                handleEndpointSaveError(message.error);
                break;
            case 'transactionCountResponse':
                // GitHub Issue #98: Handle transaction count for delete confirmation
                confirmDeleteWithTransactionCount(message.count);
                break;
            case 'endpointDeleted':
                // Endpoint deleted successfully - webview will be closed by backend
                break;
            case 'endpointDeleteError':
                vscode.postMessage({ type: 'showError', message: 'Delete failed: ' + message.error });
                break;
            case 'checkUnsavedChanges':
                handleCheckUnsavedChanges();
                break;
            case 'saveCurrentEndpoint':
                saveEndpoint();
                break;
            case 'populateEndpointData':
                populateEndpointFormData(message.endpoint, { isDuplicate: !!message.isDuplicate });
                break;
            case 'systemsList':
                renderSystemDropdown(message.systems || [], message.selectedSystemId);
                break;
            case 'tagsList':
                knownTags = Array.isArray(message.tags) ? message.tags : [];
                break;
            case 'tagsChanged':
                // #432: Manage Tags renamed, merged or deleted tags: what is saved now
                if (currentEndpointId) vscode.postMessage({ type: 'getSavedTags', endpointId: currentEndpointId });
                vscode.postMessage({ type: 'getTagsList' });
                break;
            case 'savedTags':
                applySavedTags(Array.isArray(message.tags) ? message.tags : []);
                break;
            case 'testValidationResults':
                showValidationResults(message.results);
                break;
            case 'testPreviewResults':
                handleTestPreviewResults(message.results);
                break;
            case 'templateAnalysisResults':
                showTemplateAnalysisResults(message.variables, message.arrays);
                break;
            case 'apiCallResults':
                handleAPICallResults(message.success, message.data, message.error);
                break;
            case 'csvParseError':
                handleCSVParseError(message.error);
                break;
        }
    });

    function handleEndpointSaved(endpoint) {
        // Update form state after successful save
        currentEndpointId = endpoint.id;
        isNewEndpoint = false;

        currentEndpointData = endpoint; // FIX: Update cached data with saved endpoint

        // Update the body data attribute to reflect the new endpoint ID
        document.body.setAttribute('data-endpoint-id', endpoint.id);

        // Clear the duplicate-dirty sticky flag now that the draft has been
        // persisted; otherwise the next resetChangeTracking would re-mark dirty.
        pendingDuplicateMarkDirty = false;

        // Reset change tracking after successful save
        // This calls updateButtonStates() which calls updateMoreActionsVisibility()
        // to show/hide Paste button and enable Copy/Duplicate/Delete (GitHub Issue #164)
        resetChangeTracking();

        // Note: Endpoint save operations are logged in backend console for debugging
    }

    function handleEndpointSaveError(error) {
        showFooterNotification('error', 'Could not save endpoint: ' + error, { shake: true });
    }

    function handleCheckUnsavedChanges() {
        // Check for unsaved changes and respond to extension
        checkForChanges();
        vscode.postMessage({
            type: 'unsavedChangesResponse',
            hasUnsavedChanges: hasUnsavedChanges
        });
    }

    /**
     * Lazily-created SystemPicker instance bound to the #endpointSystemPicker
     * container. We keep the reference at module scope so subsequent
     * systemsList broadcasts can call setSystems() on the SAME instance —
     * recreating it on every broadcast would lose hover state and rebind
     * outside-click listeners unnecessarily.
     */
    let endpointSystemPicker = null;

    function renderSystemDropdown(systems, selectedSystemId) {
        const container = document.getElementById('endpointSystemPicker');
        if (!container || !window.SystemPicker) return;

        if (!endpointSystemPicker) {
            endpointSystemPicker = window.SystemPicker.render(container, {
                placeholder: '-- Select System --',
                onSelect: () => {
                    // Mark form dirty so the Save button enables when the
                    // user changes the System assignment.
                    if (typeof checkForChanges === 'function') checkForChanges();
                    if (typeof updateTitle === 'function') updateTitle();
                },
                onAddRequested: () => {
                    vscode.postMessage({ type: 'createSystem' });
                }
            });
        }
        endpointSystemPicker.setSystems(systems, selectedSystemId);
    }

    /**
     * Tag chip input. Renders existing tags as removable chips followed by a
     * text input. Comma or Enter commits the current text as a new chip;
     * Backspace on an empty input removes the last chip. Tags normalise to
     * `trim().toLowerCase()` on commit so case-variants collapse here, matching
     * the host-side `normaliseTag()` rule.
     */
    /** #432: the tags already in use on endpoints, most used first (the host's `tagsList`). */
    let knownTags = [];

    function normaliseTagClient(raw) {
        if (typeof raw !== 'string') return null;
        const t = raw.trim().toLowerCase();
        return t.length > 0 ? t : null;
    }

    function getTagChipContainer() {
        return document.getElementById('endpointTagsChips');
    }

    function getTagChipValues() {
        const container = getTagChipContainer();
        if (!container) return [];
        const chips = container.querySelectorAll('.tag-chip');
        const seen = new Set();
        const out = [];
        chips.forEach(chip => {
            const tag = chip.getAttribute('data-tag');
            if (tag && !seen.has(tag)) { seen.add(tag); out.push(tag); }
        });
        return out;
    }

    function renderTagChips(tags) {
        const container = getTagChipContainer();
        if (!container) return;
        const input = container.querySelector('.tag-chip-textinput');
        // Clear existing chips, preserve input
        container.querySelectorAll('.tag-chip').forEach(el => el.remove());
        // Insert chips before the input
        tags.forEach(tag => {
            const chip = document.createElement('span');
            chip.className = 'tag-chip';
            chip.setAttribute('data-tag', tag);
            const label = document.createElement('span');
            label.className = 'tag-chip-label';
            label.textContent = tag;
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'tag-chip-remove';
            remove.setAttribute('aria-label', `Remove tag ${tag}`);
            remove.textContent = '×';
            remove.addEventListener('click', () => {
                chip.remove();
                if (typeof checkForChanges === 'function') checkForChanges();
                if (input) input.focus();
            });
            chip.appendChild(label);
            chip.appendChild(remove);
            if (input) container.insertBefore(chip, input);
            else container.appendChild(chip);
        });
    }

    function setTagChipValues(tags) {
        const normalised = [];
        const seen = new Set();
        (Array.isArray(tags) ? tags : []).forEach(raw => {
            const t = normaliseTagClient(raw);
            if (t && !seen.has(t)) { seen.add(t); normalised.push(t); }
        });
        renderTagChips(normalised);
    }

    function commitTagFromInput(input) {
        const raw = input.value;
        input.value = '';
        const tag = normaliseTagClient(raw);
        if (!tag) return;
        const current = getTagChipValues();
        if (current.includes(tag)) return;
        renderTagChips([...current, tag]);
        if (typeof checkForChanges === 'function') checkForChanges();
    }

    /**
     * #432: the endpoint's tags as saved now, after Manage Tags changed them. Tags added or removed
     * here and not saved yet stay as the user left them; the rest follow what was saved, and the
     * form isn't marked changed by it.
     */
    function applySavedTags(saved) {
        let initial = {};
        try { initial = initialEndpointStateJSON ? JSON.parse(initialEndpointStateJSON) : {}; } catch (_e) { initial = {}; }
        const before = Array.isArray(initial.tags) ? initial.tags : [];
        const current = getTagChipValues();
        const added = current.filter(t => !before.includes(t));
        const removed = before.filter(t => !current.includes(t));
        const next = saved.filter(t => !removed.includes(t));
        added.forEach(t => { if (!next.includes(t)) next.push(t); });
        setTagChipValues(next);
        if (initialEndpointStateJSON) {
            initial.tags = saved.slice();
            initialEndpointStateJSON = JSON.stringify(initial);
        }
        if (typeof checkForChanges === 'function') checkForChanges();
    }

    function initTagChipInput() {
        const container = getTagChipContainer();
        if (!container || container.dataset.initialised === 'true') return;
        container.dataset.initialised = 'true';

        // Render input once
        const input = document.createElement('input');
        input.type = 'text';
        input.id = 'endpointTagsInput';
        input.className = 'tag-chip-textinput';
        input.placeholder = 'Add tag, press Enter';
        input.setAttribute('autocomplete', 'off');
        container.appendChild(input);

        // #432: suggestions from the tags already in use, as you type. Attached before the
        // Enter/comma handler below, so Enter or Tab picks the highlighted suggestion first.
        if (window.TagSuggest) {
            window.TagSuggest.attach(input, {
                getKnown: () => knownTags,
                getCurrent: getTagChipValues,
                onPick: tag => {
                    input.value = '';
                    const t = normaliseTagClient(tag);
                    const current = getTagChipValues();
                    if (t && !current.includes(t)) {
                        renderTagChips([...current, t]);
                        if (typeof checkForChanges === 'function') checkForChanges();
                    }
                    input.focus();
                }
            });
        }

        // Each time the field gets focus, the tags in use now: one saved in another editor since
        // this one opened is offered too
        input.addEventListener('focus', () => vscode.postMessage({ type: 'getTagsList' }));

        // Initial chips from server-side template attribute
        const initial = (container.getAttribute('data-initial') || '')
            .split(',').map(s => s.trim()).filter(Boolean);
        setTagChipValues(initial);

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                commitTagFromInput(input);
            } else if (e.key === 'Backspace' && input.value.length === 0) {
                const chips = container.querySelectorAll('.tag-chip');
                if (chips.length > 0) {
                    chips[chips.length - 1].remove();
                    if (typeof checkForChanges === 'function') checkForChanges();
                }
            }
        });
        input.addEventListener('blur', () => commitTagFromInput(input));

        // Click on container focuses the input
        container.addEventListener('click', (e) => {
            if (e.target === container) input.focus();
        });
    }

    function populateEndpointFormData(endpoint, options) {
        options = options || {};
        // An id-less endpoint is a fresh draft (Duplicate flow) — drive the
        // form into new-endpoint mode so Save creates a new record.
        if (endpoint.id) {
            currentEndpointId = endpoint.id;
            isNewEndpoint = false;
        } else {
            currentEndpointId = null;
            isNewEndpoint = true;
        }
        currentEndpointFolder = endpoint.folder || '';

        // Set the System picker to the endpoint's assigned System if it has
        // already been populated by an earlier systemsList message.
        if (endpointSystemPicker && endpoint.systemId) {
            endpointSystemPicker.setSelected(endpoint.systemId);
        }

        // Populate tag chips (Duplicate flow renders blank HTML; Edit flow's
        // data-initial attribute already seeded chips on init, but re-applying
        // here is idempotent and keeps the data path explicit).
        if (Array.isArray(endpoint.tags)) {
            setTagChipValues(endpoint.tags);
        }

        // Delete is only valid for saved endpoints.
        const deleteBtn = document.getElementById('deleteEndpointBtn');
        if (deleteBtn) {
            deleteBtn.classList.toggle('hidden', !endpoint.id);
        }

        // Basic fields. The Edit flow gets these pre-rendered into the HTML by
        // server-side template substitution (ENDPOINT_NAME / ENDPOINT_PATH /
        // ENDPOINT_METHOD / ENDPOINT_DESCRIPTION). The Duplicate flow opens a
        // new-tab whose HTML renders blank — populate them here from the
        // message payload so the form isn't empty.
        const nameInput = document.getElementById('endpointName');
        if (nameInput && typeof endpoint.name === 'string') nameInput.value = endpoint.name;
        const pathInput = document.getElementById('endpointPath');
        if (pathInput && typeof endpoint.path === 'string') pathInput.value = endpoint.path;
        const methodSelect = document.getElementById('endpointMethod');
        if (methodSelect && typeof endpoint.method === 'string') methodSelect.value = endpoint.method.toUpperCase();
        const descInput = document.getElementById('endpointDescription');
        if (descInput && typeof endpoint.description === 'string') descInput.value = endpoint.description;

        // Populate custom headers (org headers are now handled separately)
        if (endpoint.headers) {
            Object.entries(endpoint.headers).forEach(([key, value]) => {
                // Add all headers as custom headers - org headers are auto-populated
                if (value && typeof value === 'object' && typeof value.value === 'string') {
                    // Header format: header has value and enabled properties
                    addCustomHeader(key, value.value, value.enabled !== false);
                } else {
                    console.warn(`Skipping header "${key}" with unsupported format:`, value);
                }
            });
        }


        // Populate query params (GitHub Issue #101 - support enabled state)
        if (endpoint.queryParams) {
            Object.entries(endpoint.queryParams).forEach(([key, value]) => {
                // Support both old format (string) and new format (object with value and enabled)
                if (typeof value === 'string') {
                    // Legacy format - just a string value
                    addQueryParam(key, value, true);
                } else if (value && typeof value === 'object' && typeof value.value === 'string') {
                    // New format - object with value and enabled properties
                    addQueryParam(key, value.value, value.enabled !== false);
                } else {
                    console.warn(`Skipping query param "${key}" with unsupported format:`, value);
                }
            });
        }

        // Populate single test script from data loading config (convert from new testScripts array)
        if (endpoint.dataLoadingConfig && endpoint.dataLoadingConfig.testScripts) {
            const singleTestArea = document.getElementById('singleTestScript');
            if (singleTestArea && endpoint.dataLoadingConfig.testScripts.length > 0) {
                // Load first test script for single-test UI
                const firstTest = endpoint.dataLoadingConfig.testScripts[0];
                singleTestArea.value = firstTest.script || '';
            }
        }

        // Restore data loading configuration settings
        if (endpoint.dataLoadingConfig) {
            populateDataLoadingConfig(endpoint.dataLoadingConfig);
        }

        // Issue #126: Set useEnvironmentHeaders checkbox
        const useEnvHeadersCheckbox = document.getElementById('useEnvironmentHeaders');
        if (useEnvHeadersCheckbox) {
            useEnvHeadersCheckbox.checked = endpoint.useEnvironmentHeaders !== false;
        }

        // Handle body content based on HTTP method
        if (window.monacoEditor) {
            if (endpoint.method === 'GET' || endpoint.method === 'DELETE') {
                // Clear body for GET/DELETE methods
                window.monacoEditor.setValue('');
            } else if (endpoint.body || endpoint.bodyWithComments) {
                // Set body for POST/PUT methods - use bodyWithComments for editing, fallback to body for legacy
                const editorContent = endpoint.bodyWithComments || endpoint.body;
                window.monacoEditor.setValue(editorContent);
                // Update section visibility after setting content
                setTimeout(() => {
                    updateSectionVisibility();
                }, 0);
            }
        }

        // Apply method-specific UI rules
        updateSectionVisibility();

        // Update page heading with loaded data
        updatePageHeading();

        // Duplicate drafts should land dirty so Save is immediately enabled.
        // resetChangeTracking honours this flag and the deferred Monaco-late
        // reset path picks it up too.
        pendingDuplicateMarkDirty = !!options.isDuplicate;
        resetChangeTracking();
    }

    function handleTestPreviewResults(results) {
        showTestPreviewResults(results);
    }










    function startDataLoading() {
        // Check for unsaved changes first
        const changeCheck = checkForUnsavedChangesBeforeDataLoading();

        if (!changeCheck.canProceed) {
            // Show appropriate warning message
            if (changeCheck.reason === 'unsaved_changes') {
                vscode.postMessage({
                    type: 'showWarning',
                    message: 'You have unsaved changes. Please save the endpoint before starting data loading.'
                });
            } else if (changeCheck.reason === 'no_endpoint_id') {
                vscode.postMessage({
                    type: 'showWarning',
                    message: 'Please save the endpoint before starting data loading.'
                });
            }
            return;
        }

        // Collect all mapping configuration
        const mappingConfig = collectMappingConfiguration();
        const csvData = getCurrentCSVData();
        const dataLoadingConfig = collectDataLoadingConfig();

        if (!csvData || mappingConfig.length === 0) {
            vscode.postMessage({
                type: 'showError',
                message: 'Please upload CSV data and configure mappings before starting.'
            });
            return;
        }

        // STOPFIRST_DEBUG: Log config being sent to backend

        // Send to backend for processing
        vscode.postMessage({
            type: 'startDataLoading',
            mappings: mappingConfig,
            csvData: csvData,
            config: dataLoadingConfig
        });

    }






    // Helper function to get CSS class for data type color coding
    function getDataTypeColorClass(dataType) {
        switch (dataType.toLowerCase()) {
            case 'string':
                return 'data-type-string';
            case 'number':
                return 'data-type-number';
            case 'boolean':
                return 'data-type-boolean';
            case 'date':
                return 'data-type-date';
            default:
                return 'data-type-string'; // Default to string styling
        }
    }

    // Issue #249: full-window mode for the body editor.
    // Toggles a class on #bodySection (CSS pins it to the viewport) and re-layouts
    // Monaco. Esc exits. Same Monaco instance is reused so edits persist across
    // toggles without any state copy.
    function setupFullscreenToggle() {
        const btn = document.getElementById('fullscreenBtn');
        const bodySection = document.getElementById('bodySection');
        if (!btn || !bodySection) return;

        const setFullscreen = (on) => {
            bodySection.classList.toggle('editor-fullscreen', on);
            // Footer becomes a hover/focus "peek bar" while full-window (core.css).
            document.body.classList.toggle('is-editor-fullscreen', on);
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
            btn.setAttribute('title', on ? 'Exit full window (Esc)' : 'Toggle full window (Esc to exit)');
            // Icon swap is CSS-driven via #bodySection.editor-fullscreen — no textContent change.
            // Let the browser apply the new layout before asking Monaco to re-measure
            // and re-running the toolbar overflow calc.
            requestAnimationFrame(() => {
                if (window.monacoEditor) window.monacoEditor.layout();
                if (!on) updateMonacoEditorHeight();
                if (window._toolbarOverflowAdjust) window._toolbarOverflowAdjust();
            });
        };

        btn.addEventListener('click', () => {
            setFullscreen(!bodySection.classList.contains('editor-fullscreen'));
        });

        // Esc exits fullscreen. Skip if Monaco's find widget owns the keystroke.
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && bodySection.classList.contains('editor-fullscreen')) {
                const findWidget = bodySection.querySelector('.find-widget.visible');
                if (findWidget) return;
                setFullscreen(false);
            }
        });
    }

    // Issue #249: dynamic overflow for the editor toolbar.
    // ResizeObserver watches toolbar width; when buttons don't fit, they move
    // (DOM-wise — keeps event handlers attached) into a "More" dropdown menu.
    // Order below = first-pushed → last-pushed.
    // Line Variable + Modifier dropdowns stay pinned at every width — putting a dropdown
    // inside a dropdown menu produces nested popups with broken positioning.
    const TOOLBAR_OVERFLOW_PRIORITY = [
        'encodeBtn', 'deleteLineBtn', 'redoBtn', 'undoBtn', 'commentBtn',
        'formatJsonBtn', 'insertBtn'
    ];

    function setupToolbarOverflow() {
        const toolbar = document.querySelector('.editor-toolbar');
        if (!toolbar) return;

        // Build the More wrapper — uses existing .toolbar-dropdown styles
        const moreWrap = document.createElement('div');
        moreWrap.className = 'toolbar-dropdown toolbar-overflow';
        moreWrap.id = 'toolbarOverflow';
        moreWrap.style.display = 'none';
        moreWrap.innerHTML = ''
            + '<button class="btn btn-secondary toolbar-dropdown-btn" id="toolbarOverflowBtn"'
            + ' title="More actions" aria-label="More actions" aria-haspopup="true">'
            +   'More<span class="dropdown-arrow">▼</span>'
            + '</button>'
            + '<div class="toolbar-dropdown-menu toolbar-overflow-menu"></div>';

        // Fullscreen moved to an editor-internal overlay icon, so the More wrapper
        // always sits at the end of the toolbar.
        toolbar.appendChild(moreWrap);

        const overflowMenu = moreWrap.querySelector('.toolbar-overflow-menu');
        const overflowBtn = moreWrap.querySelector('#toolbarOverflowBtn');

        overflowBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // Close sibling dropdowns
            document.getElementById('variableDropdown')?.classList.remove('open');
            document.getElementById('modifierDropdown')?.classList.remove('open');
            moreWrap.classList.toggle('open');
        });
        // Close on outside click — same pattern as other dropdowns (line ~819)
        document.addEventListener('click', () => moreWrap.classList.remove('open'));
        // Click inside menu closes after the button's own handler runs
        overflowMenu.addEventListener('click', () => moreWrap.classList.remove('open'));

        // Capture original DOM order — used to restore buttons to toolbar
        const originalOrder = Array.from(toolbar.children).filter(c => c !== moreWrap);

        let adjusting = false;
        function adjustOverflow() {
            if (adjusting) return;
            adjusting = true;

            // Hide More while we measure the natural width
            moreWrap.style.display = 'none';

            // Restore everything to toolbar in original order, then put More back at the end.
            for (const child of originalOrder) {
                toolbar.appendChild(child);
            }
            toolbar.appendChild(moreWrap);

            const fits = () => toolbar.scrollWidth <= toolbar.clientWidth + 1;

            if (!fits()) {
                moreWrap.style.display = '';
                for (const id of TOOLBAR_OVERFLOW_PRIORITY) {
                    if (fits()) break;
                    const btn = document.getElementById(id);
                    if (!btn || btn.parentElement === overflowMenu) continue;
                    overflowMenu.appendChild(btn);
                }
            }

            adjusting = false;
        }

        window._toolbarOverflowAdjust = adjustOverflow;

        const ro = new ResizeObserver(() => requestAnimationFrame(adjustOverflow));
        ro.observe(toolbar);

        // Initial pass after layout settles
        requestAnimationFrame(adjustOverflow);
    }

    // Footer button overflow into the "More" dropdown.
    // Mirrors setupToolbarOverflow (Issue #249). The More dropdown is purely an overflow
    // destination — empty by default, only shown when a button has spilled into it.
    // Spillable order below = first-spilled → last-spilled. Add/Save/Run aren't listed
    // and stay pinned at all widths.
    const FOOTER_OVERFLOW_PRIORITY = [
        'downloadTemplateBtn',  // specialty action, conditional anyway
        'duplicateEndpointBtn',
        'share-endpoint-btn',
        // Issue #291: Paste Endpoint is THE action on a new endpoint. It used to
        // spill first, so on a narrow Hub split it vanished into "More" and
        // looked missing. Now it only spills before Delete.
        'pasteEndpointBtn',
        'deleteEndpointBtn'     // last to spill (destructive — keep visible when possible)
    ];

    function setupFooterOverflow() {
        const container = document.querySelector('.footer-button-container-overflow');
        const moreDropdown = document.querySelector('.more-actions-dropdown');
        const moreMenu = document.getElementById('more-actions-menu');
        if (!container || !moreDropdown || !moreMenu) return;

        // Capture original DOM order so spilled buttons can be restored when room returns.
        const originalOrder = Array.from(container.children);

        // Close the menu after a spilled button is clicked — its own onclick fires first,
        // this fires via bubble.
        moreMenu.addEventListener('click', e => {
            const btn = e.target.closest('.btn.overflow-spill');
            if (btn && !btn.disabled) {
                moreMenu.classList.add('hidden');
            }
        });

        // Hidden buttons (display:none) take no width — skip them when picking spill candidates.
        const isVisible = el => el && el.offsetParent !== null;

        let adjusting = false;
        function adjustOverflow() {
            if (adjusting) return;
            adjusting = true;

            // 1. Restore previously spilled buttons by re-appending every original child
            //    in capture order (appendChild moves existing nodes).
            for (const child of originalOrder) {
                if (child.classList.contains('overflow-spill')) {
                    child.classList.remove('overflow-spill');
                }
                container.appendChild(child);
            }

            // 2. Hide More for measurement — it's only shown if we actually need to spill.
            moreDropdown.classList.add('hidden');

            const fits = () => container.scrollWidth <= container.clientWidth + 1;

            // 3. If overflowing, show the More trigger and spill in priority order until fit.
            if (!fits()) {
                moreDropdown.classList.remove('hidden');
                for (const id of FOOTER_OVERFLOW_PRIORITY) {
                    if (fits()) break;
                    const btn = document.getElementById(id);
                    if (!btn || !isVisible(btn) || btn.parentElement === moreMenu) continue;
                    btn.classList.add('overflow-spill');
                    moreMenu.appendChild(btn);
                }
            }

            adjusting = false;
        }

        window._footerOverflowAdjust = adjustOverflow;

        // Observe the parent (.footer-content), not just the button container. When buttons
        // spill into the absolutely-positioned dropdown menu, the container's own width
        // collapses to its visible-children width — so widening the panel doesn't change
        // the container's size and RO never fires. Observing the parent (whose width tracks
        // the panel) reliably catches both shrink and expand.
        const ro = new ResizeObserver(() => requestAnimationFrame(adjustOverflow));
        ro.observe(container);
        const parent = container.parentElement;
        if (parent) ro.observe(parent);

        // Belt-and-suspenders: VS Code webview iframes sometimes deliver resize via window
        // rather than ResizeObserver. Cheap to add and covers panel-drag cases.
        window.addEventListener('resize', () => requestAnimationFrame(adjustOverflow));

        // Initial pass after layout settles
        requestAnimationFrame(adjustOverflow);
    }

    // Monaco Editor setup
    function updateMonacoEditorHeight() {
        if (!window.monacoEditor) return;

        const container = document.getElementById('monacoEditorContainer');
        // Issue #249: in fullscreen the container is sized by flex; manual height
        // calc would fight that and produce a flicker on every content change.
        if (container && container.closest('.editor-fullscreen')) {
            window.monacoEditor.layout();
            return;
        }
        const contentHeight = window.monacoEditor.getContentHeight();

        // Add padding for 3-4 extra lines (approximately 20px per line at 14px font)
        const extraPadding = 80; // ~4 lines of padding
        const minHeight = 200; // Minimum height for usability
        // Issue #249: cap editor at 60% of viewport so large bodies don't take over the page;
        // beyond this, Monaco's own vertical scrollbar handles overflow and find-widget reveal works.
        const maxHeight = Math.max(minHeight, Math.floor(window.innerHeight * 0.6));

        const adjustedHeight = Math.min(maxHeight, Math.max(minHeight, contentHeight + extraPadding));

        // Update container height
        container.style.height = `${adjustedHeight}px`;

        // Trigger Monaco layout update
        window.monacoEditor.layout();
    }

    // Theme change observer is handled by shared monaco-theme.js (setupMonacoThemeObserver)

    function setupMonacoEditor() {
        require(['vs/editor/editor.main'], function () {
            // Configure JSON language features - Disable built-in validation
            // We use our own validation that understands template variables like {{VAR}}
            // Monaco's built-in validation would show errors for template syntax
            monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
                validate: false,  // Disable Monaco's JSON validation (conflicts with template syntax)
                allowComments: true,  // Enable JSON comments support
                schemas: [],
                enableSchemaRequest: false,
                schemaRequest: 'ignore',
                schemaValidation: 'ignore'  // Ignore schema validation too
            });

            // Register JSONC language if not already registered
            // Monaco standalone doesn't have JSONC by default, only JSON
            const registeredLanguages = monaco.languages.getLanguages().map(l => l.id);

            if (!registeredLanguages.includes('jsonc')) {
                // Register JSONC as a language
                monaco.languages.register({ id: 'jsonc' });

                // Set language configuration for JSONC (comments, brackets, etc.)
                monaco.languages.setLanguageConfiguration('jsonc', {
                    comments: {
                        lineComment: '//',
                        blockComment: ['/*', '*/']
                    },
                    brackets: [
                        ['{', '}'],
                        ['[', ']']
                    ],
                    autoClosingPairs: [
                        { open: '{', close: '}' },
                        { open: '[', close: ']' },
                        { open: '"', close: '"', notIn: ['string'] }
                    ],
                    surroundingPairs: [
                        { open: '{', close: '}' },
                        { open: '[', close: ']' },
                        { open: '"', close: '"' }
                    ],
                    folding: {
                        markers: {
                            start: /^\s*\/\/\s*#?region\b/,
                            end: /^\s*\/\/\s*#?endregion\b/
                        }
                    }
                });
            }

            // Define custom Monaco theme from VS Code CSS variables
            defineVSCodeTheme();

            // Get Monaco Editor container element
            const monacoContainer = document.getElementById('monacoEditorContainer');

            // For new endpoints, use default template; for existing ones, populateEndpointData will set the value
            // Always start with empty template for all endpoints
            const initialValue = '';

            // Create Monaco Editor
            window.monacoEditor = monaco.editor.create(monacoContainer, {
                value: initialValue,
                language: 'jsonc',  // Use JSONC (JSON with Comments) language mode
                theme: 'vscode-current',
                stickyScroll: window.DBMN_STICKY_SCROLL,
                automaticLayout: true,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                lineNumbers: 'on',
                folding: true,
                selectOnLineNumbers: true,
                renderLineHighlight: 'none',
                scrollbar: {
                    // Issue #249: enable auto scrollbars so large bodies scroll within the editor
                    // (height is capped in updateMonacoEditorHeight) and find-widget reveal works.
                    vertical: 'auto',
                    horizontal: 'auto',
                    alwaysConsumeMouseWheel: false
                },
                overviewRulerLanes: 0,     // Hide overview ruler (right side markers)
                hideCursorInOverviewRuler: true,
                overviewRulerBorder: false,
                fontSize: 14,
                fontFamily: 'Consolas, Monaco, "Courier New", monospace',
                tabSize: 2,
                insertSpaces: true,
                detectIndentation: false,
                // Ensure suggestions work properly - GitHub Issue #128
                quickSuggestions: true,
                suggestOnTriggerCharacters: true,
                wordBasedSuggestions: 'off',  // Disable word-based suggestions to see only our custom ones
                snippetSuggestions: 'none',   // Disable snippet suggestions
                suggest: {
                    showWords: false,          // Don't show word suggestions
                    showSnippets: false        // Don't show snippet suggestions
                }
            });

            // Ensure the model language is set to jsonc (Monaco may default to plaintext)
            const model = window.monacoEditor.getModel();
            if (model && model.getLanguageId() !== 'jsonc') {
                monaco.editor.setModelLanguage(model, 'jsonc');
            }

            // Disable Monaco's built-in JSON/JSONC completions - we provide our own
            // This prevents duplicate suggestions from Monaco's language service
            if (monaco.languages.json && monaco.languages.json.jsonDefaults) {
                monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
                    validate: true,
                    allowComments: true,
                    schemas: [],
                    enableSchemaRequest: false
                });
                monaco.languages.json.jsonDefaults.setModeConfiguration({
                    documentFormattingEdits: true,
                    documentRangeFormattingEdits: true,
                    completionItems: false,  // Disable built-in completions
                    hovers: false,
                    documentSymbols: true,
                    tokens: true,
                    colors: true,
                    foldingRanges: true,
                    diagnostics: true,
                    selectionRanges: true
                });
            }

            // GitHub Issue #175: Register template completion provider for auto-complete
            if (window.TemplateCompletions && window.TemplateCompletions.registerCompletionProvider) {
                window.TemplateCompletions.registerCompletionProvider();
            }

            // Add Ctrl+/ keybinding to toggle line comments (like VS Code)
            // Use addAction for more reliable keybinding support in webviews
            window.monacoEditor.addAction({
                id: 'toggle-line-comment',
                label: 'Toggle Line Comment',
                keybindings: [
                    monaco.KeyMod.CtrlCmd | monaco.KeyCode.Slash,
                    monaco.KeyMod.CtrlCmd | monaco.KeyCode.US_SLASH
                ],
                run: function (editor) {
                    const action = editor.getAction('editor.action.commentLine');
                    if (action) {
                        action.run();
                    }
                }
            });

            // Add Ctrl+S keybinding to save endpoint
            window.monacoEditor.addAction({
                id: 'save-endpoint',
                label: 'Save Endpoint',
                keybindings: [
                    monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS
                ],
                run: function () {
                    saveEndpoint();
                }
            });

            // Register JSONC formatting provider that preserves comments
            monaco.languages.registerDocumentFormattingEditProvider('jsonc', {
                provideDocumentFormattingEdits: function (model, options, token) {
                    console.log('[FormatProvider] Called');
                    try {
                        const text = model.getValue();
                        console.log('[FormatProvider] Text length:', text.length);
                        console.log('[FormatProvider] jsoncParser available:', !!window.jsoncParser);

                        // Use JSONC parser if available (preserves comments)
                        if (window.jsoncParser) {
                            const edits = window.jsoncParser.format(text, undefined, {
                                tabSize: options.tabSize || 2,
                                insertSpaces: options.insertSpaces !== false,
                                eol: '\n'
                            });

                            console.log('[FormatProvider] Edits returned:', edits?.length || 0);
                            if (edits && edits.length > 0) {
                                console.log('[FormatProvider] First edit:', edits[0]);
                                return edits;
                            }
                        } else {
                            console.error('[FormatProvider] JSONC parser not available');
                        }

                        // Fallback: return empty to avoid errors
                        console.log('[FormatProvider] Returning empty edits');
                        return [];
                    } catch (error) {
                        console.error('[FormatProvider] Error:', error);
                        return [];
                    }
                }
            });

            // GitHub Issue #128: Completion provider is now in template-completions.js module
            // (Removed duplicate provider that was causing duplicate suggestions)

            // Add template variable decorations for {{VARIABLE}} syntax
            setupTemplateVariableDecorations();

            // Add comment decorations
            setupCommentDecorations();

            // Add change listener for form tracking
            window.monacoEditor.onDidChangeModelContent(() => {
                checkForChanges();
                updateTitle();

                // Update template variable decorations
                window.TemplateCompletions.updateDecorations();

                // Update comment decorations
                updateCommentDecorations();

                // Validate JSON after stripping comments
                validateJsonAfterCommentStripping();

                // Update editor height based on content
                updateMonacoEditorHeight();
            });

            // Listen for content size changes to adjust height
            window.monacoEditor.onDidContentSizeChange(() => {
                updateMonacoEditorHeight();
            });

            // Setup theme change observer (shared utility)
            setupMonacoThemeObserver();

            // Setup toolbar button handlers
            setupToolbarHandlers();

            // Setup full-window toggle (Issue #249)
            setupFullscreenToggle();

            // Setup responsive toolbar overflow → "More" menu (Issue #249)
            setupToolbarOverflow();

            // Setup cursor position listener for toolbar button state updates
            setupToolbarCursorListener();

            // Apply method-specific body rules
            updateSectionVisibility();

            // Check for pending endpoint body that was received before Monaco Editor was ready
            if (window.pendingEndpointBody !== undefined) {
                window.monacoEditor.setValue(window.pendingEndpointBody);

                window.pendingEndpointBody = undefined; // Clear the pending body

                // Reset change tracking after setting the body
                resetChangeTracking();

                // Re-evaluate section visibility + button label now that the
                // editor has content. updateSectionVisibility() ran at line
                // 4233 before setValue and hid the body for GET/DELETE; the
                // smart-run label (Run API vs Run Batch) similarly read
                // monaco's empty value during window.load and resolved to
                // "Run API" even for batch endpoints.
                updateSectionVisibility();
                updateButtonStates();
            } else if (typedBeforeEditorReady.size > 0) {
                // Typed into before the editor was ready (a slow machine, or the full e2e run):
                // the starting point is taken again, except for what the user typed, so that
                // stays unsaved and Save stays on. Re-taking it whole made the typing "no changes".
                rebaseExceptTyped();
            } else {
                // Reset change tracking after Monaco Editor is fully initialized
                resetChangeTracking();
            }

            // Issue #291: replay a paste that arrived before Monaco was ready.
            // Runs AFTER resetChangeTracking() so the clean baseline is the empty
            // form and the pasted content correctly registers as unsaved.
            if (window.pendingPastedEndpoint) {
                const pasted = window.pendingPastedEndpoint;
                window.pendingPastedEndpoint = undefined;
                handlePastedEndpointData(pasted);
            }

            // Initialize template variable decorations
            window.TemplateCompletions.updateDecorations();

            // Set initial height based on content
            updateMonacoEditorHeight();
        });
    }

    // Template variable decoration functions
    function setupTemplateVariableDecorations() {
        // Store current decorations to manage them
        window.templateVariableDecorations = [];
    }

    // Comment decoration functions
    function setupCommentDecorations() {
        // Store current comment decorations to manage them
        window.commentDecorations = [];
    }

    function updateCommentDecorations() {
        if (!window.monacoEditor) return;

        const model = window.monacoEditor.getModel();
        const text = model.getValue();
        const decorations = [];

        // Find single-line comments
        const singleLineRegex = /\/\/.*$/gm;
        let match;

        while ((match = singleLineRegex.exec(text)) !== null) {
            const matchStart = match.index;
            const matchEnd = matchStart + match[0].length;

            decorations.push({
                range: new monaco.Range(
                    model.getPositionAt(matchStart).lineNumber,
                    model.getPositionAt(matchStart).column,
                    model.getPositionAt(matchEnd).lineNumber,
                    model.getPositionAt(matchEnd).column
                ),
                options: {
                    inlineClassName: 'json-comment-single-line',
                    hoverMessage: { value: 'Comment' }
                }
            });
        }

        // Find multi-line comments
        const multiLineRegex = /\/\*[\s\S]*?\*\//g;
        while ((match = multiLineRegex.exec(text)) !== null) {
            const matchStart = match.index;
            const matchEnd = matchStart + match[0].length;

            decorations.push({
                range: new monaco.Range(
                    model.getPositionAt(matchStart).lineNumber,
                    model.getPositionAt(matchStart).column,
                    model.getPositionAt(matchEnd).lineNumber,
                    model.getPositionAt(matchEnd).column
                ),
                options: {
                    inlineClassName: 'json-comment-multi-line',
                    hoverMessage: { value: 'Multi-line comment' }
                }
            });
        }

        // Apply comment decorations (replace previous ones)
        window.commentDecorations = window.monacoEditor.deltaDecorations(
            window.commentDecorations || [],
            decorations
        );
    }

    /**
     * Find the position of a JSON parse error
     * GitHub Issue #128: Improved JSON error location detection
     */
    function findJsonErrorPosition(jsonText, errorMessage) {
        // Try to extract position from error message (format varies by browser)
        // Common formats: "at position 123", "at line 5 column 10", "position 123"
        const positionMatch = errorMessage.match(/position\s+(\d+)/i);
        if (positionMatch) {
            const position = parseInt(positionMatch[1], 10);
            return getLineColumnFromPosition(jsonText, position);
        }

        const lineColMatch = errorMessage.match(/line\s+(\d+)\s+column\s+(\d+)/i);
        if (lineColMatch) {
            return {
                line: parseInt(lineColMatch[1], 10),
                column: parseInt(lineColMatch[2], 10)
            };
        }

        // Fallback: Try to find common errors manually
        return findCommonJsonErrors(jsonText);
    }

    /**
     * Convert character position to line/column
     */
    function getLineColumnFromPosition(text, position) {
        const lines = text.substring(0, position).split('\n');
        return {
            line: lines.length,
            column: lines[lines.length - 1].length + 1
        };
    }

    /**
     * Find common JSON errors and their locations
     */
    function findCommonJsonErrors(text) {
        const lines = text.split('\n');

        // 1. Check for trailing commas
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.replace(/\/\/.*$/, '').trim(); // Remove comments

            // Trailing comma before } or ]
            if (trimmed.endsWith(',')) {
                // Check if next non-empty line starts with } or ]
                for (let j = i + 1; j < lines.length; j++) {
                    const nextTrimmed = lines[j].replace(/\/\/.*$/, '').trim();
                    if (nextTrimmed === '') continue;
                    if (nextTrimmed.startsWith('}') || nextTrimmed.startsWith(']')) {
                        return { line: i + 1, column: line.lastIndexOf(',') + 1, error: 'Trailing comma' };
                    }
                    break;
                }
            }
        }

        // 2. Check for mismatched brackets
        const stack = [];
        const brackets = { '{': '}', '[': ']' };
        let inString = false;
        let escape = false;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            for (let j = 0; j < line.length; j++) {
                const char = line[j];

                if (escape) {
                    escape = false;
                    continue;
                }

                if (char === '\\' && inString) {
                    escape = true;
                    continue;
                }

                if (char === '"') {
                    inString = !inString;
                    continue;
                }

                if (inString) continue;

                if (char === '{' || char === '[') {
                    stack.push({ char, line: i + 1, column: j + 1 });
                } else if (char === '}' || char === ']') {
                    if (stack.length === 0) {
                        return { line: i + 1, column: j + 1, error: `Unexpected '${char}'` };
                    }
                    const last = stack.pop();
                    if (brackets[last.char] !== char) {
                        return { line: i + 1, column: j + 1, error: `Expected '${brackets[last.char]}' but found '${char}'` };
                    }
                }
            }
        }

        // Unclosed bracket
        if (stack.length > 0) {
            const unclosed = stack[stack.length - 1];
            return { line: unclosed.line, column: unclosed.column, error: `Unclosed '${unclosed.char}'` };
        }

        // 3. Check for missing commas between properties
        for (let i = 0; i < lines.length - 1; i++) {
            const line = lines[i].replace(/\/\/.*$/, '').trim();
            const nextLine = lines[i + 1].replace(/\/\/.*$/, '').trim();

            // Line ends with value (string, number, etc.) and next line starts with quote
            if (line.match(/["}\]0-9]$/) && !line.endsWith(',') && nextLine.startsWith('"')) {
                return { line: i + 1, column: lines[i].length, error: 'Missing comma' };
            }
        }

        // Default: return first line
        return { line: 1, column: 1 };
    }

    /**
     * Find duplicate keys in JSON text
     * Returns array of { key, line, column } for each duplicate
     */
    function findDuplicateKeys(text) {
        const duplicates = [];
        const keysByLevel = [{}]; // Stack of key sets for nested objects
        let currentLevel = 0;
        let inString = false;
        let escapeNext = false;
        let currentKey = '';
        let keyStart = -1;
        let collectingKey = false;
        let line = 1;
        let column = 1;
        let keyLine = 1;
        let keyColumn = 1;

        for (let i = 0; i < text.length; i++) {
            const char = text[i];

            // Track line/column
            if (char === '\n') {
                line++;
                column = 1;
            } else {
                column++;
            }

            // Handle escape sequences
            if (escapeNext) {
                escapeNext = false;
                if (collectingKey) currentKey += char;
                continue;
            }

            if (char === '\\' && inString) {
                escapeNext = true;
                if (collectingKey) currentKey += char;
                continue;
            }

            // Handle string boundaries
            if (char === '"' && !escapeNext) {
                if (!inString) {
                    inString = true;
                    // Check if this could be a key (after { or ,)
                    let j = i - 1;
                    while (j >= 0 && /\s/.test(text[j])) j--;
                    if (j >= 0 && (text[j] === '{' || text[j] === ',')) {
                        collectingKey = true;
                        currentKey = '';
                        keyStart = i;
                        keyLine = line;
                        keyColumn = column - 1;
                    }
                } else {
                    inString = false;
                    if (collectingKey) {
                        // Check if followed by colon (confirming it's a key)
                        let j = i + 1;
                        while (j < text.length && /\s/.test(text[j])) j++;
                        if (text[j] === ':') {
                            // This is a key - check for duplicates at current level
                            if (keysByLevel[currentLevel][currentKey]) {
                                duplicates.push({
                                    key: currentKey,
                                    line: keyLine,
                                    column: keyColumn
                                });
                            } else {
                                keysByLevel[currentLevel][currentKey] = true;
                            }
                        }
                        collectingKey = false;
                    }
                }
                continue;
            }

            // Collect key characters
            if (inString && collectingKey) {
                currentKey += char;
                continue;
            }

            // Track nesting level
            if (!inString) {
                if (char === '{') {
                    currentLevel++;
                    keysByLevel[currentLevel] = {};
                } else if (char === '}') {
                    keysByLevel[currentLevel] = {};
                    currentLevel = Math.max(0, currentLevel - 1);
                } else if (char === '[') {
                    // Arrays don't have keys, but can contain objects
                } else if (char === ']') {
                    // End of array
                }
            }
        }

        return duplicates;
    }

    function validateJsonAfterCommentStripping() {
        if (!window.monacoEditor) return;

        const model = window.monacoEditor.getModel();
        const text = model.getValue();

        // Issue #251: Use unsafe stripper here — the safe variant returns the
        // ORIGINAL (with comments) when the stripped result is invalid JSON,
        // which makes JSON.parse blame the first `//` instead of the real error.
        const cleanJson = window.stripJsonComments ?
            window.stripJsonComments(text) : text;

        const markers = [];

        // Check for duplicate keys first (JSON.parse doesn't catch these)
        const duplicates = findDuplicateKeys(text);
        duplicates.forEach(dup => {
            markers.push({
                severity: monaco.MarkerSeverity.Error,
                startLineNumber: dup.line,
                startColumn: dup.column,
                endLineNumber: dup.line,
                endColumn: dup.column + dup.key.length + 2, // +2 for quotes
                message: `Duplicate key: "${dup.key}"`
            });
        });

        try {
            JSON.parse(cleanJson);
            // If we have duplicate key errors, show them
            if (markers.length > 0) {
                monaco.editor.setModelMarkers(model, 'json-validation', markers);
            } else {
                // Clear any existing error markers
                monaco.editor.setModelMarkers(model, 'json-validation', []);
                // Clear footer notification if it was showing a JSON error
                clearFooterNotification();
            }
        } catch (error) {
            const errorMessage = error.message;

            // Find the actual error position
            const errorPos = findJsonErrorPosition(cleanJson, errorMessage);

            // Map back to original text (account for comments)
            // For now, use the position directly - could be improved to map back
            let { line, column } = errorPos;
            const specificError = errorPos.error;

            // Create descriptive error message
            let displayMessage = specificError
                ? `JSON Error: ${specificError}`
                : `JSON Error: ${errorMessage}`;

            // Create error marker at the actual error location
            const markers = [{
                severity: monaco.MarkerSeverity.Error,
                startLineNumber: line,
                startColumn: column,
                endLineNumber: line,
                endColumn: column + 1,
                message: displayMessage
            }];

            monaco.editor.setModelMarkers(model, 'json-validation', markers);
        }
    }

    function formatJsonTemplate() {

        if (!window.monacoEditor) {
            console.error('[FormatJSON] Monaco editor not available');
            return;
        }

        try {
            // Get current content
            const currentValue = window.monacoEditor.getValue();

            // Issue #251: Use unsafe stripper so JSON.parse reports the real
            // error location instead of blaming the first `//` comment.
            const stripped = window.stripJsonComments ? window.stripJsonComments(currentValue) : currentValue;

            try {
                // Handle empty body gracefully (common for GET requests with query params)
                if (!stripped || stripped.trim() === '') {
                    console.log('[FormatJSON] Empty body - nothing to format');
                    return;
                }
                JSON.parse(stripped); // This will throw if invalid
            } catch (parseError) {
                console.error('[FormatJSON] JSON parsing failed:', parseError);
                // Show error feedback on button
                const formatJsonBtn = document.getElementById('formatJsonBtn');
                if (formatJsonBtn) {
                    const originalText = formatJsonBtn.textContent;
                    formatJsonBtn.textContent = '❌ Invalid JSON';
                    formatJsonBtn.style.backgroundColor = 'var(--vscode-errorForeground)';
                    setTimeout(() => {
                        formatJsonBtn.textContent = originalText;
                        formatJsonBtn.style.backgroundColor = '';
                    }, 2000);
                }
                // Show error details in footer notification
                const errorMessage = parseError.message || 'Invalid JSON syntax';
                showFooterNotification('error', `Format failed: ${errorMessage}`, { persistent: false });
                return;
            }


            if (!window.jsoncParser) {
                console.error('[FormatJSON] JSONC parser not available');
                return;
            }

            const edits = window.jsoncParser.format(currentValue, undefined, {
                tabSize: 2,
                insertSpaces: true,
                eol: '\n'
            });


            if (edits && edits.length > 0) {
                // Apply the edits using JSONC parser's applyEdits function
                const formatted = window.jsoncParser.applyEdits(currentValue, edits);

                // Use executeEdits instead of setValue to preserve undo history
                const model = window.monacoEditor.getModel();
                const fullRange = model.getFullModelRange();
                window.monacoEditor.executeEdits('format', [{
                    range: fullRange,
                    text: formatted
                }]);

                // Refresh decorations after formatting
                updateCommentDecorations();
                window.TemplateCompletions.updateDecorations();
                validateJsonAfterCommentStripping();
            }

        } catch (error) {
            console.error('[FormatJSON] Error formatting JSON:', error);
        }
    }

    function getTypeClassName(type) {
        const normalizedType = type.toLowerCase().trim();
        switch (normalizedType) {
            case 'string':
                return 'template-variable-type-string';
            case 'number':
            case 'int':
            case 'integer':
            case 'float':
            case 'decimal':
                return 'template-variable-type-number';
            case 'boolean':
            case 'bool':
                return 'template-variable-type-boolean';
            case 'date':
            case 'datetime':
            case 'timestamp':
                return 'template-variable-type-date';
            default:
                return 'template-variable-type-string'; // Default to string
        }
    }

    function validateJSONSyntax(jsonText) {
        const errorMessage = document.getElementById('jsonErrorMessage');
        const editorContainer = document.getElementById('monacoEditorContainer');

        if (!jsonText.trim()) {
            // Empty is valid
            if (editorContainer) {
                editorContainer.classList.remove('json-error', 'json-valid');
            }
            if (errorMessage) {
                errorMessage.classList.remove('show');
            }
            return { isValid: true };
        }

        try {
            // Issue #251: Use unsafe stripper so JSON.parse reports the real
            // error location instead of blaming the first `//` comment.
            const cleanJson = window.stripJsonComments ? window.stripJsonComments(jsonText) : jsonText;
            JSON.parse(cleanJson);

            // Check for duplicate keys (JSON.parse doesn't catch these)
            const duplicates = findDuplicateKeys(jsonText);
            if (duplicates.length > 0) {
                const firstDup = duplicates[0];
                if (editorContainer) {
                    editorContainer.classList.remove('json-valid');
                    editorContainer.classList.add('json-error');
                }
                if (errorMessage) {
                    errorMessage.textContent = `Duplicate key: "${firstDup.key}" on line ${firstDup.line}`;
                    errorMessage.classList.add('show');
                }
                return { isValid: false, error: `Duplicate key: "${firstDup.key}"` };
            }

            // Valid JSON
            if (editorContainer) {
                editorContainer.classList.remove('json-error');
                editorContainer.classList.add('json-valid');
            }
            if (errorMessage) {
                errorMessage.classList.remove('show');
            }
            return { isValid: true };
        } catch (error) {
            // Invalid JSON - Monaco Editor handles validation automatically, but we still update UI
            if (editorContainer) {
                editorContainer.classList.remove('json-valid');
                editorContainer.classList.add('json-error');
            }
            if (errorMessage) {
                errorMessage.textContent = `JSON Syntax Error: ${error.message}`;
                errorMessage.classList.add('show');
            }
            return { isValid: false, error: error.message };
        }
    }

    // Test preview results functions
    function clearTestPreviewResults() {
        const previewResults = document.getElementById('testPreviewResults');
        if (previewResults) {
            previewResults.style.display = 'none';
            previewResults.innerHTML = '';
            previewResults.className = 'test-preview-results';
        }
    }

    function showTestPreviewResults(result, errorMessage) {
        const previewResults = document.getElementById('testPreviewResults');
        if (!previewResults) return;

        previewResults.style.display = 'block';

        if (errorMessage) {
            // Show error state
            previewResults.className = 'test-preview-results error';
            previewResults.innerHTML = `
                <h4><span class="test-result-icon">❌</span>Test Preview Error</h4>
                <div>${errorMessage}</div>
            `;
            return;
        }

        if (result && result.length > 0) {
            const testResult = result[0]; // Single test result
            const isSuccess = testResult.success;

            previewResults.className = `test-preview-results ${isSuccess ? 'success' : 'error'}`;

            let html = `
                <h4>
                    <span class="test-result-icon">${isSuccess ? '✅' : '❌'}</span>
                    Test Preview Results
                </h4>
                <div>${isSuccess ? 'Test passed with sample data' : `Test failed: ${testResult.error}`}</div>
            `;

            // Add sample data section
            html += `
                <div class="sample-data">
                    <span class="sample-data-label">Sample Data Used:</span>
                    Response Status: 200
                    CSV Row: SKU=SAMPLE123, QUANTITY=10, LOCATION=LOC001
                    Response Data: {"success": true, "data": [{"id": "123", "name": "Sample Item"}]}
                </div>
            `;

            previewResults.innerHTML = html;
        }
    }

    // Unsaved Changes Management Functions
    function checkForUnsavedChangesBeforeRun() {
        // Force check for current changes
        checkForChanges();

        // If no endpoint ID (new endpoint), allow execution
        if (!currentEndpointId || isNewEndpoint) {
            return { canProceed: true };
        }

        // If there are unsaved changes, prevent execution
        if (hasUnsavedChanges) {
            return { canProceed: false, reason: 'unsaved_changes' };
        }

        return { canProceed: true };
    }

    function runEndpoint() {
        // Check for unsaved changes first
        const changeCheck = checkForUnsavedChangesBeforeRun();

        if (!changeCheck.canProceed) {
            // Show warning for unsaved changes
            if (changeCheck.reason === 'unsaved_changes') {
                vscode.postMessage({
                    type: 'showWarning',
                    message: 'You have unsaved changes. Please save the endpoint before running the API.'
                });
            }
            return;
        }

        // Proceed with endpoint execution
        if (currentEndpointId) {
            vscode.postMessage({
                type: 'runEndpoint',
                endpointId: currentEndpointId
            });
        } else {
            vscode.postMessage({
                type: 'showWarning',
                message: 'Please save the endpoint first before running it.'
            });
        }
    }

    function checkForUnsavedChangesBeforeDataLoading() {
        // Force check for current changes
        checkForChanges();

        // If no endpoint ID (new endpoint), require save first
        if (!currentEndpointId || isNewEndpoint) {
            return { canProceed: false, reason: 'no_endpoint_id' };
        }

        // If there are unsaved changes, prevent data loading
        if (hasUnsavedChanges) {
            return { canProceed: false, reason: 'unsaved_changes' };
        }

        return { canProceed: true };
    }

    // Message handling for backend communication
    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.type) {
            case 'sectionContentLoaded':
                // Render documentation modal with section content
                if (window.renderDocumentationModal) {
                    window.renderDocumentationModal(
                        message.title,
                        message.html,
                        message.docPath,
                        message.section
                    );
                }
                break;
        }
    });


    // Add Section Dropdown Functions

    /** Keep the Add button's chevron in sync with the menu state. The menu
     *  opens upward (CSS `bottom: 100%`), so chevron-up == "click to open",
     *  chevron-down == "menu open, click to close". */
    function syncAddSectionChevron() {
        const menu = document.getElementById('add-section-menu');
        const chevron = document.querySelector('#add-section-btn .add-icon');
        if (!menu || !chevron || !window.Icons) return;
        const open = !menu.classList.contains('hidden');
        window.Icons.setIcon(chevron, open ? 'chevron-down' : 'chevron-up');
    }

    function toggleAddSectionDropdown() {
        const menu = document.getElementById('add-section-menu');
        menu.classList.toggle('hidden');
        syncAddSectionChevron();
    }

    function addSection(sectionType) {
        // Hide the dropdown
        document.getElementById('add-section-menu').classList.add('hidden');
        syncAddSectionChevron();

        switch (sectionType) {
            case 'body':
                addRequestBody();
                break;
            case 'headers':
                addCustomHeader();
                break;
            case 'queryParams':
                addQueryParam();
                break;
            case 'tests':
                addTestsSection();
                break;
        }
    }

    function addRequestBody() {
        const method = document.getElementById('endpointMethod').value;
        const bodySection = document.getElementById('bodySection');
        const bodyNotSentIndicator = document.getElementById('bodyNotSentIndicator');

        // Mark that user explicitly added body section (GitHub Issue #164)
        bodyWasExplicitlyAdded = true;

        // Show body section
        if (bodySection) {
            bodySection.classList.remove('hidden');

            // Show "body not sent" indicator for GET/DELETE methods
            if (bodyNotSentIndicator) {
                if (method === 'GET' || method === 'DELETE') {
                    bodyNotSentIndicator.classList.remove('hidden');
                } else {
                    bodyNotSentIndicator.classList.add('hidden');
                }
            }

            // Scroll to the section
            bodySection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        // Trigger change detection
        checkForChanges();
        updateTitle();
    }

    function addCustomHeadersSection() {
        // Headers section is always visible now, just scroll to it
        const headersSection = document.getElementById('headersSection');
        if (headersSection) {
            headersSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    function addQueryParametersSection() {
        const querySection = document.getElementById('queryParamsSection');
        if (querySection) {
            querySection.style.display = 'block';
            querySection.classList.remove('collapsed');
            querySection.classList.add('content-section');
            querySection.setAttribute('data-user-added', 'true'); // Mark as explicitly added
            querySection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    function addTestsSection() {
        const testsSection = document.getElementById('testsSection');
        if (testsSection) {
            testsSection.classList.remove('hidden');
            testsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    // Close dropdown when clicking outside
    document.addEventListener('click', function (event) {
        const addDropdown = document.querySelector('.add-section-dropdown');
        const addMenu = document.getElementById('add-section-menu');

        if (addDropdown && !addDropdown.contains(event.target)) {
            addMenu.classList.add('hidden');
            syncAddSectionChevron();
        }

        // Also close More Actions dropdown when clicking outside (GitHub Issue #164)
        const moreDropdown = document.querySelector('.more-actions-dropdown');
        const moreMenu = document.getElementById('more-actions-menu');

        if (moreDropdown && !moreDropdown.contains(event.target)) {
            moreMenu.classList.add('hidden');
        }

    });

    // ==========================================
    // More Actions Dropdown (GitHub Issue #164)
    // Copy/Paste/Duplicate Endpoint Functions
    // ==========================================

    /**
     * Toggle the More Actions dropdown menu visibility
     */
    function toggleMoreActionsDropdown() {
        const menu = document.getElementById('more-actions-menu');
        menu.classList.toggle('hidden');

        // Update menu item states based on current endpoint state
        updateMoreActionsVisibility();
    }

    /**
     * Update footer button visibility based on endpoint state (new vs saved).
     * Duplicate / Delete are direct footer buttons (not menu items); the More dropdown
     * is now pure overflow destination, populated only by setupFooterOverflow when buttons
     * don't fit. Download Template visibility is owned by updateCreateTemplateVisibility().
     */
    function updateMoreActionsVisibility() {
        const pasteBtn = document.getElementById('pasteEndpointBtn');
        const duplicateBtn = document.getElementById('duplicateEndpointBtn');
        const deleteBtn = document.getElementById('deleteEndpointBtn');
        const shareBtn = document.getElementById('share-endpoint-btn');

        if (isNewEndpoint) {
            // New endpoint: only Paste is relevant; everything saved-only is hidden.
            pasteBtn?.classList.remove('hidden');
            duplicateBtn?.classList.add('hidden');
            deleteBtn?.classList.add('hidden');
            if (shareBtn) {
                shareBtn.disabled = true;
                shareBtn.title = 'Save the endpoint first, then Copy to Share puts it on the clipboard for a teammate';
            }
        } else {
            // Saved endpoint: hide Paste, show Duplicate/Delete, enable Share.
            pasteBtn?.classList.add('hidden');
            duplicateBtn?.classList.remove('hidden');
            deleteBtn?.classList.remove('hidden');
            if (shareBtn) {
                shareBtn.disabled = false;
                shareBtn.title = 'Copy this endpoint to the clipboard as a shareable card \u2014 paste it into Teams, email, or a new DBMN endpoint';
            }
        }

        // Visible-button set just changed; re-evaluate footer overflow.
        if (window._footerOverflowAdjust) {
            requestAnimationFrame(window._footerOverflowAdjust);
        }
    }

    /**
     * Copy endpoint to clipboard in rich HTML + plain text format for Teams/Outlook sharing.
     * Plain text stays identical to previous format for paste compatibility.
     */
    function copyToClipboard() {
        if (isNewEndpoint || !currentEndpointId) {
            vscode.postMessage({ type: 'showWarning', message: 'Save the endpoint before copying it to share' });
            return;
        }

        const data = collectCurrentEndpointData();

        // Build plain text as JSONC-comment metadata + body (GitHub Issue #188)
        let plainText = `// Name: ${data.name}\n`;
        plainText += `// Method: ${data.method}\n`;
        plainText += `// Path: ${data.path}\n`;
        if (data.description) {
            plainText += `// Description: ${data.description}\n`;
        }
        if (Array.isArray(data.tags) && data.tags.length > 0) {
            plainText += `// Tags: ${data.tags.join(', ')}\n`;
        }

        // Include endpoint-specific headers only — inherited environment headers
        // are excluded because they carry the sender's environment values
        // (auth tokens, host-specific config) which should not travel with a
        // shared endpoint. The recipient's active environment supplies its own.
        const endpointHeaderRows = document.querySelectorAll('#headersContainer .header-row:not(.inherited)');
        endpointHeaderRows.forEach(row => {
            const keyInput = row.querySelector('.header-key');
            const valueInput = row.querySelector('.header-value');
            const checkbox = row.querySelector('input[type="checkbox"]');
            if (keyInput && valueInput) {
                const key = keyInput.value.trim();
                if (key) {
                    const value = valueInput.value.trim();
                    const state = checkbox && !checkbox.checked ? 'disabled' : 'enabled';
                    plainText += `// Header: ${key}: ${value} [${state}]\n`;
                }
            }
        });

        // Include all query params from DOM (GitHub Issue #188)
        const allParamRows = document.querySelectorAll('#queryParamsContainer .param-row');
        allParamRows.forEach(row => {
            const keyInput = row.querySelector('.query-param-key');
            const valueInput = row.querySelector('.query-param-value');
            const checkbox = row.querySelector('input[type="checkbox"]');
            if (keyInput && valueInput) {
                const key = keyInput.value.trim();
                if (key) {
                    const value = valueInput.value.trim();
                    const state = checkbox && !checkbox.checked ? 'disabled' : 'enabled';
                    plainText += `// QueryParam: ${key}: ${value} [${state}]\n`;
                }
            }
        });

        const bodyContent = data.bodyWithComments || data.body;
        if (bodyContent) {
            plainText += `\n${bodyContent}\n`;
        }

        // Build rich HTML - pass plainText so the code block contains the full JSONC
        const html = buildEndpointHtml(plainText.trim());

        writeRichClipboard(html, plainText);
    }

    /**
     * Build styled HTML for endpoint clipboard copy.
     * Renders as a header bar + JSONC code block in Teams/Outlook/Confluence.
     */
    function buildEndpointHtml(jsoncBlock) {
        // Simplified HTML: header bar + JSONC code block + footer outside <pre> (GitHub Issue #188)
        return `<div style="font-family: Arial, sans-serif; font-size: 12px;">
            <p style="padding: 8px 12px; background-color: #0078d4; color: white; font-weight: bold; margin: 0; border-radius: 4px 4px 0 0; font-size: 12px;">DBMN Endpoint</p>
            <pre style="background: #f5f5f5; border: 1px solid #ddd; padding: 10px; font-family: Consolas, monospace; font-size: 11px; white-space: pre-wrap; word-wrap: break-word; margin: 0; border-radius: 0 0 4px 4px;"><code class="language-json">${escapeHtml(jsoncBlock)}</code></pre>
            <p style="color: #999; font-size: 10px; margin-top: 12px;">⚡ Dobermann | Paste &amp; test instantly → <a href="https://dbmn.io" style="color: #0078d4; text-decoration: none;">dbmn.io</a></p>
        </div>`;
    }

    /**
     * Write rich HTML + plain text to the clipboard. The Clipboard API, its
     * execCommand fallback and the plain-text last resort live in
     * shared/dbmn-clipboard.js — one implementation for every webview.
     */
    function writeRichClipboard(html, plainText) {
        window.DbmnClipboard.writeRich(html, plainText).then(ok => {
            if (ok) {
                showFooterNotification('info', 'Endpoint copied \u2014 paste it into Teams, email, or a new DBMN endpoint');
            } else {
                showFooterNotification('error', 'Failed to copy to clipboard');
            }
        });
    }

    /**
     * Paste endpoint data from clipboard (only for new endpoints)
     */
    function pasteFromClipboard() {
        if (!isNewEndpoint) {
            vscode.postMessage({ type: 'showWarning', message: 'Paste Endpoint only works on a new, unsaved endpoint' });
            return;
        }

        vscode.postMessage({ type: 'pasteEndpointFromClipboard' });
    }

    /**
     * Issue #291: Ctrl+V / Cmd+V into ANY field of an unsaved endpoint maps a
     * shared DBMN endpoint (Copy to Share output or a "DBMN Endpoint" card)
     * onto the form instead of dumping the text into one input. Only a cheap
     * shape check happens here — the real parse is the backend's
     * parseSharedEndpointText. Capture phase so Monaco's own paste handler
     * (bound on its hidden textarea) never sees the event.
     */
    function looksLikeSharedEndpointText(text) {
        if (!text) return false;
        const t = text.replace(/\u00A0/g, ' ');
        return /\/\/[ \t]+(?:Name|Method|Path):/.test(t) || /^\s*DBMN Endpoint\b/.test(t);
    }

    // The element the user pasted into, kept so the backend's "Paste as text"
    // answer (or a failed parse) can still deliver the clipboard there.
    let rawPasteTarget = null;

    document.addEventListener('paste', function (e) {
        const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
        if (!looksLikeSharedEndpointText(text)) return;
        e.preventDefault();
        e.stopPropagation();
        rawPasteTarget = document.activeElement;
        vscode.postMessage({
            type: 'pasteEndpointText',
            text: text,
            // Pristine draft → the backend maps immediately, no prompt.
            // Anything else has content to lose → the backend asks first.
            pristineDraft: isNewEndpoint && !hasUnsavedChanges,
            isNewEndpoint: isNewEndpoint
        });
    }, true);

    /**
     * Deliver intercepted clipboard text as ordinary text into the field the
     * user was in — the "Paste as text" branch of the Issue #291 prompt, and
     * the fallback when text only LOOKED like a shared endpoint.
     */
    function insertPastedTextRaw(text) {
        const el = rawPasteTarget;
        rawPasteTarget = null;
        if (!text) return;

        const monacoContainer = document.getElementById('monacoEditorContainer');
        if (window.monacoEditor && el && monacoContainer && monacoContainer.contains(el)) {
            const selection = window.monacoEditor.getSelection();
            window.monacoEditor.executeEdits('paste', [{ range: selection, text: text, forceMoveMarkers: true }]);
            window.monacoEditor.focus();
            return;
        }

        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && typeof el.setRangeText === 'function') {
            const start = el.selectionStart == null ? el.value.length : el.selectionStart;
            const end = el.selectionEnd == null ? el.value.length : el.selectionEnd;
            el.setRangeText(text, start, end, 'end');
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.focus();
            return;
        }

        if (el && el.isContentEditable) {
            el.focus();
            document.execCommand('insertText', false, text);
        }
    }

    /**
     * Duplicate the current endpoint (creates a copy with "COPY " prefix)
     */
    // GitHub Issue #230: Download Excel template from endpoint variables
    function downloadTemplate() {
        document.getElementById('more-actions-menu').classList.add('hidden');

        // GitHub Issue #241: backend silently ignores requests with no endpointId, and a
        // template built from unsaved variable text would diverge from the saved endpoint.
        // Surface the requirement clearly instead of dropping the click.
        if (isNewEndpoint || !currentEndpointId || hasUnsavedChanges) {
            showFooterNotification('warning', 'Save endpoint before downloading template', { persistent: false });
            return;
        }

        vscode.postMessage({
            type: 'createTemplateSave',
            format: 'excel',
            excelSafe: false,
            endpointId: currentEndpointId
        });
    }

    function duplicateEndpoint() {
        document.getElementById('more-actions-menu').classList.add('hidden');

        if (isNewEndpoint || !currentEndpointId) {
            vscode.postMessage({ type: 'showWarning', message: 'Save endpoint before duplicating' });
            return;
        }

        // Open the copy in a NEW tab. Mutating the current tab in place would
        // leave its key pointing at the original endpoint while the form edits
        // the copy — that desync caused wrong-tab Delete/focus behaviour.
        vscode.postMessage({
            type: 'duplicateEndpointAsTab',
            sourceEndpointId: currentEndpointId
        });
    }

    /**
     * Handle populateEndpointData for paste operation (GitHub Issue #164)
     * This is called when backend sends parsed clipboard data
     */
    function handlePastedEndpointData(endpoint) {
        if (!endpoint) return;

        // Issue #291: the Hub's "new from clipboard" flow fires the paste on the
        // iframe's ready signal, which lands BEFORE the async Monaco load. The
        // old code populated name/method/path and silently skipped the body
        // (no editor yet); Monaco's init then snapshotted the half-pasted form
        // as the clean baseline, leaving Save disabled. Park the paste and
        // replay it from setupMonacoEditor once the editor + clean snapshot exist.
        if (!window.monacoEditor) {
            window.pendingPastedEndpoint = endpoint;
            return;
        }

        // Populate form fields with pasted data
        if (endpoint.name) {
            document.getElementById('endpointName').value = endpoint.name;
        }
        if (endpoint.method) {
            document.getElementById('endpointMethod').value = endpoint.method.toUpperCase();
        }
        if (endpoint.path) {
            document.getElementById('endpointPath').value = endpoint.path;
        }
        if (endpoint.description) {
            document.getElementById('endpointDescription').value = endpoint.description;
        }
        if (Array.isArray(endpoint.tags) && endpoint.tags.length > 0) {
            // Pasting into an existing endpoint adds to its tags; the chip editor de-duplicates.
            setTagChipValues(getTagChipValues().concat(endpoint.tags));
        }
        if (endpoint.body) {
            window.monacoEditor.setValue(endpoint.body);
            // Show body section if body has content
            const bodySection = document.getElementById('bodySection');
            if (bodySection) {
                bodySection.classList.remove('hidden');
            }
        }

        // GitHub Issue #188: Detect missing headers and ask backend for confirmation
        let missingHeaders = [];
        if (endpoint.headers && Array.isArray(endpoint.headers)) {
            const existingKeys = new Set();
            document.querySelectorAll('#headersContainer .header-row').forEach(row => {
                const keyInput = row.querySelector('.header-key');
                if (keyInput && keyInput.value.trim()) {
                    existingKeys.add(keyInput.value.trim().toLowerCase());
                }
            });
            for (const header of endpoint.headers) {
                if (!existingKeys.has(header.key.toLowerCase())) {
                    missingHeaders.push(header);
                }
            }
        }

        // Populate query params — skip any that already exist (GitHub Issue #188)
        if (endpoint.queryParams && Array.isArray(endpoint.queryParams)) {
            const existingKeys = new Set();
            document.querySelectorAll('#queryParamsContainer .param-row').forEach(row => {
                const keyInput = row.querySelector('.query-param-key');
                if (keyInput && keyInput.value.trim()) {
                    existingKeys.add(keyInput.value.trim().toLowerCase());
                }
            });
            for (const param of endpoint.queryParams) {
                if (!existingKeys.has(param.key.toLowerCase())) {
                    addQueryParam(param.key, param.value, param.enabled);
                }
            }
        }

        // Update UI state
        rawPasteTarget = null;
        updateSectionVisibility();
        updatePageHeading();
        hasUnsavedChanges = true;
        updateButtonStates();
        updateTitle();

        // GitHub Issue #188: If missing headers found, ask backend for modal confirmation
        if (missingHeaders.length > 0) {
            vscode.postMessage({
                type: 'confirmPasteHeaders',
                missingHeaders: missingHeaders
            });
        } else {
            showFooterNotification('info', 'Endpoint data pasted successfully', { persistent: false });
        }
    }

    // ==========================================
    // Inherited Environment Headers (Issue #126)
    // ==========================================

    /**
     * Handle useEnvironmentHeaders toggle change
     * When checked: show inherited environment headers as disabled rows
     * When unchecked: remove inherited rows
     */
    function handleUseEnvironmentHeadersChange() {
        const isEnabled = document.getElementById('useEnvironmentHeaders')?.checked;

        if (isEnabled) {
            // Re-display inherited headers from stored environment data
            const env = window.currentActiveEnvironment;
            if (env) {
                displayInheritedHeaders(env.headers, env.variables);
            }
        } else {
            // Remove all inherited rows
            const container = document.getElementById('headersContainer');
            if (container) {
                container.querySelectorAll('.header-row.inherited').forEach(row => row.remove());
            }
        }

        checkForChanges();
        updateTitle();
    }

    /**
     * Display inherited environment headers as disabled rows in the headers container
     * Shows resolved values with variable indication
     */
    function displayInheritedHeaders(headers, variables) {
        const container = document.getElementById('headersContainer');
        if (!container) return;

        // Remove any existing inherited rows
        container.querySelectorAll('.header-row.inherited').forEach(row => row.remove());

        // Check if we should show inherited headers
        const useEnvHeaders = document.getElementById('useEnvironmentHeaders')?.checked;
        if (!useEnvHeaders) return;

        // Get variables from current environment if not passed
        const envVars = variables || (window.currentActiveEnvironment?.variables) || {};

        if (!headers || Object.keys(headers).length === 0) {
            return; // No environment headers to show
        }

        // Create inherited rows and insert at top of container
        const inheritedRows = [];
        Object.entries(headers).forEach(([name, config]) => {
            const isEnabled = typeof config === 'object' ? config.enabled !== false : true;
            const value = typeof config === 'object' ? config.value : config;

            if (isEnabled) {
                const div = document.createElement('div');
                div.className = 'header-row inherited';

                // Resolve variables in the value
                const resolvedValue = resolveVariablesInValue(value || '', envVars);
                const hasVariable = value && value.includes('{{');

                // Build tooltip
                let tooltip = 'From environment';
                if (hasVariable && resolvedValue !== value) {
                    tooltip = `From environment\nTemplate: ${value}\nResolved: ${resolvedValue}`;
                } else if (hasVariable) {
                    tooltip = `From environment\nVariable not set: ${value}`;
                }

                // No checkbox, just key/value inputs (disabled), no remove button
                div.innerHTML =
                    '<input type="text" class="header-key" value="' + escapeHtml(name) + '" disabled title="' + escapeHtml(tooltip) + '" />' +
                    '<input type="text" class="header-value" value="' + escapeHtml(resolvedValue) + '" disabled title="' + escapeHtml(tooltip) + '" />';

                inheritedRows.push(div);
            }
        });

        // Insert inherited rows at the top of the container
        const firstChild = container.firstChild;
        inheritedRows.forEach(row => {
            container.insertBefore(row, firstChild);
        });
    }

    /**
     * Resolve {{variable}} placeholders in a string using environment variables
     */
    function resolveVariablesInValue(value, variables) {
        if (!value || !variables) return value;

        return value.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
            return variables[varName] !== undefined ? variables[varName] : match;
        });
    }

    /**
     * Escape HTML for display
     */
    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Make functions globally available (the markup's actions below call them through window)
    window.saveEndpoint = saveEndpoint;
    window.deleteEndpoint = deleteEndpoint; // GitHub Issue #98
    window.deleteEndpointWithConfirm = deleteEndpointWithConfirm;
    window.runEndpoint = runEndpoint;
    window.switchTab = switchTab;
    window.updateSectionVisibility = updateSectionVisibility;
    // endpoint.html method <select> onchange calls this inline (global scope), so it must be exposed
    window.updatePageHeading = updatePageHeading;
    // endpoint.html "+" add-test button calls this inline (was the missing addTest())
    window.addTestScript = addTestScript;
    window.toggleSection = toggleSection;
    window.addCustomHeader = addCustomHeader;
    window.addQueryParam = addQueryParam;
    window.removeElement = removeElement;
    window.validateSingleTest = validateSingleTest;
    window.runTestsPreview = runTestsPreview;
    // New functions
    window.toggleAddSectionDropdown = toggleAddSectionDropdown;
    window.addSection = addSection;
    // GitHub Issue #164: Copy/Paste/Duplicate functions
    window.toggleMoreActionsDropdown = toggleMoreActionsDropdown;
    window.copyToClipboard = copyToClipboard;
    window.pasteFromClipboard = pasteFromClipboard;
    window.duplicateEndpoint = duplicateEndpoint;
    window.downloadTemplate = downloadTemplate; // GitHub Issue #241: was missing, broke onclick
    window.updateMoreActionsVisibility = updateMoreActionsVisibility;
    window.switchSampleTab = switchSampleTab;
    window.makeTestAPICall = makeTestAPICall;
    window.checkForUnsavedChangesBeforeRun = checkForUnsavedChangesBeforeRun;
    window.checkForUnsavedChangesBeforeDataLoading = checkForUnsavedChangesBeforeDataLoading;
    // Issue #126: useEnvironmentHeaders and inherited headers display
    window.handleUseEnvironmentHeadersChange = handleUseEnvironmentHeadersChange;
    window.displayInheritedHeaders = displayInheritedHeaders;
    window.checkForChanges = checkForChanges;

    // #372: what the markup may call (data-click / data-change); the web app's CSP refuses inline
    // handlers. Each resolves the global at click time, as the inline handlers did (form-manager.js
    // may replace saveEndpoint).
    window.DbmnActions.register({
        addCustomHeader: arg => window.addCustomHeader(arg),
        openTagManager: () => vscode.postMessage({ type: '__openTagManager__' }),
        addQueryParam: arg => window.addQueryParam(arg),
        addSection: arg => window.addSection(arg),
        addTestScript: arg => window.addTestScript(arg),
        clearFooterNotification: arg => window.clearFooterNotification(arg),
        copyToClipboard: arg => window.copyToClipboard(arg),
        deleteEndpointWithConfirm: arg => window.deleteEndpointWithConfirm(arg),
        downloadTemplate: arg => window.downloadTemplate(arg),
        duplicateEndpoint: arg => window.duplicateEndpoint(arg),
        handleUseEnvironmentHeadersChange: arg => window.handleUseEnvironmentHeadersChange(arg),
        makeTestAPICall: arg => window.makeTestAPICall(arg),
        pasteFromClipboard: arg => window.pasteFromClipboard(arg),
        runTestsPreview: arg => window.runTestsPreview(arg),
        saveEndpoint: arg => window.saveEndpoint(arg),
        switchSampleTab: arg => window.switchSampleTab(arg),
        toggleAddSectionDropdown: arg => window.toggleAddSectionDropdown(arg),
        toggleMoreActionsDropdown: arg => window.toggleMoreActionsDropdown(arg),
        validateSingleTest: arg => window.validateSingleTest(arg),
        methodChanged: () => { window.updateSectionVisibility(); window.updatePageHeading(); },
        removeRow: (_arg, _event, element) => window.removeElement(element.closest('.test-script-row') || element.parentElement)
    });
    window.updateTitle = updateTitle;

    // Variable prompt functions for runtime execution
    function checkForTemplateVariables() {
        const bodyValue = window.monacoEditor ? window.monacoEditor.getValue() : '';
        if (!bodyValue) {
            return [];
        }

        // Send a message to the backend to extract template variables
        return new Promise((resolve) => {
            const messageId = Date.now();
            window.variableCheckCallback = resolve;
            vscode.postMessage({
                type: 'extractTemplateVariables',
                template: bodyValue,
                messageId: messageId
            });
        });
    }




























    // Legacy JSON preview functions removed - now handled by CSV Handler module (GitHub Issue #98)

    // CSV Modal Message Handlers






    // Legacy CSV execution/display functions removed - now handled by CSV Handler and Run Batch modules (GitHub Issue #98)

    function handleCurrentEnvironmentData(message) {
        if (message.environment) {
            // Store the current environment data globally
            window.currentActiveEnvironment = message.environment;

            // Issue #126: Display inherited environment headers with variable resolution
            displayInheritedHeaders(
                message.environment.headers || null,
                message.environment.variables || null
            );

            // Re-validate template decorations now that ENV variables are available
            // This fixes the race condition where decorations were applied before environment loaded
            window.TemplateCompletions.updateDecorations();
        }
    }

    function handleWorkspaceValidationResult(message) {

        if (message.valid) {
            // Workspace is valid, proceed with generating JSON files
            generateBatchJsonFiles();
        } else {
            // Show error in VS Code (not just in modal)
            vscode.postMessage({
                type: 'showError',
                message: message.message || 'Workspace validation failed'
            });

            // Also show in modal for immediate feedback
            showCSVVerificationError(message.message || 'Workspace validation failed');
        }
    }

    // Legacy batch generation and modal functions removed - moved to Run Batch webview (GitHub Issue #98)

    // Legacy CSV modal navigation and validation functions removed - replaced by data-transformer.js (GitHub Issue #98)

    // Legacy column mapping functions removed - now handled by CSV Handler and Run Batch modules (GitHub Issue #98)

    function restoreArrayRepetitionSettings(repeatableArrays) {
        repeatableArrays.forEach(arrayConfig => {
            // Find the checkbox for this array path
            const arrayCheckbox = document.querySelector(`input[type="checkbox"][data-array-path="${arrayConfig.arrayPath}"]`);

            if (arrayCheckbox) {
                arrayCheckbox.checked = arrayConfig.enabled;

                // Find the corresponding max repetitions input
                const maxRepetitionsInput = arrayCheckbox.closest('.array-item').querySelector('.array-max-repetitions');
                if (maxRepetitionsInput) {
                    maxRepetitionsInput.value = arrayConfig.maxRepetitions;

                    // Enable/disable the input based on checkbox state
                    maxRepetitionsInput.disabled = !arrayConfig.enabled;
                }
            }
        });
    }

    // Initialize JWT headers for new endpoints (if no endpoint data was loaded)
    const endpointId = document.body.getAttribute('data-endpoint-id');
    if (!endpointId || endpointId === 'NEW' || endpointId === 'new') {
        // This is a new endpoint, initialize JWT headers
        populateJWTHeaders();
    }



    /**
     * Setup click handlers for dynamic button actions
     */
    // Wire the two run buttons. Run API always fires the extension's
    // executeAPIInBackground path — when the endpoint has template variables,
    // the parameter-collection service opens a DbmnModal to collect them.
    // Run Batch opens the CSV-driven flow. See updateButtonStates() for
    // visibility rules.
    function setupButtonClickHandlers() {
        var runApiBtn = document.getElementById('run-api-btn');
        if (runApiBtn) {
            runApiBtn.addEventListener('click', function() {
                executeAPIInBackground();
            });
        }

        var runBatchBtn = document.getElementById('run-batch-btn');
        if (runBatchBtn) {
            runBatchBtn.addEventListener('click', function() {
                openRunBatchWebview();
            });
        }

        // Handle Format JSON button clicks
        var formatJsonBtn = document.getElementById('formatJsonBtn');
        if (formatJsonBtn) {
            formatJsonBtn.addEventListener('click', function(e) {
                e.preventDefault();
                formatJsonTemplate();
            });
        }
    }

    /**
     * Execute API in background (new approach - stays on endpoint webview)
     */
    function executeAPIInBackground() {

        // Check for unsaved changes
        if (hasUnsavedChanges) {
            vscode.postMessage({
                type: 'showWarning',
                message: 'Please save your changes before running the API'
            });
            return;
        }

        if (!currentEndpointId || currentEndpointId === 'NEW') {
            vscode.postMessage({
                type: 'showWarning',
                message: 'Please save the endpoint first'
            });
            return;
        }

        // Send message to execute in background
        // Backend will automatically update button states when execution starts
        vscode.postMessage({
            type: 'executeAPIInBackground',
            endpointId: currentEndpointId
        });
    }



    /**
     * Show notification message
     */
    function showNotification(message, type = 'info') {

        // Create notification element
        const notification = document.createElement('div');
        notification.style.cssText = `
            position: fixed;
            top: 60px;
            right: 20px;
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            padding: 10px;
            border-radius: 3px;
            max-width: 300px;
            z-index: 1001;
            color: ${type === 'error' ? 'var(--vscode-errorForeground)' : 'var(--vscode-foreground)'};
        `;
        notification.textContent = message;
        document.body.appendChild(notification);

        // Notifications remain until manually dismissed
    }

})();

// `{{` in the path, a query parameter value or a header value: the environment's variables, the
// generated ones, and the run-time names this endpoint already uses (template-autocomplete.js)
(function () {
    if (!window.TemplateAutocomplete) return;
    const runTimeNames = () => {
        const texts = Array.from(document.querySelectorAll('#endpointPath, .query-param-value, .header-value')).map(i => i.value);
        if (window.monacoEditor) texts.push(window.monacoEditor.getValue());
        const names = new Set();
        for (const text of texts) {
            for (const m of String(text).matchAll(/\{\{\s*([A-Za-z_][\w.-]*)(?::[^}]*)?\s*\}\}/g)) {
                if (!/^(A8|ENV)$/i.test(m[1])) names.add(m[1]);
            }
        }
        return Array.from(names).sort().map(name => ({ value: name, detail: 'asked at run time, or a CSV column', group: 'This endpoint' }));
    };
    window.TemplateAutocomplete.attach({
        selector: '#endpointPath, .query-param-value, .header-value',
        suggestions: () => {
            const vars = (window.currentActiveEnvironment && window.currentActiveEnvironment.variables) || {};
            const env = Object.keys(vars).sort().map(name => ({ value: 'ENV:' + name, detail: String(vars[name] ?? ''), group: 'Environment' }));
            return env.concat(window.TemplateAutocomplete.GENERATED, runTimeNames());
        },
        empty: { Environment: 'No variables in the active environment' }
    });
}());
