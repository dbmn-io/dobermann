// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The design system's page: what DBMN's screens are built from, each piece drawn live from the
 * same files the screens load, in the theme the app is wearing. Opened from the layers button in
 * the Hub's header: Settings → UI → Design system turns the button on, and a development build
 * has it on from the start.
 *
 * It is the reference for anyone building or changing a screen: the principles, where logic
 * lives, the colours, the icons, and every shared component with the markup to use it. A new
 * shared component is added here in the same piece of work (src/webviews/design-system).
 *
 * No controller: the page shows components and holds no data of its own.
 */
import type { AssetUrl } from '../pages';
import { sharedStyleLinks } from '../pages';

export function buildDesignSystemPage(asset: AssetUrl): string {
    const script = (rel: string) => `<script src="${asset(rel)}"></script>`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Design system</title>
    ${sharedStyleLinks(asset, ['atomic', 'core', 'buttons', 'modals', 'tables', 'tabs', 'toast', 'console', 'data-transformer', 'compare', 'column-drag', 'column-head', 'query', 'dbmn-footer', 'dbmn-table', 'dbmn-log'])}
    <link rel="stylesheet" href="${asset('design-system/design-system.css')}">
</head>
<body class="editor-slide-in ds-page">
    ${script('shared/button-contrast.js')}
    ${script('shared/dbmn-actions.js')}

    <header class="ds-top">
        <h1>Design system</h1>
        <p class="ds-lead">What DBMN's screens are built from. Every piece here is the real one, loaded from the files the screens load and drawn in the theme you are wearing. Build a new screen from these; if a piece is missing, add it here first.</p>
        <nav class="ds-nav" aria-label="Sections">
            <a href="#principles">Principles</a>
            <a href="#layers">Where things live</a>
            <a href="#components">Components</a>
            <a href="#moving">Moving over</a>
            <a href="#hub">The Hub</a>
            <a href="#screen">A screen</a>
            <a href="#theme">Theme and colours</a>
            <a href="#footer">Footer</a>
            <a href="#buttons">Buttons</a>
            <a href="#icons">Icons</a>
            <a href="#dialogs">Dialogs and messages</a>
            <a href="#tables">Tables</a>
            <a href="#logs">Logs</a>
            <a href="#adding">Adding a component</a>
        </nav>
    </header>

    <section class="ds-section" id="principles">
        <h2>Principles</h2>
        <ol class="ds-rules">
            <li><strong>The data gets the space.</strong> A screen owns one bar, its footer. Nothing sits between the Hub's tabs and the work.</li>
            <li><strong>One place for each job.</strong> Footer left: what you can do. Footer right: how far along you are. They never swap.</li>
            <li><strong>One component for each job.</strong> If a component here does the job, use it. A screen never draws its own version.</li>
            <li><strong>Components only draw.</strong> They show what they are given and report what was clicked. Deciding belongs to the screen's controller.</li>
            <li><strong>The theme owns every colour.</strong> Components use the theme's colours by name, never a colour of their own, so every theme works.</li>
            <li><strong>Plain and short.</strong> Labels say what happens ("Next: Columns"). Shape, not colour alone, carries meaning.</li>
            <li><strong>The same in every host.</strong> VS Code, the web app and the desktop app load the same files.</li>
        </ol>
    </section>

    <section class="ds-section" id="layers">
        <h2>Where things live</h2>
        <p>Four layers. Each knows only the one under it.</p>
        <div class="ds-layers" role="img" aria-label="Controller, then screen script, then components, then shared styles and theme">
            <div class="ds-layer">
                <span class="ds-layer-name">Controller</span>
                <span class="ds-layer-where">src/screens/&lt;screen&gt;/*.controller.ts</span>
                <span class="ds-layer-says">All business logic: reads and saves data, decides which step is open, what a button does. Knows nothing of the page's markup.</span>
            </div>
            <div class="ds-layer-link">messages, both ways</div>
            <div class="ds-layer">
                <span class="ds-layer-name">Screen script</span>
                <span class="ds-layer-where">src/webviews/&lt;screen&gt;/*.js</span>
                <span class="ds-layer-says">Passes messages on: gives components what the controller said, tells the controller what was clicked. No rules of its own.</span>
            </div>
            <div class="ds-layer-link">properties in, events out</div>
            <div class="ds-layer is-here">
                <span class="ds-layer-name">Components</span>
                <span class="ds-layer-where">src/webviews/shared/dbmn-*.js</span>
                <span class="ds-layer-says">Draw and report clicks. The same element on every screen. No data, no decisions, no colours of their own.</span>
            </div>
            <div class="ds-layer-link">class names and colour names</div>
            <div class="ds-layer">
                <span class="ds-layer-name">Shared styles and theme</span>
                <span class="ds-layer-where">src/webviews/shared/*.css · the theme's colours, as <code>--dbmn-*</code></span>
                <span class="ds-layer-says">How everything looks. Change the theme and every component follows, with no component changed.</span>
            </div>
        </div>
        <p class="form-hint">Components are custom elements that draw in the page itself (no shadow root), so the shared styles, the theme, help mode and named actions (<code>data-click</code>) reach inside them as they reach anything else.</p>
    </section>

    <section class="ds-section" id="components">
        <h2>Components</h2>
        <p>Every reusable piece, and where it stands. Use the ones marked Component or Shared module as they are. Search this list before writing anything new.</p>
        <p class="ds-legend"><span class="ds-chip is-component">Component</span> a custom element: use the tag. <span class="ds-chip">Shared module</span> shared and safe to use, called from script; it becomes a component when next worked on. <span class="ds-chip">Shared styles</span> class names only. <span class="ds-chip is-leaving">Being replaced</span> do not use in anything new. <span class="ds-chip is-planned">Planned</span> not built yet.</p>
        <!-- The list is itself the table component: search it, sort it, move its columns -->
        <dbmn-table id="dsInventory" class="ds-inventory" label="Components" searchable placeholder="Search the pieces, or @state=component"></dbmn-table>
    </section>

    <section class="ds-section" id="moving">
        <h2>Moving the screens over</h2>
        <p>Which screen is on which component, and what is left. A screen moves when it is next worked on, not all at once. Update the row in the same piece of work.</p>
        <p class="ds-legend"><span class="ds-chip is-component">On it</span> uses the component. <span class="ds-chip is-leaving">To move</span> the component is ready; the screen still has its own. <span class="ds-chip is-planned">Waits</span> the component needs something first.</p>
        <dbmn-table id="dsMoving" class="ds-inventory" label="Screens and components" searchable placeholder="Search, or @screen=console"></dbmn-table>
    </section>

    <section class="ds-section" id="hub">
        <h2>The Hub <span class="ds-chip is-planned">To be written</span></h2>
        <p>The frame every screen sits in. These pieces exist and work, but are not yet described here or split into components. Each gets its own entry, with its rules, as it is next worked on.</p>
        <div class="ds-anatomy ds-hub" role="img" aria-label="The Hub: a banner across the top, a menu down the left, a list beside it, and tabs holding the screens">
            <div class="ds-anatomy-row">Banner <span>logo, the environment in use, activity, design system, theme, help</span></div>
            <div class="ds-hub-body">
                <div class="ds-hub-rail">Menu <span>the sections</span></div>
                <div class="ds-hub-list">List <span>endpoints, environments, history, reporting: search, select, open</span></div>
                <div class="ds-hub-main">
                    <div class="ds-anatomy-row">Tabs <span>one per open screen; its name, its state, close</span></div>
                    <div class="ds-hub-screen">A screen <span>described below</span></div>
                </div>
            </div>
        </div>
        <ul class="ds-rules ds-todo">
            <li><strong>Banner:</strong> what belongs in it, and the order of its buttons.</li>
            <li><strong>Menu:</strong> an item, its icon and badge, collapsed and open.</li>
            <li><strong>List:</strong> a row, the search box and its signs, select mode and bulk actions, the add row.</li>
            <li><strong>Tabs:</strong> icon, name, status, unsaved mark, preview, rename.</li>
            <li><strong>Home and Settings:</strong> cards, panels, a setting's row and its toggle.</li>
        </ul>
    </section>

    <section class="ds-section" id="screen">
        <h2>A screen</h2>
        <div class="ds-anatomy" role="img" aria-label="Banner, tabs, the work, then the footer with actions left and progress right">
            <div class="ds-anatomy-row is-hub">Banner <span>the Hub's</span></div>
            <div class="ds-anatomy-row is-hub">Tabs <span>the Hub's: a tab is a screen, its name is the tab</span></div>
            <div class="ds-anatomy-row is-work">The work <span>everything between is the screen's data</span></div>
            <div class="ds-anatomy-row is-foot"><span class="ds-anatomy-cell">Actions <span>what you can do</span></span><span class="ds-anatomy-cell">Progress <span>how far along</span></span></div>
        </div>
    </section>

    <section class="ds-section" id="theme">
        <h2>Theme and colours</h2>
        <p>The app wears one theme at a time and this page follows it. Change it and look again: nothing here should break.</p>
        <p><button type="button" class="btn btn-secondary" id="dsThemeBtn" data-click="ds:theme">Change theme</button> <span class="form-hint" id="dsThemeNote"></span></p>
        <p>Theming is VS Code's: a theme gives its colours as <code>--vscode-…</code> names in every host, and that does not change. Components use the same colours under DBMN's prefix: <code>--dbmn-foreground</code> is <code>--vscode-foreground</code>, and so on for every colour the app uses (the list is at the top of <code>shared/atomic.css</code>). Never a colour value in a component. These are the ones used most:</p>
        <div class="ds-swatches" id="dsSwatches"></div>
    </section>

    <section class="ds-section" id="footer">
        <h2>Footer <span class="ds-chip is-component">Component</span></h2>
        <p>Every main screen ends in this footer. Left: standard buttons, the main one last. Right: one box, one height, showing how far along: steps when the tasks are yours, a progress bar when they are the system's, or a few words. One of them at a time.</p>

        <h3>Steps</h3>
        <p>Try it: Next walks on and the highlight slides to the step that takes over; a finished step takes you back. On the last step the results are worked out, then the steps shrink away behind a summary of what is on screen. Click the summary for the steps.</p>
        <div class="ds-demo">
            <dbmn-footer inline id="dsWizard">
                <dbmn-actions>
                    <button type="button" class="btn btn-secondary" id="dsBack" data-click="ds:back">Back</button>
                    <button type="button" class="btn btn-primary" id="dsNext" data-click="ds:next">Next</button>
                </dbmn-actions>
                <dbmn-steps id="dsSteps" label="Query steps"></dbmn-steps>
            </dbmn-footer>
        </div>
        <pre class="ds-code"><code>&lt;dbmn-footer&gt;
    &lt;dbmn-actions&gt;
        &lt;button class="btn btn-secondary" data-click="query:back"&gt;Back&lt;/button&gt;
        &lt;button class="btn btn-primary" data-click="query:next"&gt;Next: Columns&lt;/button&gt;
    &lt;/dbmn-actions&gt;
    &lt;dbmn-steps id="steps" label="Query steps"&gt;&lt;/dbmn-steps&gt;
&lt;/dbmn-footer&gt;

steps.steps = [{ label: 'Views' }, { label: 'Join' }, { label: 'Columns' }, { label: 'Results' }];
steps.render(states, current);            // what the controller said
steps.addEventListener('dbmn-step', e =&gt; post({ type: 'query.step', step: e.detail.step }));

steps.summary = ['3 views', '19 columns', '412 of 5,310 rows'];
steps.folded = true;                      // the last step: steps fold into the summary</code></pre>

        <h3>A step that is working</h3>
        <p>Its number turns into a spinner and Next waits. No bar and no count: a progress bar and steps never show together.</p>
        <div class="ds-demo">
            <dbmn-footer inline>
                <dbmn-actions>
                    <button type="button" class="btn btn-secondary">Back</button>
                    <button type="button" class="btn btn-primary" disabled>Next: Review</button>
                </dbmn-actions>
                <dbmn-steps id="dsWorking" label="Run Batch steps"></dbmn-steps>
            </dbmn-footer>
        </div>

        <h3>Progress</h3>
        <p>The system's tasks: the box is the bar. One line says what is happening, how far it has got and the one time that matters now: how long is left while it runs, how long it took once it is done. The rest (how many threads, rows per request, when it started, how fast, how many failed) is a click on the box away, or a hover. What the user may change while it runs is there too: threads as a button for each choice (one the environment does not allow is switched off), and stop on next error as a switch (while a batch runs it is the next error that stops it, not the first).</p>
        <div class="ds-demo">
            <dbmn-footer inline>
                <dbmn-actions>
                    <button type="button" class="btn btn-secondary" data-click="ds:run">Run again</button>
                    <button type="button" class="btn btn-primary">Pause</button>
                </dbmn-actions>
                <dbmn-progress id="dsProgress" phase="Executing" count="91 of 501" note="&lt;1m left" value="18"></dbmn-progress>
            </dbmn-footer>
        </div>
        <pre class="ds-code"><code>&lt;dbmn-progress phase="Loading input rows" count="82,000 of 100,010" note="1s" value="82"&gt;&lt;/dbmn-progress&gt;
&lt;dbmn-progress phase="Executing" count="91 of 501" note="&amp;lt;1m left" value="18"&gt;&lt;/dbmn-progress&gt;
&lt;dbmn-progress phase="Done" count="501" note="took 2m 14s" value="100" tone="ok"&gt;&lt;/dbmn-progress&gt;   tone: ok, warn, error
&lt;dbmn-progress phase="Fetching" busy&gt;&lt;/dbmn-progress&gt;          no figure yet

progress.stats = [{ id: 'threads', label: 'Threads', value: 8, options: [1, 2, 4, 8, 16], max: 8 },   a figure the user may change: 16 is over this environment's limit, so it is switched off
                  { id: 'stopOnError', label: 'Stop on next error', value: false },                    true or false: a switch
                  { label: 'Rows per request', value: '100' }, { label: 'Taken', value: '13s' }, { label: 'Failed', value: '3' }];
                                                             a click on the box lists them
progress.addEventListener('dbmn-progress-change', e =&gt; post({ type: 'console.setThreads', value: e.detail.value }));
                                                             the box only asks: the controller keeps the limit and answers with new stats</code></pre>

        <h3>Status</h3>
        <p>An editor has no steps and no run: a few words.</p>
        <div class="ds-demo">
            <dbmn-footer inline>
                <dbmn-actions>
                    <button type="button" class="btn btn-secondary btn-danger">Delete</button>
                    <button type="button" class="btn btn-primary">Save</button>
                </dbmn-actions>
                <dbmn-status tone="warn">Not saved yet</dbmn-status>
            </dbmn-footer>
        </div>
        <pre class="ds-code"><code>&lt;dbmn-status tone="ok"&gt;Saved&lt;/dbmn-status&gt;       tone: ok, warn, error, or none</code></pre>
    </section>

    <section class="ds-section" id="buttons">
        <h2>Buttons <span class="ds-chip">Shared styles</span></h2>
        <p>One size everywhere. One primary button in a group, last. Red only for what cannot be undone.</p>
        <div class="ds-demo ds-row">
            <button type="button" class="btn btn-secondary">Secondary</button>
            <button type="button" class="btn btn-primary">Primary</button>
            <button type="button" class="btn btn-secondary btn-danger">Delete</button>
            <button type="button" class="btn btn-primary" disabled>Disabled</button>
            <button type="button" class="compare-tool-btn icon" data-icon="download" title="Export to Excel" aria-label="Export to Excel"></button>
        </div>
        <pre class="ds-code"><code>&lt;button class="btn btn-primary" data-click="saveEndpoint"&gt;Save&lt;/button&gt;
&lt;button class="btn btn-secondary"&gt;…   &lt;button class="btn btn-secondary btn-danger"&gt;…
&lt;button class="compare-tool-btn icon" data-icon="download" title="Export to Excel" aria-label="Export to Excel"&gt;&lt;/button&gt;

DbmnActions.register({ saveEndpoint });     never an inline click handler: the web app refuses it</code></pre>
    </section>

    <section class="ds-section" id="icons">
        <h2>Icons <span class="ds-chip">Shared module</span></h2>
        <p>Every icon comes from one list, <code>shared/icons.js</code>, drawn from <a href="https://lucide.dev/icons" target="_blank" rel="noopener">Lucide</a> (24 by 24, stroked, the text's colour). To use a new one, copy its Lucide paths into that list under Lucide's own name. Never paste an SVG into a screen, and never use an emoji as an icon.</p>
        <pre class="ds-code"><code>&lt;span class="icon" data-icon="download"&gt;&lt;/span&gt;      then Icons.injectIcons(parent)
Icons.setIcon(element, 'chevron-right')
Icons.icon('check')                                   the SVG as text</code></pre>
        <p><input type="search" id="dsIconFind" class="search-input ds-find" placeholder="Find an icon" aria-label="Find an icon" spellcheck="false" autocomplete="off"> <span class="form-hint" id="dsIconCount"></span></p>
        <div class="ds-icons" id="dsIcons"></div>
        <h3>Icons by job</h3>
        <p>Where the same job appears in several places it has a name, so it always gets the same icon: <code>Icons.roleIcon('run-batch')</code>.</p>
        <div class="ds-icons is-roles" id="dsRoles"></div>
    </section>

    <section class="ds-section" id="dialogs">
        <h2>Dialogs and messages <span class="ds-chip">Shared module</span></h2>
        <p>A question or a form is a dialog. News is a toast in the corner. A right-click menu is the context menu. Never the host's own pop-ups.</p>
        <div class="ds-demo ds-row">
            <button type="button" class="btn btn-secondary" data-click="ds:confirm">Confirm</button>
            <button type="button" class="btn btn-secondary" data-click="ds:alert">Alert</button>
            <button type="button" class="btn btn-secondary" data-click="ds:form">Form dialog</button>
            <button type="button" class="btn btn-secondary" data-click="ds:choice">Choice dialog</button>
            <button type="button" class="btn btn-secondary" data-click="ds:toast" data-arg="info">Toast</button>
            <button type="button" class="btn btn-secondary" data-click="ds:toast" data-arg="success">Success</button>
            <button type="button" class="btn btn-secondary" data-click="ds:toast" data-arg="warn">Warning</button>
            <button type="button" class="btn btn-secondary" data-click="ds:toast" data-arg="error">Error</button>
            <button type="button" class="btn btn-secondary" data-click="ds:menu">Menu</button>
        </div>
        <pre class="ds-code"><code>const yes = await DbmnModal.confirm({ title: 'Delete the query?', body: '…', confirmLabel: 'Delete', confirmVariant: 'danger' });
const { actionId, fields } = await DbmnModal.show({ title, fields: [{ id: 'name', type: 'text', label: 'Name' }], actions: [{ id: 'save', label: 'Save', variant: 'primary' }] });
DbmnToast.success('Saved');   DbmnToast.warn('…');   DbmnToast.error('…', { persistent: true });
DbmnContextMenu.show(event, [{ id: 'rename', label: 'Rename', icon: 'pencil' }], id =&gt; …);</code></pre>
    </section>

    <section class="ds-section" id="tables">
        <h2>Tables <span class="ds-chip is-component">Component</span></h2>
        <p>One table, whether the page holds the rows or they stay with the screen. This one holds 5,000 rows and draws only the ones in view. Try it:</p>
        <ul class="ds-rules">
            <li><strong>Search</strong> as in the Console: words, <code>"exact"</code>, <code>-not</code>, <code>a,b</code> for either, and <code>@status=Open</code> or <code>@qty&gt;40</code> for one column. Type <code>@</code> for the list: it says what each column is (text, number, yes/no, date, nested) and offers what fits. A date takes <code>@placed&gt;7d</code>, <code>@placed=today</code> or <code>@placed=30d..7d</code>; a yes/no column <code>@urgent=true</code>. The line under the box says how the search is being read. No type shows in a heading, and values show as they came.</li>
            <li><strong>A heading:</strong> the icon sorts (one way, the other, then as given), the name drags the column, x removes it, the right edge resizes and a double-click fits. A right-click lists all of it.</li>
            <li><strong>A long value</strong> opens in full with a click (the notes column).</li>
        </ul>
        <div class="ds-demo">
            <dbmn-table id="dsOrders" label="Orders" searchable removable></dbmn-table>
        </div>
        <pre class="ds-code"><code>&lt;dbmn-table id="orders" label="Orders" searchable removable&gt;&lt;/dbmn-table&gt;

orders.columns = [{ id: 'order_no', name: 'order_no' }, { id: 'qty', name: 'qty', numbers: true },
                  { id: 'status', name: 'status', render: (value, row) =&gt; chipFor(value) }];
orders.rows = rows;                        // objects keyed by column id; never changed by the table
orders.addEventListener('dbmn-table-shown', e =&gt; …e.detail.shown, e.detail.total…);

--table-height: 320px                      on the element: how tall before the rows scroll</code></pre>
        <p class="form-hint">It is made from the shared pieces the three results tables use: <code>search-matcher.js</code>, <code>column-head.js</code>, <code>column-drag.js</code>, <code>virtual-window.js</code> and <code>cell-detail.js</code>. Typing in the search box is never held up: over a few thousand rows the search waits for a pause, then runs a little at a time.</p>

        <h3>Rows that stay with the screen</h3>
        <p>A hundred thousand rows the page never holds: the table asks for the 200 it needs as they scroll into view, and a row not in yet is an empty row of the same height. Searching and sorting are the screen's (here, a made-up one that answers after a moment): the table says what was asked and asks again, and a sort's icon is a clock until the rows land. The search box is the screen's own, with the table's column suggestions. What is moved, removed, resized or sorted is told to the screen, to save and give back.</p>
        <p><input type="text" id="dsPagedFind" class="search-input ds-find" placeholder="Search, or @customer" aria-label="Search the orders" spellcheck="false" autocomplete="off"> <span class="form-hint" id="dsPagedNote" role="status"></span></p>
        <div class="ds-demo">
            <dbmn-table id="dsPaged" label="Orders, asked for as they scroll" removable></dbmn-table>
        </div>
        <pre class="ds-code"><code>&lt;dbmn-table id="orders" label="Orders" removable&gt;&lt;/dbmn-table&gt;      no searchable: the screen has its own box

orders.columns = [...];
orders.layout = saved;                     // the order, widths, hidden columns and sort kept from last time
orders.searchWith(searchInput);            // the screen's box searches it
orders.source = { page: (start, count, { search, sort }) =&gt; askTheHost(start, count, search, sort) };
                                           // answers rows, or { rows, total }, now or later
orders.reload();                           // the rows changed: ask again from the top; { keep: true } stays put
orders.totals = { qty: 2449650 };          // a row under the rows, from the screen
orders.addEventListener('dbmn-table-layout', e =&gt; save(e.detail.layout));   // change: sorted, moved, removed, resized
orders.addEventListener('dbmn-table-shown', e =&gt; …e.detail.total…);

locked                                     attribute: columns can be neither moved nor removed</code></pre>

        <h3>Rows inside a row</h3>
        <p>A value that is a list of records (an order's lines, its packages) shows as a count with a chevron, and opens inside its own cell: a small table with its own headings, which sort and can be removed. Two lists in one row each open in their own cell, side by side. The first 100 records show. What is open stays open through a search or a sort, and a search that finds the order shows all its records. Try it: open the lines and the packages of one order, then sort the table.</p>
        <div class="ds-demo">
            <dbmn-table id="dsNested" label="Orders with their lines and packages" searchable removable></dbmn-table>
        </div>
        <pre class="ds-code"><code>orders.rows = [{ order_no: 'SO-10412', lines: [{ line: 1, item: 'A-2207', qty: 48 }, …], packages: [{ … }] }, …];
                                           // nothing to ask for: a list of records in a cell opens
orders.rowKey = row =&gt; row.order_no;       // what makes a row the same row (needed when rows stay with the screen)

{ id: 'lines', name: 'lines', nested: { count: row =&gt; row.lineCount, rows: row =&gt; fetchLines(row) } }
                                           // records fetched when the cell is opened</code></pre>
    </section>

    <section class="ds-section" id="logs">
        <h2>Logs <span class="ds-chip is-component">Component</span></h2>
        <p>A log line looks the same wherever it shows: the Logs screen today, the Console's request log next.</p>

        <h3>Level</h3>
        <p>How serious a line is: an icon and a word, so it is never told by colour alone.</p>
        <div class="ds-demo ds-row" id="dsLevels">
            <dbmn-level level="error"></dbmn-level>
            <dbmn-level level="warn"></dbmn-level>
            <dbmn-level level="info"></dbmn-level>
            <dbmn-level level="debug"></dbmn-level>
        </div>
        <pre class="ds-code"><code>&lt;dbmn-level level="warn"&gt;&lt;/dbmn-level&gt;          level: error, warn, info, debug
cell.append(DbmnLevel.make('error'));            from script, in a table's cell</code></pre>

        <h3>Log</h3>
        <p>The table above with the log's columns, the newest line at the top and kept in view. Try it: add lines and they are followed; scroll down and the lines stay where they are while new ones are counted; back at the top it follows again. It searches as every table does (<code>@level=error</code>, <code>@source=sign-in</code>), and a message with more to it opens in full with a click.</p>
        <p><button type="button" class="btn btn-secondary" id="dsLogAdd" data-click="ds:log">Add lines</button> <span class="form-hint" id="dsLogNote" role="status"></span></p>
        <div class="ds-demo">
            <dbmn-log id="dsLog" class="ds-log" label="Example log"></dbmn-log>
        </div>
        <pre class="ds-code"><code>&lt;dbmn-log id="log" label="Logs"&gt;&lt;/dbmn-log&gt;       it fills the height its screen gives it

log.lines = [{ key, time, level, source, message, environment?, run?: { id, name }, detail?, open? }, …];
log.append(newLines);                      // new lines, at the top; in view while following
log.older(olderLines);                     // older lines, at the bottom: nothing on screen moves
log.following = false;                     // scrolling down does this too
log.search = '@level=error';
log.text();                                // the lines shown, as text: what Copy copies
log.addEventListener('dbmn-log-shown', e =&gt; …e.detail.shown, total, following, unseen…);
log.addEventListener('dbmn-log-end', …);    // scrolled down to the oldest line: time for older ones
log.addEventListener('dbmn-log-open', e =&gt; …e.detail.open…);   // a line's open clicked</code></pre>
    </section>

    <section class="ds-section" id="adding">
        <h2>Adding a component</h2>
        <ol class="ds-rules">
            <li>Look here first. If something does the job, use it; if it nearly does, change it for every screen.</li>
            <li>A new one is a custom element named <code>dbmn-…</code>, in <code>src/webviews/shared/dbmn-…js</code> with its styles in a shared CSS file. No shadow root.</li>
            <li>It takes what to show as attributes or properties and reports clicks as events. No messages to the host, no stored state, no rules about the data.</li>
            <li>Colours by the theme's names only, with the <code>--dbmn-</code> prefix (Theme and colours). Icons from <code>icons.js</code> only. Standard buttons only.</li>
            <li>It works with the keyboard and says what it is to a screen reader.</li>
            <li>Add it to this page, in every state it has, with the markup to use it, and to the Components list. Check it in two themes, one light.</li>
        </ol>
    </section>

    ${script('shared/icons.js')}
    ${script('shared/help-mode.js')}
    ${script('shared/dbmn-modal.js')}
    ${script('shared/dbmn-context-menu.js')}
    ${script('shared/dbmn-toast.js')}
    ${script('shared/dbmn-clipboard.js')}
    ${script('shared/search-matcher.js')}
    ${script('shared/value-formatter.js')}
    ${script('shared/cell-detail.js')}
    ${script('shared/virtual-window.js')}
    ${script('shared/column-drag.js')}
    ${script('shared/column-head.js')}
    ${script('shared/dbmn-table.js')}
    ${script('shared/dbmn-level.js')}
    ${script('shared/dbmn-log.js')}
    ${script('shared/dbmn-footer.js')}
    ${script('design-system/design-system.js')}
</body>
</html>`;
}
