// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Icons = require('../../../../webviews/shared/icons');

/**
 * Icon roles — the contract between the product UI and the documentation.
 *
 * `ICON_ROLES` in shared/icons.js names the function of every icon a user
 * might be told to click ("paste-endpoint" → 'clipboard'). dbmn.io and the
 * Puppy School lessons render `{icon:paste-endpoint}` from an export of that
 * map (`npm run docs:icons`), so the website shows whatever the product
 * draws today. These tests pin each role to the markup that actually renders
 * the control: change a control's icon without updating its role and this
 * fails — which is the point. Fix the role, re-export, and the docs follow.
 */

const WEBVIEWS = path.resolve(__dirname, '../../../../../src/webviews');
const read = (rel: string) => fs.readFileSync(path.join(WEBVIEWS, rel), 'utf8');

/** First `data-icon="…"` that appears after `anchor` in `html`. */
function iconAfter(html: string, anchor: RegExp, window = 400): string | undefined {
    const m = anchor.exec(html);
    if (!m) return undefined;
    const slice = html.slice(m.index, m.index + window);
    return /data-icon="([a-z0-9-]+)"/.exec(slice)?.[1];
}

/** Last `data-icon="…"` that appears before `anchor` in `html`. */
function iconBefore(html: string, anchor: RegExp, window = 200): string | undefined {
    const m = anchor.exec(html);
    if (!m) return undefined;
    const slice = html.slice(Math.max(0, m.index - window), m.index);
    const all = [...slice.matchAll(/data-icon="([a-z0-9-]+)"/g)];
    return all.length ? all[all.length - 1][1] : undefined;
}

describe('icon roles — ICON_ROLES matches the controls that render them', () => {
    const ROLES: Record<string, string> = Icons.ICON_ROLES;

    it('every role points at an icon that exists in ICONS', () => {
        const missing = Object.entries(ROLES).filter(([, name]) => !Icons.ICONS[name]);
        expect(missing, 'roles whose icon is not in ICONS').to.deep.equal([]);
    });

    it('roleIcon() returns the SVG for a role and empty string for an unknown one', () => {
        expect(Icons.roleIcon('paste-endpoint')).to.equal(Icons.icon(ROLES['paste-endpoint']));
        expect(Icons.roleIcon('paste-endpoint')).to.match(/^<svg /);
        expect(Icons.roleIcon('no-such-role')).to.equal('');
    });

    describe('Hub navigation (hub.html)', () => {
        const hub = read('hub/hub.html');
        const nav: Array<[string, string]> = [
            ['nav-environments', 'Environments'],
            ['nav-api-catalogue', 'Endpoints'],
            ['nav-history', 'History'],
            ['nav-reporting', 'Reporting'],
            ['nav-import', 'Import'],
            ['nav-export', 'Export'],
            ['nav-account', 'Account'],
            ['nav-settings', 'Settings']
        ];
        for (const [role, label] of nav) {
            it(`${role} → "${label}" nav item`, () => {
                const found = iconBefore(hub, new RegExp('hub-nav-label">' + label + '<'));
                expect(found, `nav item "${label}"`).to.equal(ROLES[role]);
            });
        }
        it('Home\'s guide names the rail\'s sections in the rail\'s order, so each name sits level with its icon (#348, #298)', () => {
            const rail = [...hub.matchAll(/class="hub-nav-item" data-section="([a-z]+)"/g)].map(m => m[1]);
            const guide = [...hub.matchAll(/class="hub-home-guide-item" data-home-section="([a-z]+)"/g)].map(m => m[1]);
            expect(guide).to.deep.equal(rail);
        });
        it('env-switcher → the environment switcher caret', () => {
            // The caret itself: the VS Code mark (#344) sits between the name and the caret
            expect(iconAfter(hub, /class="hub-env-caret/)).to.equal(ROLES['env-switcher']);
        });
        it('theme-picker → the theme picker button in the header', () => {
            expect(iconAfter(hub, /id="hubThemeBtn"/)).to.equal(ROLES['theme-picker']);
        });
        it('build-search → the Catalogue\'s and History\'s Build a search button (#444)', () => {
            expect(iconAfter(hub, /id="catalogueFilterBtn"/)).to.equal(ROLES['build-search']);
            expect(iconAfter(hub, /id="transactionsFilterBtn"/)).to.equal(ROLES['build-search']);
        });
    });

    describe('API Catalogue (catalogue.js)', () => {
        const cat = read('hub/catalogue.js');
        it('add-endpoint → the Add Endpoint button', () => {
            expect(iconAfter(cat, /data-add-action="new"/)).to.equal(ROLES['add-endpoint']);
        });
        it('paste-endpoint → the Paste Endpoint (clipboard) button', () => {
            expect(iconAfter(cat, /data-add-action="newFromClipboard"/)).to.equal(ROLES['paste-endpoint']);
        });
        it('run-api → the row Run API control', () => {
            expect(iconAfter(cat, /catalogue-row-run-api icon"/, 60)).to.equal(ROLES['run-api']);
        });
        it('run-batch → the row Run Batch control', () => {
            expect(iconAfter(cat, /catalogue-row-run-batch icon"/, 60)).to.equal(ROLES['run-batch']);
        });
    });

    describe('Endpoint editor (endpoint.html)', () => {
        const ep = read('endpoint/endpoint.html');
        const toolbar: Array<[string, RegExp]> = [
            ['editor-line-variable', /id="lineVariableBtn"/],
            ['editor-insert-var', /id="insertBtn"/],
            ['editor-modifier', /id="modifierBtn"/],
            ['editor-encode', /id="encodeBtn"/],
            ['editor-comment', /id="commentBtn"/],
            ['editor-delete-line', /id="deleteLineBtn"/],
            ['editor-undo', /id="undoBtn"/],
            ['editor-redo', /id="redoBtn"/],
            ['editor-format', /id="formatJsonBtn"/]
        ];
        for (const [role, anchor] of toolbar) {
            it(`${role} → ${anchor.source}`, () => {
                expect(iconAfter(ep, anchor)).to.equal(ROLES[role]);
            });
        }
        it('add-header / add-query-param / add-request-body → the Add dropdown', () => {
            const start = ep.indexOf('id="add-section-btn"');
            expect(start).to.be.greaterThan(-1);
            const menu = ep.slice(start, start + 1500);
            expect(iconBefore(menu, /<\/span> Header\b/)).to.equal(ROLES['add-header']);
            expect(iconBefore(menu, /<\/span> Query Parameter\b/)).to.equal(ROLES['add-query-param']);
            expect(iconBefore(menu, /<\/span> Request Body\b/)).to.equal(ROLES['add-request-body']);
        });
        it('window-maximise / window-close → the editor window controls', () => {
            expect(iconAfter(ep, /data-window-action="maximize"/, 80)).to.equal(ROLES['window-maximise']);
            expect(iconAfter(ep, /data-window-action="close"/, 80)).to.equal(ROLES['window-close']);
        });
    });

    describe('Shared controls', () => {
        it('help → the Hub header help mode button (Lucide shield-question-mark)', () => {
            const hub = read('hub/hub.html');
            const button = /<button[^>]*data-help-toggle[^>]*>[\s\S]*?<\/button>/.exec(hub)?.[0] || '';
            expect(ROLES['help']).to.equal('shield-question-mark');
            expect(button).to.include(`data-icon="${ROLES['help']}"`);
            expect(Icons.ICONS['shield-question-mark']).to.include('M20 13c0 5-3.5 7.5-7.66 8.95');
        });
        it('paste-row → the modal footer Paste button', () => {
            expect(read('shared/dbmn-modal.js')).to.include("roleIcon('paste-row')");
            expect(ROLES['paste-row']).to.equal('clipboard');
        });
    });

    describe('Execution status (statusIcon)', () => {
        const cases: Array<[string, string]> = [
            ['status-completed', 'completed'],
            ['status-error', 'error'],
            ['status-running', 'running'],
            ['status-paused', 'paused'],
            ['status-stopped', 'stopped'],
            ['status-queued', 'queued']
        ];
        for (const [role, status] of cases) {
            it(`${role} → statusIcon('${status}')`, () => {
                expect(Icons.statusIcon(status).icon).to.equal(ROLES[role]);
            });
        }
    });

    describe('Console footer (console.html) — Issue #312, emoji → Lucide', () => {
        const con = read('console/console.html');
        const footer: Array<[string, RegExp]> = [
            ['console-rerun', /id="rerun-transaction-btn"/],
            ['console-reprocess', /id="reprocess-batch-btn"/],
            ['console-next-page', /id="next-page-btn"/],
            ['console-cancel', /id="cancel-preparation-btn"/],
            ['console-pause', /id="pause-batch-btn"/],
            ['console-resume', /id="resume-batch-btn"/]
        ];
        for (const [role, anchor] of footer) {
            it(`${role} → ${anchor.source}`, () => {
                expect(iconAfter(con, anchor, 250)).to.equal(ROLES[role]);
            });
        }
        it('the Console and its modules carry no emoji glyphs', () => {
            const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B50}\u{2139}\u{25B6}\u{25BC}]/u;
            for (const rel of ['console/console.html', 'console/modules/progress-handler.js', 'console/modules/batch-actions.js', 'console/modules/raw-tab-handler.js']) {
                const lines = read(rel).split('\n').map((l, i) => [i + 1, l] as const)
                    .filter(([, l]) => emoji.test(l) && !/^\s*(\/\/|\*)/.test(l) && !/statusValue\.includes/.test(l));
                expect(lines.map(([n, l]) => `${rel}:${n} ${l.trim().slice(0, 60)}`), rel).to.deep.equal([]);
            }
        });
    });
});
