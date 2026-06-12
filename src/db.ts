import fs from "node:fs";
import path from "node:path";
// pg is CJS; default-import then destructure is the ESM-safe form.
import pg from "pg";

// Document store with two backends:
// - Postgres (set DATABASE_URL) — durable across serverless instances; required
//   for surveys to work correctly on Vercel (webhooks and polls hit different
//   instances).
// - JSON files in .data/ — local dev and degraded single-instance fallback.
// One JSONB row per document, keyed by (table, id). Documents carry their own
// createdAt; listing returns newest-first.

// Documents are plain JSON values; callers cast to their record types.
type Doc = unknown;

interface Backend {
  get(table: string, id: string): Promise<Doc | undefined>;
  put(table: string, id: string, doc: Doc): Promise<void>;
  /** Atomic insert; returns false if the id already exists. Used for webhook dedupe. */
  insertIfAbsent(table: string, id: string, doc: Doc): Promise<boolean>;
  list(table: string, limit: number): Promise<Doc[]>;
  clear(table: string): Promise<number>;
}

// --- Postgres backend ------------------------------------------------------

function createPgBackend(connectionString: string): Backend {
  const pool = new pg.Pool({ connectionString, max: 3 });
  // An idle client losing its backend connection emits 'error' on the pool;
  // without a listener that crashes the whole process.
  pool.on("error", (err) => console.warn("db: idle client error:", err.message));

  let schemaReady: Promise<unknown> | null = null;
  function ensureSchema(): Promise<unknown> {
    schemaReady ??= pool
      .query(
        `
      CREATE TABLE IF NOT EXISTS docs (
        tbl TEXT NOT NULL,
        id TEXT NOT NULL,
        doc JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (tbl, id)
      );
      CREATE INDEX IF NOT EXISTS docs_tbl_created ON docs (tbl, created_at DESC);
    `,
      )
      .catch((err) => {
        // Don't cache a rejection — a transient failure here would otherwise
        // brick every query for the rest of the instance's lifetime.
        schemaReady = null;
        throw err;
      });
    return schemaReady;
  }

  return {
    async get(table, id) {
      await ensureSchema();
      const res = await pool.query("SELECT doc FROM docs WHERE tbl = $1 AND id = $2", [table, id]);
      return res.rows[0]?.doc as Doc | undefined;
    },
    async put(table, id, doc) {
      await ensureSchema();
      await pool.query(
        `INSERT INTO docs (tbl, id, doc) VALUES ($1, $2, $3)
         ON CONFLICT (tbl, id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()`,
        [table, id, doc],
      );
    },
    async insertIfAbsent(table, id, doc) {
      await ensureSchema();
      const res = await pool.query(
        "INSERT INTO docs (tbl, id, doc) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [table, id, doc],
      );
      return (res.rowCount ?? 0) > 0;
    },
    async list(table, limit) {
      await ensureSchema();
      const res = await pool.query(
        "SELECT doc FROM docs WHERE tbl = $1 ORDER BY created_at DESC LIMIT $2",
        [table, limit],
      );
      return res.rows.map((r) => r.doc as Doc);
    },
    async clear(table) {
      await ensureSchema();
      const res = await pool.query("DELETE FROM docs WHERE tbl = $1", [table]);
      return res.rowCount ?? 0;
    },
  };
}

// --- JSON file backend -----------------------------------------------------

function createFileBackend(): Backend {
  const DATA_DIR = path.join(process.cwd(), ".data");
  const cache: Record<string, Record<string, Doc>> = {};

  function fileFor(table: string): string {
    return path.join(DATA_DIR, `${table}.json`);
  }

  function load(table: string): Record<string, Doc> {
    if (!cache[table]) {
      try {
        cache[table] = JSON.parse(fs.readFileSync(fileFor(table), "utf8"));
      } catch {
        cache[table] = {};
      }
    }
    return cache[table];
  }

  function persist(table: string): void {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      // Write-then-rename: a crash mid-write must not corrupt the table (a
      // corrupt file parses as {} on next load, silently wiping e.g. the
      // do-not-call list).
      const tmp = `${fileFor(table)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(cache[table], null, 2));
      fs.renameSync(tmp, fileFor(table));
    } catch (err) {
      // Best-effort (read-only serverless FS); memory still works per instance.
      console.warn(`db: persist ${table} failed:`, (err as Error).message);
    }
  }

  return {
    async get(table, id) {
      return load(table)[id];
    },
    async put(table, id, doc) {
      load(table)[id] = doc;
      persist(table);
    },
    async insertIfAbsent(table, id, doc) {
      const docs = load(table);
      if (docs[id]) return false;
      docs[id] = doc;
      persist(table);
      return true;
    },
    async list(table, limit) {
      const createdAt = (d: Doc) => String((d as { createdAt?: string })?.createdAt ?? "");
      return Object.values(load(table))
        .sort((a, b) => createdAt(b).localeCompare(createdAt(a)))
        .slice(0, limit);
    },
    async clear(table) {
      const docs = load(table);
      const count = Object.keys(docs).length;
      cache[table] = {};
      persist(table);
      return count;
    },
  };
}

// --- Singleton -------------------------------------------------------------

let backend: Backend | null = null;

export function db(): Backend {
  backend ??= process.env.DATABASE_URL
    ? createPgBackend(process.env.DATABASE_URL)
    : createFileBackend();
  return backend;
}

export function durableStoreConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}
