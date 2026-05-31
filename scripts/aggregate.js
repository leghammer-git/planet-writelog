#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { DatabaseSync } from "node:sqlite";
import { XMLParser } from "fast-xml-parser";
import fetch from "node-fetch";
import pLimit from "p-limit";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const DB_PATH = join(root, "aggregator.db");
const PEOPLE_DIR = join(root, "people");
const DATA_DIR = join(root, "_data");
const CONCURRENCY = 10;
const TIMEOUT_MS = 15_000;
const MAX_ITEMS = 5000;
const DESC_MAX = 280;

// ── database setup ────────────────────────────────────────────────────────────

function openDb() {
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS feeds (
      url TEXT PRIMARY KEY,
      etag TEXT,
      last_modified TEXT,
      fetched_at TEXT
    );
    CREATE TABLE IF NOT EXISTS youtube_channels (
      handle TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS github_repos (
      username    TEXT PRIMARY KEY,
      repos_json  TEXT NOT NULL,
      fetched_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      person_handle TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      link TEXT NOT NULL,
      published_at TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );
  `);
  try { db.exec("ALTER TABLE items ADD COLUMN source TEXT"); } catch {}
  return db;
}

// Seed from existing items.json so dedup history isn't lost on cold start
function seedFromJson(db) {
  const path = join(DATA_DIR, "items.json");
  if (!existsSync(path)) return;
  let existing;
  try {
    existing = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.warn(`  ⚠ items.json is invalid (${err.message}) — starting with empty history`);
    return;
  }
  const insert = db.prepare(`
    INSERT OR IGNORE INTO items (id, person_handle, type, title, description, link, published_at, fetched_at, source)
    VALUES (@id, @person_handle, @type, @title, @description, @link, @published_at, @fetched_at, @source)
  `);
  db.exec("BEGIN");
  try {
    for (const r of existing) insert.run(r);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(url, options = {}, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchWithTimeout(url, options);
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
}

// ── GitHub rate-limit-aware fetcher ───────────────────────────────────────────

const GH_UA = "planet-writelog-aggregator";
// Lower concurrency for the REST API: unauthenticated = 60 req/hr, authenticated = 5000 req/hr
const ghLimit = pLimit(process.env.GITHUB_TOKEN ? 5 : 2);

async function fetchGitHub(url, headers) {
  for (let attempt = 0; attempt < 4; attempt++) {
    let res;
    try {
      res = await fetchWithTimeout(url, { headers });
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }

    if (res.status === 429 || res.status === 403) {
      const remaining = parseInt(res.headers.get("x-ratelimit-remaining") ?? "-1", 10);
      const reset     = parseInt(res.headers.get("x-ratelimit-reset")     ?? "0",  10) * 1000;
      const after     = parseInt(res.headers.get("retry-after")           ?? "0",  10) * 1000;
      // Only back off when it's actually a rate limit, not a permission error
      if (remaining === 0 || after > 0) {
        const waitMs = after || Math.max(reset - Date.now(), 0) + 500;
        if (waitMs > 60_000) {
          const mins = Math.ceil(waitMs / 60_000);
          throw new Error(
            `GitHub rate limit exceeded — resets in ~${mins} min. Set GITHUB_TOKEN to increase quota.`
          );
        }
        if (attempt < 3) {
          console.warn(`  GitHub rate limited (${res.status}), waiting ${Math.ceil(waitMs / 1000)}s…`);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
      }
    }

    return res;
  }
  throw new Error(`GitHub request failed after retries: ${url}`);
}

// ── text helpers ──────────────────────────────────────────────────────────────

function decodeEntities(str) {
  if (!str) return str;
  return str
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripHtml(str) {
  if (!str) return "";
  return str.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function truncate(str, max) {
  if (!str || str.length <= max) return str;
  return str.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

function cleanText(raw) {
  return decodeEntities(typeof raw === "object" ? (raw?.["#text"] ?? "") : (raw ?? ""));
}

function cleanDesc(raw) {
  return truncate(decodeEntities(stripHtml(raw)), DESC_MAX);
}

function deriveSource(feedDef) {
  if (feedDef.label) return feedDef.label;
  if (feedDef.type === "youtube") return "YouTube";
  if (feedDef.type === "github-releases" || feedDef.type === "github-user") return "GitHub";
  try { return new URL(feedDef.url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function toISO(val) {
  if (!val) return new Date().toISOString();
  const d = new Date(val);
  return isNaN(d) ? new Date().toISOString() : d.toISOString();
}

// ── YouTube channel resolution ────────────────────────────────────────────────

async function resolveYouTubeChannelId(handle, db) {
  const cached = db.prepare("SELECT channel_id FROM youtube_channels WHERE handle = ?").get(handle);
  if (cached) return cached.channel_id;

  const url = `https://www.youtube.com/${handle.startsWith("@") ? handle : "@" + handle}`;
  const res = await fetchWithRetry(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; planet-writelog/1.0; +https://planet-writelog.pages.dev)" },
  });
  if (!res.ok) throw new Error(`YouTube channel page returned ${res.status} for ${handle}`);
  const html = await res.text();

  const match = html.match(/channel_id=(UC[\w-]+)/);
  if (!match) throw new Error(`Could not find channel ID for ${handle}`);

  db.prepare("INSERT OR REPLACE INTO youtube_channels (handle, channel_id) VALUES (?, ?)").run(handle, match[1]);
  return match[1];
}

// ── XML parser ────────────────────────────────────────────────────────────────

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) => ["entry", "item"].includes(name),
  processEntities: { enabled: true, maxTotalExpansions: 10000 },
});

// ── feed type registry ────────────────────────────────────────────────────────

const feedTypes = {
  blog: {
    url(feed) {
      return feed.url;
    },
    parse(xml, handle, feedDef = {}) {
      const doc = parser.parse(xml);
      const authorFilter = feedDef.author?.toLowerCase() ?? null;

      function authorMatches(raw) {
        if (!authorFilter) return true;
        const val = typeof raw === "object" ? (raw?.name ?? raw?.["#text"] ?? "") : (raw ?? "");
        return val.toLowerCase().includes(authorFilter);
      }

      // Atom
      if (doc.feed?.entry) {
        return doc.feed.entry
          .filter((e) => authorMatches(e.author))
          .map((e) => ({
            id: e.id || e.link?.["@_href"] || e.link,
            person_handle: handle,
            type: "blog",
            title: cleanText(e.title),
            description: cleanDesc(e.summary?.["#text"] || e.summary || e.content?.["#text"] || e.content || ""),
            link: e.link?.["@_href"] || e.link || "",
            published_at: toISO(e.published || e.updated),
          }));
      }
      // RSS
      const items = doc.rss?.channel?.item || doc.rdf?.channel?.item || [];
      return items
        .filter((i) => authorMatches(i["dc:creator"] || i.author))
        .map((i) => ({
          id: i.guid?.["#text"] || i.guid || i.link || "",
          person_handle: handle,
          type: "blog",
          title: cleanText(i.title),
          description: cleanDesc(i.description || i["content:encoded"] || ""),
          link: i.link || "",
          published_at: toISO(i.pubDate || i["dc:date"]),
        }));
    },
  },

  "github-releases": {
    url(feed) {
      return `https://github.com/${feed.repo}/releases.atom`;
    },
    parse(xml, handle) {
      const doc = parser.parse(xml);
      const entries = doc.feed?.entry || [];
      return entries.map((e) => ({
        id: e.id || e.link?.["@_href"],
        person_handle: handle,
        type: "github-releases",
        title: cleanText(e.title),
        description: cleanDesc(e.content?.["#text"] || e.content || e.summary || ""),
        link: e.link?.["@_href"] || e.link || "",
        published_at: toISO(e.published || e.updated),
      }));
    },
  },

  youtube: {
    url(feed) {
      return `https://www.youtube.com/feeds/videos.xml?channel_id=${feed.channel_id}`;
    },
    parse(xml, handle) {
      const doc = parser.parse(xml);
      const entries = doc.feed?.entry || [];
      return entries.map((e) => {
        const group = e["media:group"] || {};
        return {
          id: e.id || e["yt:videoId"],
          person_handle: handle,
          type: "youtube",
          title: cleanText(e.title),
          description: cleanDesc(group["media:description"] || ""),
          link: e.link?.["@_href"] || `https://www.youtube.com/watch?v=${e["yt:videoId"]}`,
          published_at: toISO(e.published),
        };
      });
    },
  },

  "github-user": {
    async fetchAll(feedDef, handle, db) {
      const { username } = feedDef;
      const apiHeaders = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": GH_UA,
      };
      if (process.env.GITHUB_TOKEN) apiHeaders["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;

      // Check DB cache first (24 hr TTL) to avoid redundant REST API calls
      const REPOS_TTL_MS = 24 * 60 * 60 * 1000;
      const cached = db.prepare("SELECT repos_json, fetched_at FROM github_repos WHERE username = ?").get(username);
      let repos;
      if (cached && Date.now() - new Date(cached.fetched_at).getTime() < REPOS_TTL_MS) {
        repos = JSON.parse(cached.repos_json);
      } else {
        const reposRes = await ghLimit(() =>
          fetchGitHub(
            `https://api.github.com/users/${username}/repos?sort=pushed&per_page=30&type=public`,
            apiHeaders
          )
        );
        if (!reposRes.ok) throw new Error(`GitHub API ${reposRes.status} for user ${username}`);
        repos = await reposRes.json();
        db.prepare("INSERT OR REPLACE INTO github_repos (username, repos_json, fetched_at) VALUES (?, ?, ?)")
          .run(username, JSON.stringify(repos), new Date().toISOString());
      }

      // Use releases.atom instead of REST API — not subject to REST rate limits
      const atomLimit = pLimit(5);
      const items = await Promise.all(
        repos.map((repo) =>
          atomLimit(async () => {
            try {
              const r = await fetchWithRetry(
                `https://github.com/${username}/${repo.name}/releases.atom`,
                { headers: { "User-Agent": GH_UA } }
              );
              if (r.ok) {
                const doc = parser.parse(await r.text());
                const entry = (doc.feed?.entry || [])[0];
                if (entry) {
                  return {
                    id: repo.html_url,
                    person_handle: handle,
                    type: "github-releases",
                    title: `${repo.name} ${cleanText(entry.title)}`,
                    description: cleanDesc(entry.content?.["#text"] || entry.content || ""),
                    link: entry.link?.["@_href"] || repo.html_url,
                    published_at: toISO(entry.updated),
                  };
                }
              }
            } catch {}
            return {
              id: repo.html_url,
              person_handle: handle,
              type: "github-releases",
              title: repo.name,
              description: cleanDesc(repo.description || ""),
              link: repo.html_url,
              published_at: toISO(repo.pushed_at || repo.updated_at),
            };
          })
        )
      );
      return items.filter(Boolean);
    },
  },
};

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const db = openDb();
  seedFromJson(db);

  const peopleFiles = readdirSync(PEOPLE_DIR).filter(
    (f) => f.endsWith(".json") && f !== "schema.json"
  );
  const people = peopleFiles.map((f) =>
    JSON.parse(readFileSync(join(PEOPLE_DIR, f), "utf8"))
  );

  // Resolve YouTube channel handles (@name → UC…) with DB caching — runs in parallel
  await Promise.all(
    people.flatMap((person) =>
      person.feeds
        .filter((f) => f.type === "youtube" && f.channel && !f.channel_id)
        .map((feedDef) =>
          resolveYouTubeChannelId(feedDef.channel, db)
            .then((id) => { feedDef.channel_id = id; })
            .catch((err) => console.warn(
              `  ⚠ Could not resolve YouTube channel ${feedDef.channel} for ${person.handle}: ${err.message}`
            ))
        )
    )
  );

  // Group URL-based feeds by URL so each remote feed is fetched once, even
  // when multiple people share the same feed URL (e.g. a multi-author blog).
  const urlGroups = new Map(); // url -> [{ person, feedDef, handler }]
  const fetchAllJobs = []; // { person, feedDef } — github-user etc.

  for (const person of people) {
    for (const feedDef of person.feeds) {
      const handler = feedTypes[feedDef.type];
      if (!handler) continue;
      if (handler.fetchAll) {
        fetchAllJobs.push({ person, feedDef });
      } else {
        const url = handler.url(feedDef);
        if (!urlGroups.has(url)) urlGroups.set(url, []);
        urlGroups.get(url).push({ person, feedDef, handler });
      }
    }
  }

  const limit = pLimit(CONCURRENCY);
  const now = new Date().toISOString();
  const results = [];

  const upsertFeed = db.prepare(`
    INSERT INTO feeds (url, etag, last_modified, fetched_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET etag=excluded.etag, last_modified=excluded.last_modified, fetched_at=excluded.fetched_at
  `);
  const insertItem = db.prepare(`
    INSERT OR IGNORE INTO items (id, person_handle, type, title, description, link, published_at, fetched_at, source)
    VALUES (@id, @person_handle, @type, @title, @description, @link, @published_at, @fetched_at, @source)
  `);
  const replaceItem = db.prepare(`
    INSERT OR REPLACE INTO items (id, person_handle, type, title, description, link, published_at, fetched_at, source)
    VALUES (@id, @person_handle, @type, @title, @description, @link, @published_at, @fetched_at, @source)
  `);

  function insertParsed(parsed) {
    let newCount = 0;
    db.exec("BEGIN");
    try {
      for (const item of parsed) {
        if (!item.id || !item.link) continue;
        const info = insertItem.run({ ...item, fetched_at: now });
        if (info.changes > 0) newCount++;
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return newCount;
  }

  function upsertParsed(parsed) {
    db.exec("BEGIN");
    try {
      for (const item of parsed) {
        if (!item.id || !item.link) continue;
        replaceItem.run({ ...item, fetched_at: now });
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return parsed.filter((i) => i.id && i.link).length;
  }

  // Fetch each unique URL once, then parse + insert for every person sharing it
  const urlTasks = [...urlGroups.entries()].map(([url, entries]) =>
    limit(async () => {
      const row = db.prepare("SELECT etag, last_modified FROM feeds WHERE url = ?").get(url);
      const headers = { "User-Agent": "Mozilla/5.0 (compatible; planet-writelog/1.0; +https://planet-writelog.pages.dev)" };
      if (row?.etag) headers["If-None-Match"] = row.etag;
      if (row?.last_modified) headers["If-Modified-Since"] = row.last_modified;

      let res;
      try {
        res = await fetchWithRetry(url, { headers });
      } catch (err) {
        for (const { person, feedDef } of entries)
          results.push({ person: person.handle, feed: feedDef.type, ok: false, error: err.message });
        return;
      }

      if (res.status === 304) {
        for (const { person, feedDef } of entries)
          results.push({ person: person.handle, feed: feedDef.type, url, newCount: 0, skipped: true, ok: true });
        return;
      }

      if (!res.ok) {
        const msg = `HTTP ${res.status} for ${url}`;
        for (const { person, feedDef } of entries)
          results.push({ person: person.handle, feed: feedDef.type, ok: false, error: msg });
        return;
      }

      const xml = await res.text();
      upsertFeed.run(url, res.headers.get("etag") || null, res.headers.get("last-modified") || null, now);

      for (const { person, feedDef, handler } of entries) {
        try {
          const source = deriveSource(feedDef);
          const parsed = handler.parse(xml, person.handle, feedDef).map((item) => ({ ...item, source }));
          const newCount = insertParsed(parsed);
          results.push({ person: person.handle, feed: feedDef.type, url, newCount, total: parsed.length, ok: true });
        } catch (err) {
          results.push({ person: person.handle, feed: feedDef.type, ok: false, error: err.message });
        }
      }
    })
  );

  // fetchAll feeds (e.g. github-user) are always per-person
  const noToken = !process.env.GITHUB_TOKEN;
  if (noToken && fetchAllJobs.some((j) => j.feedDef.type === "github-user")) {
    console.warn(
      "\n  ⚠ GITHUB_TOKEN is not set — skipping all github-user feeds.\n" +
      "    Unauthenticated quota is 60 req/hr, insufficient for this many users.\n" +
      "    Set GITHUB_TOKEN to enable GitHub feed aggregation.\n"
    );
  }

  const fetchAllTasks = fetchAllJobs
    .filter(({ feedDef }) => !(noToken && feedDef.type === "github-user"))
    .map(({ person, feedDef }) =>
      limit(async () => {
        const handler = feedTypes[feedDef.type];
        try {
          const source = deriveSource(feedDef);
          const rawParsed = await handler.fetchAll(feedDef, person.handle, db);
          const parsed = rawParsed.map((item) => ({ ...item, source }));
          const newCount = upsertParsed(parsed);
          results.push({ person: person.handle, feed: feedDef.type, newCount, total: parsed.length, ok: true });
        } catch (err) {
          results.push({ person: person.handle, feed: feedDef.type, ok: false, error: err.message });
        }
      })
    );

  await Promise.all([...urlTasks, ...fetchAllTasks]);

  // Group by person for logging
  const byPerson = {};
  for (const r of results) {
    (byPerson[r.person] ??= []).push(r);
  }

  let totalNew = 0;
  console.log("\n── Aggregator summary ──────────────────────────────────");
  for (const [handle, feedResults] of Object.entries(byPerson)) {
    for (const r of feedResults) {
      if (r.ok) {
        const tag = r.skipped ? "304 cached" : `+${r.newCount} new`;
        console.log(`  ✓ ${handle}/${r.feed}  ${tag}`);
        totalNew += r.newCount ?? 0;
      } else {
        console.log(`  ✗ ${handle}/${r.feed}  ERROR: ${r.error}`);
      }
    }
  }
  console.log(`────────────────────────────────────────────────────────`);
  console.log(`  Total new items: ${totalNew}`);

  // Write _data/items.json (most recent MAX_ITEMS) — entities already decoded before DB insert
  const allItems = db
    .prepare("SELECT * FROM items ORDER BY published_at DESC LIMIT ?")
    .all(MAX_ITEMS);
  writeFileSync(join(DATA_DIR, "items.json"), JSON.stringify(allItems, null, 2));

  // Write _data/people.json
  writeFileSync(join(DATA_DIR, "people.json"), JSON.stringify(people, null, 2));

  db.close();
  console.log(`\n  Wrote _data/items.json (${allItems.length} items) and _data/people.json (${people.length} people)\n`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
