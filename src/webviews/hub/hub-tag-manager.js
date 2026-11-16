// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
(function () {
    'use strict';

    /**
     * Hub Tag Manager — modal for renaming, merging, and deleting tags
     * across the endpoint collection.
     *
     * Flow:
     *   1. User clicks "Manage tags…" (catalogue popover) or "Manage Tags"
     *      (Hub Settings) → webview posts `openTagManager` to the host.
     *   2. Host returns `tagManagerData` with [{tag, count}, …].
     *   3. On first message after open, we open DbmnModal with a custom body
     *      (search input + table). Subsequent `tagManagerData` messages
     *      refresh the table in place (after rename/merge/delete fire host
     *      operations and rebroadcast).
     *
     * The modal stays open until the user clicks Close or the backdrop.
     */

    let host = null;
    let pendingOpen = false;
    let modalRoot = null;
    let modalHandle = null;
    let currentTags = [];
    let searchTerm = '';
    /** Tracks which row is in "merge" mode — shows a target picker for that row. */
    let mergePickerForTag = null;

    function init(hostApi) {
        host = hostApi;
    }

    function requestOpen() {
        pendingOpen = true;
        host.postMessage({ type: 'openTagManager' });
    }

    /**
     * Called by hub.js when a `tagManagerData` message arrives. If we asked to
     * open and the modal isn't already open, open it. Otherwise refresh the
     * table inside the open modal.
     */
    function onTagsData(tags) {
        currentTags = Array.isArray(tags) ? tags.slice() : [];
        if (pendingOpen && !modalHandle) {
            pendingOpen = false;
            openModal();
        } else if (modalRoot) {
            renderTable();
        }
    }

    function openModal() {
        if (!window.DbmnModal) {
            console.error('DbmnModal not available');
            return;
        }
        searchTerm = '';
        mergePickerForTag = null;
        modalRoot = buildBody();
        const promise = window.DbmnModal.show({
            title: 'Manage Tags',
            body: modalRoot,
            size: 'lg',
            dismissible: true,
            actions: [{ id: 'close', label: 'Close', variant: 'secondary' }]
        });
        modalHandle = promise;
        promise.finally(() => {
            modalRoot = null;
            modalHandle = null;
            mergePickerForTag = null;
        });
    }

    function buildBody() {
        const root = document.createElement('div');
        root.className = 'tag-manager';

        // Search input.
        const searchWrap = document.createElement('div');
        searchWrap.className = 'tag-manager-search';
        const search = document.createElement('input');
        search.type = 'search';
        search.placeholder = 'Search tags…';
        search.autocomplete = 'off';
        search.value = searchTerm;
        search.addEventListener('input', () => {
            searchTerm = search.value || '';
            renderTable();
        });
        searchWrap.appendChild(search);
        root.appendChild(searchWrap);

        // Table container — re-rendered on data updates / search changes.
        const tableHost = document.createElement('div');
        tableHost.className = 'tag-manager-table-host';
        tableHost.id = 'tagManagerTableHost';
        root.appendChild(tableHost);

        renderTable(root);
        return root;
    }

    function renderTable(rootArg) {
        const root = rootArg || modalRoot;
        if (!root) return;
        const tableHost = root.querySelector('.tag-manager-table-host');
        if (!tableHost) return;
        tableHost.innerHTML = '';

        const term = (searchTerm || '').trim().toLowerCase();
        const rows = currentTags.filter(r => !term || r.tag.includes(term));

        if (rows.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'tag-manager-empty';
            empty.textContent = term
                ? 'No matching tags.'
                : 'No tags yet. Add tags from the endpoint editor.';
            tableHost.appendChild(empty);
            return;
        }

        const table = document.createElement('table');
        table.className = 'tag-manager-table';
        const thead = document.createElement('thead');
        thead.innerHTML = '<tr><th>Tag</th><th class="num">Count</th><th>Actions</th></tr>';
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        rows.forEach(({ tag, count }) => tbody.appendChild(buildRow(tag, count)));
        table.appendChild(tbody);
        tableHost.appendChild(table);
    }

    function buildRow(tag, count) {
        const tr = document.createElement('tr');

        // Tag cell (editable on rename).
        const tagCell = document.createElement('td');
        tagCell.className = 'tag-manager-tag';
        tagCell.textContent = tag;
        tr.appendChild(tagCell);

        // Count cell.
        const countCell = document.createElement('td');
        countCell.className = 'tag-manager-count';
        countCell.textContent = String(count);
        tr.appendChild(countCell);

        // Actions cell.
        const actionsCell = document.createElement('td');
        actionsCell.className = 'tag-manager-actions';

        const renameBtn = document.createElement('button');
        renameBtn.type = 'button';
        renameBtn.className = 'tag-manager-action';
        renameBtn.textContent = 'Rename';
        renameBtn.addEventListener('click', () => startRename(tr, tag));
        actionsCell.appendChild(renameBtn);

        const mergeBtn = document.createElement('button');
        mergeBtn.type = 'button';
        mergeBtn.className = 'tag-manager-action';
        mergeBtn.textContent = mergePickerForTag === tag ? 'Cancel' : 'Merge…';
        mergeBtn.addEventListener('click', () => {
            mergePickerForTag = mergePickerForTag === tag ? null : tag;
            renderTable();
        });
        actionsCell.appendChild(mergeBtn);

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'tag-manager-action tag-manager-action-danger';
        deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', () => confirmDelete(tag, count));
        actionsCell.appendChild(deleteBtn);

        tr.appendChild(actionsCell);

        // If this row is the merge source, render an inline target picker as
        // a second row below it.
        if (mergePickerForTag === tag) {
            const pickerRow = buildMergePicker(tag);
            // Returning two trs from a single function is annoying; tack it on
            // by replacing the return value's parent — done by the caller via
            // a fragment trick. Use the next sibling pattern instead: render
            // into the tbody manually.
            requestAnimationFrame(() => {
                if (tr.parentNode && !tr.nextSibling?.classList?.contains?.('tag-manager-merge-row')) {
                    tr.parentNode.insertBefore(pickerRow, tr.nextSibling);
                }
            });
        }
        return tr;
    }

    function buildMergePicker(sourceTag) {
        const tr = document.createElement('tr');
        tr.className = 'tag-manager-merge-row';
        const td = document.createElement('td');
        td.colSpan = 3;
        td.className = 'tag-manager-merge-cell';

        const label = document.createElement('span');
        label.textContent = 'Merge into:';
        td.appendChild(label);

        const select = document.createElement('select');
        select.className = 'tag-manager-merge-select';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = '— pick target tag —';
        select.appendChild(placeholder);
        currentTags
            .filter(r => r.tag !== sourceTag)
            .forEach(r => {
                const opt = document.createElement('option');
                opt.value = r.tag;
                opt.textContent = `${r.tag} (${r.count})`;
                select.appendChild(opt);
            });
        td.appendChild(select);

        const confirm = document.createElement('button');
        confirm.type = 'button';
        confirm.className = 'btn btn-primary tag-manager-merge-confirm';
        confirm.textContent = 'Merge';
        confirm.addEventListener('click', () => {
            const target = select.value;
            if (!target) return;
            host.postMessage({
                type: 'tagMerge',
                sources: [sourceTag],
                target
            });
            mergePickerForTag = null;
        });
        td.appendChild(confirm);

        tr.appendChild(td);
        return tr;
    }

    function startRename(tr, tag) {
        const tagCell = tr.querySelector('.tag-manager-tag');
        if (!tagCell) return;
        tagCell.innerHTML = '';
        const input = document.createElement('input');
        input.type = 'text';
        input.value = tag;
        input.className = 'tag-manager-rename-input';
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                commitRename(tag, input.value);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                renderTable();
            }
        });
        input.addEventListener('blur', () => commitRename(tag, input.value));
        tagCell.appendChild(input);
        setTimeout(() => { input.focus(); input.select(); }, 0);
    }

    function commitRename(from, to) {
        const trimmed = (to || '').trim().toLowerCase();
        if (!trimmed || trimmed === from) {
            renderTable();
            return;
        }
        host.postMessage({ type: 'tagRename', from, to: trimmed });
    }

    function confirmDelete(tag, count) {
        if (!window.DbmnModal) {
            host.postMessage({ type: 'tagDelete', tag });
            return;
        }
        window.DbmnModal.confirm({
            title: 'Delete tag?',
            body: `Remove "${tag}" from ${count} endpoint${count === 1 ? '' : 's'}? The endpoints themselves stay.`,
            confirmLabel: 'Delete',
            confirmVariant: 'danger'
        }).then(ok => {
            if (ok) host.postMessage({ type: 'tagDelete', tag });
        });
    }

    window.HubTagManager = {
        init: init,
        requestOpen: requestOpen,
        onTagsData: onTagsData
    };
})();
