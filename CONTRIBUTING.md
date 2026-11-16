# Contributing to Dobermann

Thanks for being here. Dobermann is the open core of DBMN: the VS Code extension, the web app
and the desktop app, and the backend schema they need. Flexion Tech Pty Ltd publishes it under
the AGPL-3.0 and runs the hosted service at dbmn.io.

## Building and testing

```
npm ci
npm run build          # TypeScript and webpack, the dev build
npm run test:core      # the portable core, no VS Code needed
npm run test:unit
npm run test:ui        # Playwright against the real pages
npm run package:prod   # a .vsix
```

Press F5 in VS Code to run the Extension Development Host ("Run Extension (LOCAL backend)"
expects a local Supabase stack: `supabase start` in `supabase/`).

The web app: `npm run web:install` then `npm run web:dev`.

## Contributions

Contributions are welcome. [Open an issue](https://github.com/dbmn-io/dobermann/issues) first
so we can talk it through, then send a pull request:

- Small and single-purpose. Say what changed and why; link the issue.
- Tests with the change: a core test for logic, a UI test for a page.
- Keep the core portable: nothing under `src/services`, `src/screens` or `src/data-loading`
  imports VS Code; `npm run lint:core` enforces it.
- Every source file carries the SPDX header; `npm run spdx:check` enforces it.

Before we merge your first pull request, we'll ask you to sign our
[Contributor License Agreement](CLA.md). The code you write is still yours. Signing lets us
use it in every version of Dobermann, free or paid.

## Conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Security issues go to security@dbmn.io, not to
the issue tracker: see [SECURITY.md](SECURITY.md).
