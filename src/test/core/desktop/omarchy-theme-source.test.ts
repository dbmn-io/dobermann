// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #373: the desktop's current Omarchy theme, read from Omarchy's state and followed as it changes.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { omarchyStateDir, omarchyThemeSource } from '../../../services/desktop/omarchy-theme-source';
import { OMARCHY_THEMES } from '../../../services/theme/omarchy-themes.generated';

function toml(slug: string): string {
    const palette = OMARCHY_THEMES.find(theme => theme.slug === slug)!.palette;
    return Object.entries(palette).map(([key, value]) => `${key} = "${value}"`).join('\n') + '\n';
}

describe('The desktop\'s Omarchy theme (#373)', () => {
    let dir: string;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbmn-omarchy-'));
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('is where omarchy-theme-set stages it', () => {
        expect(omarchyStateDir('/home/someone')).to.equal(path.join('/home/someone', '.local', 'state', 'omarchy', 'current'));
    });

    it('reads the staged theme and its name; where there is none, there is no theme', async () => {
        const source = omarchyThemeSource({ stateDir: dir, homeDir: os.homedir() });
        expect(await source.current(), 'no theme staged').to.equal(undefined);
        expect(await omarchyThemeSource({ stateDir: path.join(dir, 'nowhere'), homeDir: os.homedir() }).current(), 'no Omarchy at all').to.equal(undefined);

        fs.mkdirSync(path.join(dir, 'theme'));
        fs.writeFileSync(path.join(dir, 'theme', 'colors.toml'), toml('tokyo-night'));
        fs.writeFileSync(path.join(dir, 'theme.name'), 'tokyo-night\n');
        const theme = await source.current();
        expect(theme?.name).to.equal('tokyo-night');
        expect(theme?.palette.background).to.equal('#1a1b26');

        // Omarchy's own rendering of its VS Code theme comes along when it is one
        expect(theme?.vscodeTheme, 'none rendered').to.equal(undefined);
        fs.writeFileSync(path.join(dir, 'theme', 'vscode-theme.json'), JSON.stringify({ name: 'Omarchy', type: 'light', colors: { 'editor.background': '#abcdef' }, tokenColors: [] }));
        expect((await source.current())?.vscodeTheme).to.deep.equal({ type: 'light', colors: { 'editor.background': '#abcdef' } });
        const logged: string[] = [];
        const logging = omarchyThemeSource({ stateDir: dir, homeDir: os.homedir(), log: message => logged.push(message) });
        fs.writeFileSync(path.join(dir, 'theme', 'vscode-theme.json'), '{ not json');
        const notJson = await logging.current();
        expect(notJson?.palette.background, 'the palette still counts').to.equal('#1a1b26');
        expect(notJson?.vscodeTheme).to.equal(undefined);
        expect(logged[0]).to.match(/vscode-theme\.json isn't JSON/);
        fs.writeFileSync(path.join(dir, 'theme', 'vscode-theme.json'), JSON.stringify({ type: 'sepia', colors: {} }));
        expect((await logging.current())?.vscodeTheme).to.equal(undefined);
        expect(logged[1]).to.match(/isn't a colour theme/);
        fs.rmSync(path.join(dir, 'theme', 'vscode-theme.json'));

        fs.writeFileSync(path.join(dir, 'theme', 'colors.toml'), 'mode = "dark"\n');
        expect(await logging.current()).to.equal(undefined);
        expect(logged[2]).to.match(/colors\.toml isn't a palette/);
    });

    it('follows a theme change, once it has settled, and only when the palette changed', async () => {
        fs.mkdirSync(path.join(dir, 'theme'));
        fs.writeFileSync(path.join(dir, 'theme', 'colors.toml'), toml('tokyo-night'));
        fs.writeFileSync(path.join(dir, 'theme.name'), 'tokyo-night\n');
        const source = omarchyThemeSource({ stateDir: dir, homeDir: os.homedir(), settleMs: 50 });
        const seen: Array<string | undefined> = [];
        const stop = source.watch(theme => seen.push(theme?.name));
        await new Promise(resolve => setTimeout(resolve, 100));
        try {
            // As omarchy-theme-set does: the theme folder replaced, then the name written
            fs.rmSync(path.join(dir, 'theme'), { recursive: true });
            fs.mkdirSync(path.join(dir, 'theme'));
            fs.writeFileSync(path.join(dir, 'theme', 'colors.toml'), toml('nord'));
            fs.writeFileSync(path.join(dir, 'theme.name'), 'nord\n');
            await new Promise(resolve => setTimeout(resolve, 400));
            expect(seen).to.deep.equal(['nord']);

            // A write that changes nothing (a background cycled) reports nothing
            fs.writeFileSync(path.join(dir, 'theme.name'), 'nord\n');
            await new Promise(resolve => setTimeout(resolve, 300));
            expect(seen).to.deep.equal(['nord']);
        } finally {
            stop();
        }
    });
});
