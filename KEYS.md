# KEYS.md — Supabase credentials, and which one to reach for

A reference for this repo and the other projects on the same Supabase account
(`RatesApp`, `geoapi-next`, the Schedules tooling). If you are about to paste a key
somewhere, read §3 and §6 first.

---

## 1. What this project actually has

`.env` (gitignored) holds **two pairs**, and they point at **different projects**:

| variable | what it is | project |
|---|---|---|
| `VITE_SUPABASE_URL` | Project URL | `sfozxpibfpqsdlxoheyl` ← current |
| `VITE_SUPABASE_ANON_KEY` | legacy JWT, `role=anon` | `sfozxpibfpqsdlxoheyl` ← current |
| `SUPABASE_URL` | Project URL | `jnuigkggmynerrbxvkzy` ← **dead** |
| `SUPABASE_KEY` | legacy JWT, **`role=service_role`** | `jnuigkggmynerrbxvkzy` ← **dead** |

> **Known issue.** The non-`VITE_` pair still points at the deprovisioned standalone project
> (NXDOMAIN — it no longer exists). Its `service_role` key is therefore inert, but it is still a
> service-role credential sitting in a file. When the Python push (CLAUDE.md §14) is rebuilt
> against the shared project, replace both values. Until then they do nothing.

Elsewhere on the account:

- `RatesApp/.env.local` — the same `VITE_` anon pair for the shared project.
- `RatesApp/.env.mgmt` — `SUPABASE_ACCESS_TOKEN` (`sbp_…`), account-wide. See §5.

---

## 2. Why there are two URL variables when the dashboard shows one

**This is the thing that trips everyone up, and it is not a Supabase concept at all — it is a
Vite one.**

There is exactly **one** Project URL per Supabase project. The dashboard shows one because there
*is* one. `SUPABASE_URL` and `VITE_SUPABASE_URL` are meant to hold the **same string**.

They exist separately because of how Vite handles environment variables:

> Vite only injects variables prefixed **`VITE_`** into the browser bundle. Anything without that
> prefix is invisible to front-end code.

So the prefix is a **deliberate safety boundary**, not a naming quirk:

```
VITE_SUPABASE_URL       -> compiled INTO the JS bundle, visible to anyone who opens devtools
VITE_SUPABASE_ANON_KEY  -> same

SUPABASE_URL            -> only readable by server-side code (the Python push, a Node script)
SUPABASE_KEY            -> same  ← which is why the service_role key goes HERE and never there
```

**The rule that follows:** if a value must never reach a browser, it must never carry a `VITE_`
prefix. Vite is what enforces that, and it enforces it by name alone.

---

## 3. The four credential types

| credential | looks like | scope | where it may live |
|---|---|---|---|
| **Publishable / anon** | `sb_publishable_…` or a JWT with `role=anon` | one project, **RLS applies** | browser, mobile, anywhere |
| **Secret / service_role** | `sb_secret_…` or a JWT with `role=service_role` | one project, **RLS is bypassed entirely** | server only |
| **Personal Access Token** | `sbp_…` | **your whole account** — every org, every project | your machine, CI secrets |
| **Database password / connection string** | `postgresql://…` | one project's Postgres | server only |

### Publishable / anon — *safe in public by design*

This is **meant** to ship in the JS bundle. It identifies the project and nothing more. It grants
no access on its own: **Row Level Security is the actual boundary.** A table with RLS enabled and
no policy returns zero rows to this key no matter what.

That is exactly what you saw this session: `us_ports` had `GRANT ALL … TO anon` and still returned
nothing, because RLS was on with no policy. Two separate gates — the grant, then the policy.

Treat any table you grant to `anon` as **public information**. That is a data-classification
decision, not a technical one.

### Secret / service_role — *the dangerous one*

**It bypasses RLS completely.** Every policy you wrote this session is simply not evaluated. It
can read and write every row of every table in that project.

It exists for trusted server-side work: the thrice-weekly Python push, ETL, admin scripts. It must
never be in a browser bundle, a mobile app, a public repo, or a `VITE_`-prefixed variable.

A useful sanity check: **if a key can bypass RLS, the only thing protecting your data is where the
key is stored.** So store it somewhere a stranger cannot reach.

### Personal Access Token (`sbp_`) — *account-level, not a database key*

Authenticates the **Management API** and the **CLI** (`supabase login` stores exactly this). It is
not scoped to one project — it reaches every organisation and project your account can see, and can
create/delete projects, run SQL, and **read or rotate the project keys above**, including
`service_role`.

**PATs do not expire.** A leaked one is valid until revoked.

---

## 4. Where to get each one

Supabase moves its dashboard around, so these are described by what to look for rather than an
exact click path.

**Project URL, publishable/anon key, secret/service_role key**
→ open the project → **Project Settings** → **API** (may appear as *API Keys* / *Data API*).

- **Project URL** — `https://<project-ref>.supabase.co`. One value. Copy it into *both*
  `SUPABASE_URL` and `VITE_SUPABASE_URL`. **This is the answer to "I only see the Vite one":
  the dashboard has one URL; the two variable names are yours, not Supabase's.**
- **Publishable / anon** — shown openly, safe to copy around.
- **Secret / service_role** — hidden behind a *Reveal* control, with a warning next to it. That
  warning is the whole point.

Newer projects show **`sb_publishable_…` / `sb_secret_…`** alongside (or instead of) the legacy
`anon` / `service_role` JWTs. They map one-to-one onto the same two roles; the advantage is that
they can be rotated individually without invalidating the other. This project still uses the legacy
JWT pair — both work.

**Personal Access Token**
→ **supabase.com/dashboard/account/tokens** (account level, not inside a project).
Shown **once** at creation. If you lose it, revoke and make a new one.

**Database connection string**
→ **Project Settings** → **Database**. Needed for `psql`, migrations, or direct Postgres clients.
Same handling rules as `service_role`.

---

## 5. Choosing one — three questions

**1. Where does the code run?**

- Browser / anything a user can open devtools on → **publishable / anon**, no exceptions.
- A server, a cron job, your laptop running a Python script → server-side keys are available.

**2. Should RLS apply?**

- Yes (normal case) → **anon**, plus a grant *and* a policy for the `anon` role.
- No, this job legitimately needs every row → **service_role**, server-side only.

> If you are reaching for `service_role` because a query returns nothing, **stop.** That is almost
> always a missing RLS policy, and swapping the key hides the bug instead of fixing it. It is also
> how a service-role key ends up somewhere it should not be.

**3. Is it about the database, or about the project itself?**

- Reading/writing rows → anon or service_role.
- Creating projects, managing keys, running the CLI → **PAT**.

### How this repo applies it

| job | credential | why |
|---|---|---|
| Map reads `sea_routes`, `us_ports`, `world_ports` | `VITE_SUPABASE_ANON_KEY` | runs in the browser; RLS policies grant exactly these |
| Python push upserting `shipments` (CLAUDE.md §14) | `SUPABASE_KEY` (service_role) | server-side, needs to write regardless of RLS |
| `supabase` CLI, migrations | `SUPABASE_ACCESS_TOKEN` | account-level operations |

---

## 6. Never do

- **Never give a secret/service_role key a `VITE_` prefix.** That single act publishes it to every
  visitor. This is the highest-consequence mistake in the list.
- **Never commit `.env`.** Both repos gitignore `.env*` — keep it that way. Once a key is in git
  history, rotating is the only real fix; deleting the file does not remove it.
- **Never use `service_role` to work around an empty result.** Fix the grant and the policy.
- **Never paste a key into a chat, an issue, a screenshot, or a log.** (I did exactly this with your
  PAT earlier in this session, by redacting `*KEY=` and missing `ACCESS_TOKEN=`. See §7.)
- **Never assume the anon key is a secret.** It is in the bundle. Anyone can read it. Your security
  is RLS — so review policies, not key storage, when deciding what `anon` may see.
- **Never reuse one PAT across machines and CI.** Separate tokens mean you can revoke one without
  breaking everything.

---

## 7. Rotating

**Publishable / anon** — rotate in **Project Settings → API**, then update `VITE_SUPABASE_ANON_KEY`
in every app. Low urgency; it is public anyway. Rotating the *legacy* JWT pair changes both `anon`
and `service_role` together, which is precisely why the new `sb_publishable_` / `sb_secret_` format
exists.

**Secret / service_role** — same screen. Rotate **immediately** on any suspected exposure, then
update every server-side consumer. Everything using the old key breaks at once, so know the list
first.

**Personal Access Token** — **supabase.com/dashboard/account/tokens** → revoke → generate new →
copy immediately (shown once). Then update everywhere it lives:

- `RatesApp/.env.mgmt`
- the CLI's stored copy (re-run `supabase login`; on Windows it sits under `%APPDATA%\supabase\`)
- any CI/CD secret
- any other machine you have logged the CLI in on

> **Outstanding:** the PAT in `.env.mgmt` was printed in full in a Claude Code transcript on
> 2026-08-23. It was never committed to git (verified across all branches), so the exposure is the
> transcript alone — but PATs never expire, so it should be rotated.

**After any rotation**, restart anything that reads `.env`: Vite reads it **only at startup**, so a
running dev server keeps serving the old value and will look like the rotation failed.

---

## 8. Quick identification

Given an unknown string:

| starts with | it is |
|---|---|
| `https://` + `.supabase.co` | Project URL — safe |
| `sb_publishable_` | client-safe key |
| `sb_secret_` | **server only** |
| `sbp_` | **account-wide PAT** |
| `eyJ…` (three dot-separated parts) | legacy JWT — decode it, see below |
| `postgresql://` | DB connection string — **server only** |

A legacy JWT is base64; its middle segment says which role it is:

```bash
# prints e.g. {"iss":"supabase","ref":"sfozxpibfpqsdlxoheyl","role":"anon","exp":...}
node -e "console.log(JSON.parse(Buffer.from(process.argv[1].split('.')[1],'base64')))" "<key>"
```

`role` is `anon` (safe) or `service_role` (**not safe**). `ref` tells you which project it belongs
to — which is how the mismatch in §1 was found.
