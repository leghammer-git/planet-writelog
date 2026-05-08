# Planet WriteLog

A community aggregator for the [Microsoft Management Summit (MMS)](https://mmsmoa.com) community. Surfaces blog posts, GitHub releases, and YouTube videos from MVPs and presenters — linking out, never republishing.

**Live site:** https://planet-writelog.pages.dev

---

## Adding yourself

1. **Fork this repo** and create a new branch.

2. **Create `people/{your-handle}.json`** — handle must be lowercase alphanumeric + hyphens:

```json
{
  "name": "Your Name",
  "handle": "your-handle",
  "pronouns": "they/them",
  "title": "MVP · Endpoint Management",
  "bio": "One or two sentences about yourself.",
  "links": {
    "website": "https://yourblog.com",
    "github": "your-github",
    "bluesky": "you.bsky.social"
  },
  "feeds": [
    { "type": "blog",            "url": "https://yourblog.com/feed.xml" },
    { "type": "github-releases", "repo": "your-github/your-repo" },
    { "type": "youtube",         "channel_id": "UCxxxxxxxxxxxxxxxx" }
  ]
}
```

All fields except `name`, `handle`, `title`, `bio`, and at least one feed are optional.

3. **Open a pull request.** CI validates your JSON automatically. Once merged, you'll appear in the feed within the hour.

> Your handle in `.github/CODEOWNERS` gives you write access to your own file in future PRs.

---

## Supported feed types

| type | what it fetches |
|---|---|
| `blog` | Any RSS 2.0 or Atom feed URL |
| `github-releases` | GitHub releases Atom feed for `owner/repo` |
| `youtube` | YouTube channel feed for `channel_id` (starts with `UC`) |

---

## Local development

```bash
# Prerequisites: Node 20+

git clone https://github.com/leghammer-git/planet-writelog
cd planet-writelog
npm install

# Fetch feeds and write _data/items.json + _data/people.json
npm run aggregate

# Build the site
npm run build        # output: _site/

# Dev server with live reload
npm start            # http://localhost:8080
```

The aggregator stores fetch state in `aggregator.db` (gitignored). On a fresh clone it seeds dedup history from the committed `_data/items.json` so you won't re-add old items.

---

## Architecture

```
people/*.json        → source of truth for community members
scripts/aggregate.js → fetches feeds, writes _data/
_data/items.json     → committed; 11ty reads this at build time
_data/people.json    → committed; 11ty reads this at build time
src/                 → 11ty Nunjucks templates
public/              → static CSS + JS (passthrough copy)
_site/               → build output (gitignored)
```

GitHub Actions runs the aggregator hourly, commits updated `_data/`, and Cloudflare Pages auto-deploys on push to `main`.

---

## Contributing

Non-person PRs (bug fixes, new feed types, style changes) are welcome. Open an issue first for anything significant.

To add a new feed type, add a handler to the `feedTypes` registry in `scripts/aggregate.js` and update `people/schema.json`.
