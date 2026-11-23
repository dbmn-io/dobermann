// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * New lookup table: its name, then its columns (James, 2026-11-23: "first, prompt for name… name
 * columns. up to 5. each with a different name. eg, table is UOM, columns WMS, ERP, TMS, OMS").
 * Every column is equal: a lookup finds a value in any column and gives back any other.
 *
 *   const made = await LookupNew.ask({ taken: ['Regions', …] });   // the names other tables have
 *   if (made) post({ type: 'newLookup', name: made.name, columns: made.columns });
 *       → null when cancelled
 *
 * One dialog (DbmnModal): a name, and up to five column names. What is wrong is said under its
 * field and the dialog stays open: a name another table has, no column, two columns of one name.
 * The store refuses the same things (lookup-tables.ts), with the same words. Needs dbmn-modal.js.
 */
(function () {
    'use strict';
    if (window.LookupNew) return;

    /** The most columns, a name's and a column's longest: as the store keeps them. */
    const MAX_COLUMNS = 5;
    const NAME_MAX = 30;
    const COLUMN_MAX = 20;
    const EXAMPLES = ['WMS', 'ERP', 'TMS', 'OMS', ''];

    /** What is wrong with the answers, by field ({} when nothing is), and the table they make. */
    function check(fields, taken) {
        const errors = {};
        const name = String(fields.name || '').trim();
        if (!name) errors.name = 'The table needs a name';
        else if ((taken || []).some(t => String(t).trim().toLowerCase() === name.toLowerCase())) errors.name = `There's a lookup table called ${name} already`;
        const columns = [];
        const seen = new Map();
        for (let i = 0; i < MAX_COLUMNS; i++) {
            const column = String(fields['column' + i] || '').trim();
            if (!column) continue;
            const low = column.toLowerCase();
            if (seen.has(low)) errors['column' + i] = `Another column is called ${seen.get(low)}`;
            else seen.set(low, column);
            columns.push(column);
        }
        if (!columns.length) errors.column0 = 'At least one column';
        return { errors, table: { name, columns } };
    }

    /** Ask for a new table's name and columns. */
    function ask(opts) {
        const taken = (opts && opts.taken) || [];
        if (!window.DbmnModal) return Promise.resolve(null);
        let made = null;
        const fields = [{ id: 'name', type: 'text', label: 'Name', placeholder: 'UOM', autoFocus: true, validate: { required: true, maxLength: NAME_MAX, message: 'The table needs a name' } }]
            .concat(Array.from({ length: MAX_COLUMNS }, (_, i) => ({
                id: 'column' + i,
                type: 'text',
                label: i === 0 ? 'Columns: one for each system, up to 5' : '',
                placeholder: EXAMPLES[i] ? `Column ${i + 1}, e.g. ${EXAMPLES[i]}` : `Column ${i + 1}`,
                validate: { maxLength: COLUMN_MAX }
            })));
        return window.DbmnModal.show({
            title: 'New lookup table',
            body: 'Values that mean the same thing in different systems: a column for each. Any column can be looked up, and any other given back.',
            fields,
            actions: [
                { id: 'cancel', label: 'Cancel', variant: 'secondary' },
                { id: 'make', label: 'Make the table', variant: 'primary', awaitsHostSubmit: true }
            ],
            // (checked as Make is pressed: what is wrong is said under its field, and the dialog stays open)
            onHostSubmit: async (actionId, answers) => {
                const { errors, table } = check(answers, taken);
                if (Object.keys(errors).length) return { fieldErrors: errors };
                made = table;
                return undefined;
            }
        }).then(answer => (answer && answer.actionId === 'make' ? made || check(answer.fields || {}, taken).table : null));
    }

    window.LookupNew = { ask, check, MAX_COLUMNS, NAME_MAX, COLUMN_MAX };
})();
