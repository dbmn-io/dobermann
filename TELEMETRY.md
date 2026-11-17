# What Dobermann sends to DBMN

Usage counts only, and only while you are signed in to a DBMN account. Signed out, nothing
is sent. Signed in, it is optional: the switch is **Hub → Account → Weekly Usage → Share usage
counts with DBMN**, or the setting `dbmn.telemetry.enabled`. VS Code's own telemetry setting
(`telemetry.telemetryLevel` set to `off`) turns it off too. Off means nothing leaves the
machine and nothing is kept waiting to be sent. The web app (app.dbmn.io) and the desktop app
count runs the same way and send the same rows, under the same switch.

Never sent: an environment's address, the method or path of an API, a request or response
body, a header, a variable value, a token, an id from your data, a file, or the name of a
saved endpoint. The code that builds the payload is
`src/services/dbmn-auth/telemetry-payload.ts`; the test `telemetry-document.test.ts` fails
if that code and this page disagree.

## Per day: `upsert_telemetry_events`

One row per day: the totals for everything you ran that day, whichever environment or API.

| Field | What it is |
|---|---|
| `event_date` | The day, `YYYY-MM-DD` |
| `api_calls` | API requests sent that day (single runs and each request of a batch) |
| `batch_runs` | Batches started |
| `batch_records` | Rows those batches held |
| `batch_successes` | Batch requests that succeeded |
| `batch_failures` | Batch requests that failed |
| `export_records` | Rows exported (not recorded yet: always 0) |
| `import_records` | Rows imported (not recorded yet: always 0) |
| `execution_time_ms` | Time spent waiting on the API, in milliseconds |
| `features_used` | Flags for features used that day; today only `puppy_school_opened` |
| `extension_version` | Dobermann's version; a development build says `-dev` |
| `vscode_version` | VS Code's version; `web` from the web app, `desktop` from the desktop app |
| `os_platform` | `linux`, `win32` or `darwin` |

Example:

```json
{
  "p_events": [{
    "event_date": "2026-10-29",
    "api_calls": 12, "batch_runs": 1, "batch_records": 200, "batch_successes": 196, "batch_failures": 4,
    "export_records": 0, "import_records": 0, "execution_time_ms": 48210,
    "features_used": { "puppy_school_opened": true },
    "extension_version": "0.4.0", "vscode_version": "1.104.0", "os_platform": "linux"
  }]
}
```

## When

A few seconds after a run, and every five minutes while anything is waiting. Unsent counts
survive a reload (they are kept in VS Code's global state, or the browser's storage in the web
and desktop apps) and go on the next start; with the switch off they are dropped instead.

## Nothing else

Before 0.4.0 Dobermann also sent each environment's address and the method and path template
of each saved endpoint that ran, checked environment licences by address, and synced weekly
batch counts for the free-tier limit. None of that is sent any more, and the server no longer
stores an address or per-endpoint row from an older version either.

The web app and the desktop app send no usage telemetry.
