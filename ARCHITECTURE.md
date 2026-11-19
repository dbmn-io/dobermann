# Architecture, in one page

Three hosts, one core.

- **The core** (`src/services`, `src/screens`, `src/data-loading`, `src/utils`) knows no host:
  it never imports VS Code and never speaks Supabase. It takes what it needs through ports
  (configuration, storage, secrets, the catalogue store, the OAuth flow) and `npm run
  lint:core` keeps it that way (`scripts/core-modules.json` is the list).
- **VS Code** (`src/extension.ts`, `src/platform/vscode`) wires the core to VS Code: the Hub
  webview, the extension host's storage and secrets, the loopback listener that lets the web
  app run requests through VS Code.
- **The web app** (`web/`) wires the same core and the same screens to a browser and a
  Supabase session; **the desktop app** (`desktop/`) is the web app in Electron with its own
  request executor.
- **Supabase adapters** (`src/platform/supabase`) are the account storage: catalogue, settings,
  workspaces, agent keys and listeners. Each takes the client the host built.
- **Screens** (`src/screens`) are controllers: they take a message from a page, call the core
  and post state back. Pages (`src/webviews`) are plain HTML and JavaScript with no business
  logic.
- **The design system** is what pages are built from: shared components (custom elements named
  `dbmn-…`, in `src/webviews/shared`), shared styles, one icon list and the theme's colours. It
  documents itself: a development build has a **Design system** button in the Hub's header
  that opens a page showing every piece live, with the principles and the markup to use it
  (`src/screens/design-system`, `src/webviews/design-system`). Components draw and report
  clicks; they hold no business logic and no colours of their own. A new screen is built from
  them, and a new shared piece is added to that page in the same change.
- **Standard Systems** are configuration rows (`global_systems`) the app applies: sign-in URL
  templates, token request headers, token claims, organisation headers, default headers. The
  code knows how to apply a System's configuration, never what any System's configuration is.

Tests: `src/test/core` (the core, no VS Code), `src/test/unit`, `src/test/ui` (Playwright
against the real pages), `e2e/console` and `e2e/webview` (Playwright, no backend).
