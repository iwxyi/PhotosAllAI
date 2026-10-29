import { DatabaseSync } from 'node:sqlite';
import { agentSessionSchema, type AgentSession } from '@photoallisai/contracts';

export class AgentStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS agent_sessions (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, data TEXT NOT NULL)');
  }
  save(session: AgentSession): void {
    session.updatedAt = Math.max(Date.now(), session.updatedAt + 1);
    this.db.prepare('INSERT INTO agent_sessions (id, updated_at, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, data=excluded.data').run(session.id, session.updatedAt, JSON.stringify(agentSessionSchema.parse(session)));
  }
  get(id: string): AgentSession {
    const row = this.db.prepare('SELECT data FROM agent_sessions WHERE id=?').get(id) as { data: string } | undefined;
    if (!row) throw new Error('AGENT_SESSION_NOT_FOUND');
    return agentSessionSchema.parse(JSON.parse(row.data));
  }
  delete(id: string): void {
    this.db.prepare('DELETE FROM agent_sessions WHERE id=?').run(id);
  }
  list(): AgentSession[] {
    return (this.db.prepare('SELECT data FROM agent_sessions ORDER BY updated_at DESC LIMIT 100').all() as { data: string }[]).map((r) => agentSessionSchema.parse(JSON.parse(r.data)));
  }
  recoverable(): AgentSession[] {
    return (this.db.prepare("SELECT data FROM agent_sessions WHERE json_extract(data, '$.status') IN ('running', 'waiting')").all() as { data: string }[]).map((r) => agentSessionSchema.parse(JSON.parse(r.data)));
  }
  close(): void { this.db.close(); }
}
