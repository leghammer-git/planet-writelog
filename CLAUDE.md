# Planet WriteLog

Community feed aggregator for Windows endpoint deployment professionals — surfacing blog posts, GitHub releases, and YouTube videos from Microsoft MVPs and MMS conference presenters.

**Live site:** https://planet-writelog.pages.dev

## Architecture

Static site built with [11ty](https://www.11ty.dev/), fed by a Node.js aggregation script that runs hourly via GitHub Actions and commits the results. Cloudflare Pages auto-deploys on push.

```
people/*.json          → scripts/aggregate.js → _data/items.json
(112 person profiles)     (hourly GH Action)    (committed, 5000 max)
                                                       ↓
                                               11ty builds _site/
                                                       ↓
                                            Cloudflare Pages serves
```

### Key directories

| Path | Purpose |
|------|---------|
| `people/` | Source of truth — one JSON file per community member |
| `src/` | 11ty Nunjucks templates |
| `src/_includes/` | Layout and component partials |
| `_data/` | Generated data committed to git (`items.json`, `people.json`) |
| `scripts/` | `aggregate.js` (feed fetcher), `validate-people.js` (CI validation) |
| `public/` | Static assets: `css/style.css`, `js/main.js` |
| `_site/` | Build output (gitignored) |
| `.github/workflows/` | `aggregate.yml` — hourly cron job |

## Dev commands

```bash
npm start          # 11ty dev server with live reload (http://localhost:8080)
npm run build      # Static build to _site/
npm run aggregate  # Fetch feeds, update _data/ (requires network; uses SQLite cache)
npm run validate   # Validate all people/*.json against schema
```

Node 22+ required. SQLite (`aggregator.db`) is gitignored and auto-created; it caches ETags, YouTube channel IDs, and GitHub repo lists to avoid redundant fetches.

## Person files (`people/{handle}.json`)

The `people/` directory is the only thing contributors need to touch. Every file is validated against `people/schema.json` (JSON Schema Draft 7) in CI.

**Required fields:** `name`, `handle`, `title`, `bio` (max 300 chars), `feeds` (at least one)

**Optional:** `pronouns`, `avatar` (URI), `mvp`, `links`

```json
{
  "name": "Jane Doe",
  "handle": "jane-doe",
  "title": "Senior Endpoint Engineer",
  "bio": "ConfigMgr and Intune specialist.",
  "mvp": { "status": "active", "category": "Enterprise Mobility" },
  "links": {
    "github": "janedoe",
    "bluesky": "janedoe.bsky.social"
  },
  "feeds": [
    { "type": "blog", "url": "https://janedoe.com/feed.xml" },
    { "type": "github-user", "username": "janedoe" },
    { "type": "youtube", "channel": "@JaneDoe" }
  ]
}
```

`handle` must be lowercase alphanumeric + hyphens and **match the filename** exactly.

## Feed types

| Type | Required fields | Notes |
|------|----------------|-------|
| `blog` | `url` | RSS 2.0 or Atom. Optional: `author` (filter by author name), `label` (custom source label) |
| `github-releases` | `repo` (owner/repo) | Surfaces release notes only, not commits |
| `github-user` | `username` | All public repos — surfaces releases for each |
| `youtube` | `channel` (`@Handle`) or `channel_id` | `channel` handle is resolved to ID once and cached in SQLite |

All feed types accept an optional `label` field that overrides the auto-derived source name shown in the UI.

## Data pipeline (`scripts/aggregate.js`)

- Parallelized fetching via `p-limit` (10 concurrent, 2–5 for GitHub)
- HTTP caching with ETag / `If-None-Match` (304 responses skip re-processing)
- 15-second fetch timeout, 2 retries with exponential backoff
- Items deduplicated by ID in SQLite; `INSERT OR IGNORE` prevents duplicates
- On first run against a fresh DB, seeds history from existing `_data/items.json`
- Writes `_data/items.json` (5000 most recent items) and `_data/people.json` (enriched profiles)

## Frontend (`public/js/main.js`, `src/index.njk`)

Vanilla JS, no framework. All filtering is client-side using `data-*` attributes on item cards:
- `data-type`: `blog` | `github-releases` | `youtube`
- `data-person`: person handle
- `data-source`: feed domain or label
- `data-title`: item title (keyword search)

Pagination loads 50 items at a time via "Load more". Theme (light/dark) is toggled and persisted to `localStorage`.

## Templates (`src/`)

Nunjucks throughout. Key filters defined in `eleventy.config.cjs`:
- `dateDisplay`, `dateTimeUTC`, `dateISO`, `relativeDate` — Luxon-based date formatting
- `slugify`, `limit`, `where`

Pages: `index.njk` (main feed), `feed.njk` (Atom XML), `opml.njk` (OPML), `about/index.njk`, `people/index.njk`, `people/person.njk`.

## CI/CD (`.github/workflows/aggregate.yml`)

1. Hourly cron + manual dispatch
2. Restores `aggregator.db` from Actions cache (keyed on `package-lock.json`)
3. `npm run validate` — fails fast on bad person files
4. `npm run aggregate` — fetches feeds (uses `GITHUB_TOKEN` for higher API quota)
5. If `_data/` changed: commits and pushes to main
6. Cloudflare Pages auto-deploys on push

## Deployment

Hosted on Cloudflare Pages. Config in `wrangler.jsonc` (assets: `./_site`). No server-side code — fully static after build.

## File ownership — what to edit vs. what not to touch

| File / directory | Status | Rule |
|---|---|---|
| `people/*.json` | Hand-maintained | Primary edit target for adding/updating community members |
| `src/` | Hand-maintained | Edit for UI, template, or layout changes |
| `public/css/style.css` | Hand-maintained | Edit for styling changes |
| `public/js/main.js` | Hand-maintained | Edit for client-side behavior changes |
| `eleventy.config.cjs` | Hand-maintained | Edit for build config, filters, or template formats |
| `scripts/aggregate.js` | Hand-maintained | Edit for feed fetching logic changes |
| `scripts/validate-people.js` | Hand-maintained | Edit for validation logic changes |
| `people/schema.json` | Hand-maintained | Edit only when the person file format itself is changing |
| `_data/items.json` | **Generated — never edit** | Written by aggregator; hand edits will be overwritten next run |
| `_data/people.json` | **Generated — never edit** | Written by aggregator; hand edits will be overwritten next run |
| `aggregator.db` | **Generated — never commit** | SQLite cache; gitignored; auto-created on first run |
| `_site/` | **Generated — never edit** | 11ty build output; gitignored |
| `package-lock.json` | Auto-managed | Only touch via `npm install` |

## Commit hygiene

The GitHub Actions aggregator job commits directly to `main` every hour (committing `_data/` changes with message "chore: aggregate"). PRs from contributors should only ever touch `people/` files — nothing else. Do not suggest branching strategies that assume main is stable between pushes; the aggregator commits frequently and auto-deploys on every one.

When making commits: stage specific files by name, never `git add -A`. The most common commit scope is a single `people/{handle}.json` file.

## No test suite

There is no test runner (`npm test` is not defined). The only automated checks are:
- `npm run validate` — JSON Schema validation of all person files
- `npm run build` — 11ty build (catches template errors)

Do not look for or suggest adding `__tests__/`, Jest, Vitest, or similar. These two scripts are the full verification story.

## Coding conventions

### CSS (`public/css/style.css`)
- CSS custom properties (`--color-*`, `--space-*`) for all colors and spacing — do not use hard-coded hex values
- Light/dark theme via `[data-theme="dark"]` selector on `<html>`
- Responsive sizing uses `clamp()`, not breakpoints
- Type colors: blog = green (`--color-blog`), releases = purple (`--color-releases`), videos = red (`--color-videos`)

### JavaScript (`public/js/main.js`)
- Vanilla JS only — no imports, no bundler, no framework
- No `let`/`var` — use `const` throughout
- DOM manipulation via `querySelectorAll` + `forEach`, not jQuery-style helpers

### Nunjucks templates (`src/`)
- Logic belongs in `eleventy.config.cjs` filters, not inline in templates
- Partials go in `src/_includes/`; component partials are named `{thing}-card.njk`

### Person files (`people/`)
- 2-space indentation, keys in schema order: `name`, `handle`, `pronouns`, `title`, `mvp`, `bio`, `avatar`, `links`, `feeds`
- No trailing commas (standard JSON)

## Finding RSS feed URLs

When adding a person, finding their feed URL is the most common friction point. Try in this order:

1. **Check their website's `<head>`** for `<link rel="alternate" type="application/rss+xml">` — this is the canonical way sites advertise their feed
2. **Common paths to try:** `/feed`, `/feed.xml`, `/rss.xml`, `/rss`, `/atom.xml`, `/index.xml`, `/blog/feed.xml`
3. **WordPress sites** almost always have `/feed` or `/?feed=rss2`
4. **Ghost sites** use `/rss/`
5. **Substack** uses `/feed` (e.g., `https://example.substack.com/feed`)
6. **Blogger/Blogspot** uses `/feeds/posts/default?alt=rss`
7. **GitHub Pages / Jekyll** often use `/feed.xml`
8. **If none of those work:** use `github-user` (if they're active on GitHub) or `youtube` as alternatives to a blog feed

Always verify the URL returns valid XML before adding it. A quick `curl -I <url>` or browser visit confirms it's live.

## Known gotchas

- **YouTube `@Handle` values are case-sensitive** in the schema's regex pattern (`^@[\w-]+$`). Use the exact casing from the channel URL.
- **`github-user` can be noisy** for prolific GitHub contributors — it surfaces releases from *all* public repos. For someone with 50+ repos, `github-releases` on specific repos is usually a better choice.
- **`author` filter on blog feeds does substring matching**, not exact match. `"author": "John"` will match "John Smith" and "John Doe". Use a full name when a feed aggregates multiple authors.
- **`channel_id` vs `channel`:** `channel_id` (format `UC...`) bypasses the YouTube handle-resolution step entirely and is more reliable. If you know the channel ID, prefer it. The handle gets resolved once and cached in SQLite, but on a fresh DB it requires a network call.
- **The schema uses `additionalProperties: false`** on every object. Any typo in a field name (e.g., `"lable"` instead of `"label"`) will fail validation with a confusing error about an unknown property.
- **`handle` must be unique** across all 112 files — check with `grep -r '"handle"' people/` before creating a new file.

## Work verification

Always run these checks before reporting a task complete — do not skip even if the change looks trivial:

| After changing... | Run this | What it catches |
|---|---|---|
| Any `people/*.json` file | `npm run validate` | Schema violations, handle/filename mismatch, bad URIs, missing required fields |
| Any `src/` template or `eleventy.config.cjs` | `npm run build` | Nunjucks errors, broken filters, missing data references |
| Both | Both, in order | Run validate first; a bad person file can cause the build to fail in a misleading way |

If a check fails: fix the issue, re-run the check, and only report done once it passes clean.

### Self-review checklist for person files

Before saving any `people/{handle}.json`:
- [ ] `handle` field matches the filename exactly (lowercase alphanumeric + hyphens only)
- [ ] `bio` is 300 characters or fewer
- [ ] All feed `url` values are full URIs (start with `https://`)
- [ ] YouTube feeds use `channel` (`@Handle`) or `channel_id` (`UC...`), not both
- [ ] `mvp.status` is `"active"` or `"former"` — omit the entire `mvp` field if status is unknown
- [ ] `github-releases` `repo` is in `owner/repo` format
- [ ] No extra fields beyond what the schema allows (`additionalProperties: false` will reject them)

## When to use sub-agents

### Use parallel agents for: adding multiple people at once

Each person file is fully independent. If asked to add 3+ people, spawn one agent per person to write and validate their files concurrently rather than sequentially.

### Use an isolated agent for: feed/pipeline investigation

If a person's content isn't appearing on the site, delegate investigation to an agent so the diagnostic output (DB queries, raw feed XML, HTTP headers) doesn't flood the main context. Tell it to check: the person's feed URLs return valid XML, their items exist in `_data/items.json`, and their handle matches exactly.

### Use an agent for: bulk audits across all 112 people

Tasks like "flag everyone with a dead feed URL" or "find all people missing a GitHub link" are a good fit for an Explore-type agent — it can scan all files and return a summary without the full content clogging the conversation.

### Don't bother for: single-person edits, template tweaks, CSS changes

Routine edits don't benefit from sub-agents. Just do the work directly and run the verification steps above.

## Domain knowledge

- **MMS** = Microsoft Management Summit, a major endpoint management conference
- **MVP** = Microsoft Most Valuable Professional program
- Focus areas: ConfigMgr (MECM/SCCM), Intune, Entra ID (Azure AD), Windows Autopilot, endpoint security
- The site deliberately does **not** republish content — it links only
- `mvp.status` should be omitted when unknown, not guessed
