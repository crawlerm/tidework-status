# tidework status

At-a-glance health of the tidework stack: services, our own tide gauges, and the external
feeds they depend on. **Live page:** https://crawlerm.github.io/tidework-status/

Runs on GitHub Actions every 30 minutes, outside Supabase and Vercel, so it keeps reporting
when either is down. Scheduling uses GitHub, not Vercel Cron, deliberately: the monitor must not
depend on what it monitors.

## Files

| File | What |
|---|---|
| `collect.mjs` | Probes everything, writes `status.json` (schema 1). No dependencies, Node 20+. |
| `index.html` | The page. Reads `status.json`, refreshes every 5 min, greys everything if the collector is > 75 min stale. |
| `.github/workflows/collect.yml` | Every 30 min: collect → deploy to Pages. No commits per run. |
| `pc/heartbeat.ps1` | Windows scheduled task: posts GPU state to a secret gist. |

**This repo is public.** `status.json` must never contain a secret, a request URL (HHA URLs
carry site PINs) or a raw upstream error body. `collect.mjs` only writes cleaned codes.

## Lights

- **green** working · **amber** degraded / getting stale / ≥ 80 % capacity · **red** failing / ≥ 90 %
- **grey** not measured: not configured, or measured through Supabase while Supabase is down.
  Grey never outranks a real measurement.
- External feeds have two kinds of check: *upstream answers* and *our stored copy is fresh*.
  That split is what separates "their side is down" from "our sync is broken".
- Freshness checks use observation-only columns (`wbyheightraw`, `syhheightraw`, …), never the
  newest row: several locations carry future-dated prediction rows that would look fresh forever.

## Optional secrets (Settings → Secrets and variables → Actions)

Each one only adds detail; everything else works without them.

| Secret | Adds | Scope needed |
|---|---|---|
| `CF_API_TOKEN`, `CF_ACCOUNT_ID` | R2 storage used / 10 GB | Cloudflare token: Account → Account Analytics → Read |
| `VERCEL_TOKEN` (+ `VERCEL_TEAM_ID` if the projects are in a team) | Latest production deploy state for wbtide, eccapp | Vercel token, read access |
| `GPU_GIST_ID` | PC GPU heartbeat | none — the gist ID only |

## Supabase database size

Shows "not installed" until this function exists. Read-only, returns one number:

```sql
create or replace function public.db_size_mb() returns numeric
language sql security definer set search_path = '' stable as
$$ select round(pg_database_size(current_database()) / 1e6, 1) $$;
revoke all on function public.db_size_mb() from public;
grant execute on function public.db_size_mb() to anon;
```

## PC GPU heartbeat

1. Create a **secret** gist at https://gist.github.com containing a file `heartbeat.json` with `{}`.
   The ID is the last part of its URL.
2. Create a fine-grained GitHub token with **Gists: Read and write** only.
3. On the PC, in PowerShell:
   ```powershell
   setx TIDEWORK_GIST_ID "<gist id>"
   setx TIDEWORK_GIST_TOKEN "<token>"
   schtasks /Create /SC MINUTE /MO 15 /TN "tidework-heartbeat" /TR "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\path\to\heartbeat.ps1"
   ```
4. Add `GPU_GIST_ID` as a secret in this repo.

"CUDA available" means `nvidia-smi` answered: driver loaded and GPU visible. It does not test the
CuPy install the hydrodynamics model uses.

## Testing that it can fail

Actions → collect → Run workflow → `simulate = supabase`. Supabase goes red and every item
measured through it goes grey with "stored data unknown — Supabase down". The next scheduled run
puts it back.

Locally: `node collect.mjs /tmp/status.json` (add `SIMULATE=supabase` for the outage path).
