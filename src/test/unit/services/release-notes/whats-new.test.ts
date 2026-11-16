// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { summariseChangelog, whatsNewBaseline, whatsNewFromReleaseNotes, FIRST_HOME_BASELINE } from '../../../../services/release-notes/whats-new';

// GitHub Issue #348: Home's "What's new" comes from the bundled CHANGELOG.md,
// covering every version since the one this install last ran.

const CHANGELOG = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '### Added',
    '- **Next thing** — not out yet.',
    '',
    '## [0.3.1] - 2026-10-09',
    '',
    '### Added',
    '- **A new Home** — Puppy School first. [Docs](https://dbmn.io/docs/hub/)',
    '- **Lists slide in from the rail** — the tabs keep their width.',
    '',
    '### Changed',
    '- **One** — x',
    '',
    '### Improved',
    '- **Two** — y',
    '',
    '### Fixed',
    '- **Fix a** — a',
    '  continuation line, not an entry',
    '',
    '## [0.3.0] - 2026-10-05',
    '',
    '### Added',
    '- **Puppy School** — the course.',
    '- **Chain** — results become input.',
    '',
    '### Fixed',
    '- **Old fix** — b',
    '',
    '### Security',
    '- **Sec** — s',
    '',
    '## [0.2.1] - 2026-08-24',
    '',
    '### Fixed',
    '- **Older fix** — never counted from 0.2.1.',
    ''
].join('\n');

describe('summariseChangelog (Issue #348)', () => {
    it('one version: counts per heading, Improved and Removed as changes', () => {
        const s = summariseChangelog(CHANGELOG, '0.3.1')!;
        expect(s).to.include({ version: '0.3.1', since: null, versions: 1 });
        expect(s.counts).to.deep.equal({ added: 2, changed: 2, fixed: 1, security: 0 });
        expect(s.highlights).to.deep.equal(['A new Home', 'Lists slide in from the rail']);
    });

    it('since a baseline: sums every later version, newest highlights first', () => {
        const s = summariseChangelog(CHANGELOG, '0.3.1', '0.2.1')!;
        expect(s).to.include({ version: '0.3.1', since: '0.2.1', versions: 2 });
        expect(s.counts).to.deep.equal({ added: 4, changed: 2, fixed: 2, security: 1 });
        expect(s.highlights).to.deep.equal(['A new Home', 'Lists slide in from the rail', 'Puppy School']);
    });

    it('a baseline equal to the previous version gives just this one', () => {
        expect(summariseChangelog(CHANGELOG, '0.3.1', '0.3.0')!.versions).to.equal(1);
    });

    it('falls back to [Unreleased] before the version is cut', () => {
        const s = summariseChangelog(CHANGELOG, '0.4.0')!;
        expect(s.version).to.equal(null);
        expect(s.highlights).to.deep.equal(['Next thing']);
    });

    it('returns null with no section or no entries', () => {
        expect(summariseChangelog('# Changelog\n', '1.0.0')).to.equal(null);
        expect(summariseChangelog('## [1.0.0] - 2026-01-01\n\n### Added\n', '1.0.0')).to.equal(null);
    });

    it('does not match a longer version that starts the same', () => {
        const md = '## [0.3.10] - 2026-12-01\n### Fixed\n- **x** — y\n## [0.3.1] - 2026-10-09\n### Fixed\n- **z** — w\n';
        expect(summariseChangelog(md, '0.3.1')!.counts.fixed).to.equal(1);
    });
});

describe('whatsNewBaseline (Issue #348)', () => {
    it('an install that never saw Home starts from the first-Home baseline', () => {
        expect(whatsNewBaseline(undefined, '0.3.1')).to.deep.equal({ current: '0.3.1', since: FIRST_HOME_BASELINE });
    });
    it('stays put while the same version runs', () => {
        const stored = { current: '0.3.1', since: '0.2.1' };
        expect(whatsNewBaseline(stored, '0.3.1')).to.equal(stored);
    });
    it('an upgrade measures from the version that ran before', () => {
        expect(whatsNewBaseline({ current: '0.3.1', since: '0.2.1' }, '0.3.4')).to.deep.equal({ current: '0.3.4', since: '0.3.1' });
    });
});

// The web and desktop apps are handed their release notes as a file (web/src/shell/whats-new.ts)
describe('whatsNewFromReleaseNotes (Issue #348, outside VS Code)', () => {
    it('a first run shows everything since the first-Home baseline, and keeps where it started', () => {
        const { whatsNew, baseline } = whatsNewFromReleaseNotes({ version: '0.3.1', changelog: CHANGELOG }, undefined);
        expect(whatsNew).to.deep.equal(summariseChangelog(CHANGELOG, '0.3.1', FIRST_HOME_BASELINE));
        expect(whatsNew!.version).to.equal('0.3.1');
        expect(baseline).to.deep.equal({ current: '0.3.1', since: FIRST_HOME_BASELINE });
    });
    it('the same version again measures from the same place; an upgrade from the version before', () => {
        const stored = { current: '0.3.1', since: '0.3.0' };
        expect(whatsNewFromReleaseNotes({ version: '0.3.1', changelog: CHANGELOG }, stored).baseline).to.deep.equal(stored);
        const upgraded = whatsNewFromReleaseNotes({ version: '0.3.1', changelog: CHANGELOG }, { current: '0.3.0', since: '0.2.1' });
        expect(upgraded.baseline).to.deep.equal({ current: '0.3.1', since: '0.3.0' });
        expect(upgraded.whatsNew).to.deep.equal(summariseChangelog(CHANGELOG, '0.3.1', '0.3.0'));
    });
    it('a stored baseline that isn\'t one is started again', () => {
        const { baseline } = whatsNewFromReleaseNotes({ version: '0.3.1', changelog: CHANGELOG }, { current: 7 });
        expect(baseline).to.deep.equal({ current: '0.3.1', since: FIRST_HOME_BASELINE });
    });
    it('what isn\'t release notes gives no card and leaves the baseline alone', () => {
        for (const notes of [undefined, null, 'text', {}, { version: '0.3.1' }, { version: 'latest', changelog: CHANGELOG }, { version: '0.3.1', changelog: 5 }]) {
            expect(whatsNewFromReleaseNotes(notes, undefined), JSON.stringify(notes)).to.deep.equal({ whatsNew: null });
        }
    });
});
