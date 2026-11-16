// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * How the desktop app is packaged (electron-builder), every platform in one place. What differs
 * by platform is here; what differs by channel is src/channel.ts (every package is a dev build
 * today: a local stack only, the `-dev` in each file name).
 *
 *   npm --prefix desktop run package        Linux: AppImage + the unpacked folder
 *   npm --prefix desktop run package:win    Windows: an NSIS installer (x64); on Linux it needs Wine
 *
 * Windows signing (#373): Azure Artifact Signing on Flexion Tech Pty Ltd's account. On with
 * DBMN_WIN_SIGN=azure (the release workflow sets it); the signing tool itself reads the three
 * AZURE_* variables (tenant, client id, client secret: repository secrets, never in this file).
 * The endpoint, account, profile and publisher are facts of the project, not secrets. Without
 * DBMN_WIN_SIGN the installer is unsigned, and Windows SmartScreen says so.
 */
const WINDOWS_SIGNING = {
    endpoint: 'https://eus.codesigning.azure.net',
    codeSigningAccountName: 'flexiondbmn',
    certificateProfileName: 'dbmn-desktop',
    // Must equal the certificate's CN: the organisation name Microsoft validated
    publisherName: 'Flexion Tech Pty Ltd'
};

const sign = process.env.DBMN_WIN_SIGN;
if (sign && sign !== 'azure') throw new Error(`DBMN_WIN_SIGN must be "azure" or unset, not "${sign}".`);
if (sign === 'azure') {
    for (const name of ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET']) {
        if (!process.env[name]) throw new Error(`DBMN_WIN_SIGN=azure needs ${name} (a repository secret).`);
    }
}

module.exports = {
    appId: 'io.dbmn.desktop',
    productName: 'DBMN',
    artifactName: 'DBMN-${version}-dev.${ext}',
    directories: { output: 'release', buildResources: 'build' },
    files: ['out/**/*.js', 'package.json'],
    extraResources: [{ from: '../web/dist-desktop', to: 'app-pages' }],
    asar: true,
    electronFuses: {
        runAsNode: false,
        enableNodeOptionsEnvironmentVariable: false,
        onlyLoadAppFromAsar: true
    },
    linux: {
        target: ['AppImage', 'dir'],
        category: 'Development',
        icon: '../images/DBMNLogo.png',
        executableName: 'dbmn-desktop'
    },
    win: {
        target: [{ target: 'nsis', arch: ['x64'] }],
        // build/icon.png, square (electron-builder makes the .ico)
        icon: 'build/icon.png',
        ...(sign === 'azure' ? { azureSignOptions: WINDOWS_SIGNING } : {})
    },
    nsis: {
        artifactName: 'DBMN-Setup-${version}-dev.${ext}',
        // Per user, no admin prompt, one click; the uninstaller leaves the user's data alone
        oneClick: true,
        perMachine: false,
        deleteAppDataOnUninstall: false
    }
};
