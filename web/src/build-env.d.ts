/**
 * Set by the Vite config at build time (static-build.ts, vite.config.ts): the local or test stack a
 * built bundle runs on, or null (the dev server, the desktop app, and the production web app).
 */
declare const __DBMN_BAKED_BACKEND__: import('../../src/services/dbmn-backend/backend-config').DevStackInput | null;

/** The app's version (package.json), for what usage rows say about the client. */
declare const __DBMN_APP_VERSION__: string;
