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
const MAX_ITEMS = 500;
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
  return db;
}

// Seed from existing items.json so dedup history isn't lost on cold start
function seedFromJson(db) {
  const path = join(DATA_DIR, "items.json");
  if (!existsSync(path)) return;
  const existing = JSON.parse(readFileSync(path, "utf8"));
  const insert = db.prepare(`
    INSERT OR IGNORE INTO items (id, person_handle, type, title, description, link, published_at, fetched_at)
    VALUES (@id, @person_handle, @type, @title, @description, @link, @published_at, @fetched_at)
  `);
  for (const r of existing) insert.run(r);
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

// ── text helpers ──────────────────────────────────────────────────────────────

function stripHtml(str) {
  if (!str) return "";
  return str.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function truncate(str, max) {
  if (!str || str.length <= max) return str;
  return str.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

function cleanDesc(raw) {
  return truncate(stripHtml(raw), DESC_MAX);
}

function toISO(val) {
  if (!val) return new Date().toISOString();
  const d = new Date(val);
  return isNaN(d) ? new Date().toISOString() : d.toISOString();
}

// ── XML parser ────────────────────────────────────────────────────────────────

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) => ["entry", "item"].includes(name),
});

// ── feed type registry ────────────────────────────────────────────────────────

const feedTypes = {
  blog: {
    url(feed) {
      return feed.url;
    },
    parse(xml, handle) {
      const doc = parser.parse(xml);
      // Atom
      if (doc.feed?.entry) {
        return doc.feed.entry.map((e) => ({
          id: e.id || e.link?.["@_href"] || e.link,
          person_handle: handle,
          type: "blog",
          title: typeof e.title === "object" ? e.title["#text"] : e.title || "",
          description: cleanDesc(e.summary?.["#text"] || e.summary || e.content?.["#text"] || e.content || ""),
          link: e.link?.["@_href"] || e.link || "",
          published_at: toISO(e.published || e.updated),
        }));
      }
      // RSS
      const items = doc.rss?.channel?.item || doc.rdf?.channel?.item || [];
      return items.map((i) => ({
        id: i.guid?.["#text"] || i.guid || i.link || "",
        person_handle: handle,
        type: "blog",
        title: typeof i.title === "object" ? i.title["#text"] : i.title || "",
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
        title: typeof e.title === "object" ? e.title["#text"] : e.title || "",
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
          title: typeof e.title === "object" ? e.title["#text"] : e.title || "",
          description: cleanDesc(group["media:description"] || ""),
          link: e.link?.["@_href"] || `https://www.youtube.com/watch?v=${e["yt:videoId"]}`,
          published_at: toISO(e.published),
        };
      });
    },
  },
};

// ── per-feed fetch + parse ────────────────────────────────────────────────────

async function processFeed(db, person, feedDef) {
  const handler = feedTypes[feedDef.type];
  if (!handler) throw new Error(`Unknown feed type: ${feedDef.type}`);

  const url = handler.url(feedDef);
  const row = db.prepare("SELECT etag, last_modified FROM feeds WHERE url = ?").get(url);

  const headers = {};
  if (row?.etag) headers["If-None-Match"] = row.etag;
  if (row?.last_modified) headers["If-Modified-Since"] = row.last_modified;

  const res = await fetchWithRetry(url, { headers });

  if (res.status === 304) return { url, newCount: 0, skipped: true };

  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);

  const xml = await res.text();
  const parsed = handler.parse(xml, person.handle);

  const now = new Date().toISOString();
  const upsertFeed = db.prepare(`
    INSERT INTO feeds (url, etag, last_modified, fetched_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET etag=excluded.etag, last_modified=excluded.last_modified, fetched_at=excluded.fetched_at
  `);
  upsertFeed.run(url, res.headers.get("etag") || null, res.headers.get("last-modified") || null, now);

  const insertItem = db.prepare(`
    INSERT OR IGNORE INTO items (id, person_handle, type, title, description, link, published_at, fetched_at)
    VALUES (@id, @person_handle, @type, @title, @description, @link, @published_at, @fetched_at)
  `);

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

  return { url, newCount, total: parsed.length };
}

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

  const limit = pLimit(CONCURRENCY);

  const tasks = people.flatMap((person) =>
    person.feeds.map((feedDef) =>
      limit(async () => {
        try {
          const result = await processFeed(db, person, feedDef);
          return { person: person.handle, feed: feedDef.type, ...result, ok: true };
        } catch (err) {
          return { person: person.handle, feed: feedDef.type, ok: false, error: err.message };
        }
      })
    )
  );

  const results = await Promise.all(tasks);

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

  // Write _data/items.json (most recent 500)
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
