import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { db, dbEnabled, ensureSchema } from "./db";

// Chat threads for logged-in users (keyed by wallet address). Trust note:
// the handle is client-claimed, fine for reading your OWN history, never
// used for authorization (spend caps stay key-based). Same dual backend as
// members.ts: Postgres when DATABASE_URL is set, else gitignored JSON.

export interface ChatMsg {
  role: string;
  content: string;
  receipt?: string;
  settled?: boolean;
  ts: number;
}

export interface ChatThread {
  id: string;
  title: string;
  updatedAt: number;
  msgs: ChatMsg[];
}

interface ThreadsFile {
  threads: Record<string, Record<string, ChatThread>>; // user -> id -> thread
}

interface ThreadsBackend {
  load(user: string): Promise<ChatThread[]>;
  save(user: string, threads: ChatThread[]): Promise<void>;
}

function storePath(): string {
  const dir = process.env.TOR_MEMBERS_DIR ?? join(process.cwd(), ".data");
  return join(dir, "chat-threads.json");
}

const fileBackend: ThreadsBackend = {
  async load(user: string): Promise<ChatThread[]> {
    try {
      const raw = JSON.parse(readFileSync(storePath(), "utf8")) as ThreadsFile;
      return Object.values(raw.threads?.[user] ?? {}).sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      return [];
    }
  },
  async save(user: string, threads: ChatThread[]): Promise<void> {
    let all: ThreadsFile = { threads: {} };
    try {
      all = JSON.parse(readFileSync(storePath(), "utf8")) as ThreadsFile;
    } catch {}
    all.threads = all.threads ?? {};
    all.threads[user] = Object.fromEntries(threads.map((t) => [t.id, t]));
    const p = storePath();
    mkdirSync(join(p, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(p, JSON.stringify(all, null, 2), { mode: 0o600 });
    try {
      chmodSync(p, 0o600);
    } catch {}
  },
};

const pgBackend: ThreadsBackend = {
  async load(user: string): Promise<ChatThread[]> {
    await ensureSchema(join(process.cwd(), "schema.sql"));
    const q = db();
    const { rows: t } = await q.query(`SELECT thread_id, title, updated_at FROM chat_threads WHERE user_handle = $1 ORDER BY updated_at DESC LIMIT 30`, [user]);
    const out: ChatThread[] = [];
    for (const r of t) {
      const { rows: m } = await q.query(
        `SELECT role, content, receipt, settled, ts FROM chat_messages WHERE user_handle = $1 AND thread_id = $2 ORDER BY idx ASC`,
        [user, r.thread_id],
      );
      out.push({
        id: r.thread_id,
        title: r.title,
        updatedAt: Number(r.updated_at),
        msgs: m.map((x) => ({ role: x.role, content: x.content, receipt: x.receipt ?? undefined, settled: x.settled ?? undefined, ts: Number(x.ts) })),
      });
    }
    return out;
  },
  async save(user: string, threads: ChatThread[]): Promise<void> {
    await ensureSchema(join(process.cwd(), "schema.sql"));
    const q = db();
    for (const t of threads.slice(0, 30)) {
      await q.query(
        `INSERT INTO chat_threads (user_handle, thread_id, title, updated_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (user_handle, thread_id) DO UPDATE SET title = EXCLUDED.title, updated_at = EXCLUDED.updated_at`,
        [user, t.id, t.title, t.updatedAt],
      );
      await q.query(`DELETE FROM chat_messages WHERE user_handle = $1 AND thread_id = $2`, [user, t.id]);
      for (let i = 0; i < t.msgs.length; i++) {
        const m = t.msgs[i];
        await q.query(
          `INSERT INTO chat_messages (user_handle, thread_id, idx, role, content, receipt, settled, ts)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [user, t.id, i, m.role, m.content, m.receipt ?? null, m.settled ?? null, m.ts ?? Date.now()],
        );
      }
    }
  },
};

function backend(): ThreadsBackend {
  return dbEnabled() ? pgBackend : fileBackend;
}

export async function listThreads(user: string): Promise<ChatThread[]> {
  if (!user) return [];
  return backend().load(user);
}

export async function saveThreads(user: string, threads: ChatThread[]): Promise<void> {
  if (!user) return;
  return backend().save(user, threads);
}
