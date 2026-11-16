# The public backend (#402)

What the open-source Dobermann ships of DBMN's backend: the tables and the three functions
the app needs, and nothing else. **Everything in this folder is generated**; edit the
allowlist (`supabase/public-baseline.json`) or the private migrations, then regenerate.

```
npm run backend:public-baseline      # from the dev stack's database → supabase/public/
npm run test-stack:reset:public      # replay it on the test stack, on its own
npm run test:supabase                # the public tests pass against it (see public-baseline.test.ts)
npm run test-stack:reset             # back to the full private backend
```

| Here | What it is |
|---|---|
| `migrations/20260101000000_public_baseline.sql` | One migration: the public tables with their policies, grants, triggers and Realtime membership; the public functions with their privileges; the auth trigger that gives a new account its licence row. Replays from scratch with `supabase db reset`. |
| `seed.sql` | The sample Standard System for a local stack. |
| `config.toml` | The private config with only the public functions and no secrets. |

Edge functions are not copied here: the export (#404) takes `check-license`, `sync-usage`,
`environment-policy` and `_shared/cors.ts` from `supabase/functions/` by allowlist.

## How a schema change reaches both worlds

1. Write it as a normal migration in this repo (`supabase/migrations/`), as always, and apply
   it to production from here. Production keeps its own chain; the public baseline never
   touches production.
2. Regenerate the baseline (`npm run backend:public-baseline`) and replay it
   (`test-stack:reset:public`, then the public tests).
3. In the public repo the change lands as a **new migration of its own**, with the same SQL as
   the private one, so its chain replays from scratch too. The regenerated baseline is the
   check that nothing was missed: its diff is the change.

## What the generator refuses

- A table in the allowlist without row-level security.
- Anything matching the forbidden words in `public-baseline.json` (System names, customers,
  private products, people, billing).

It also pins `search_path` on every security-definer function that lacks one, and says which
(#403: those should get it in the private migrations too).
