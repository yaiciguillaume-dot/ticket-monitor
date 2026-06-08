import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');
mkdirSync(dataDir, { recursive: true });

const db = new Database(join(dataDir, 'monitor.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS targets (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT,
    url           TEXT NOT NULL,
    keyword       TEXT NOT NULL DEFAULT 'Épuisé',  -- texte qui marque "complet"
    interval_sec  INTEGER NOT NULL DEFAULT 60,
    enabled       INTEGER NOT NULL DEFAULT 1,
    wait_selector TEXT,                            -- selecteur optionnel à attendre
    last_status   TEXT DEFAULT 'pending',          -- pending | available | soldout | error
    last_checked  INTEGER,
    available     TEXT DEFAULT '[]',               -- JSON: catégories dispo
    last_error    TEXT,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id INTEGER NOT NULL,
    type      TEXT NOT NULL,        -- available | soldout | error | check
    message   TEXT,
    created_at INTEGER NOT NULL
  );
`);

export const queries = {
  listTargets: db.prepare('SELECT * FROM targets ORDER BY created_at DESC'),
  getTarget: db.prepare('SELECT * FROM targets WHERE id = ?'),
  insertTarget: db.prepare(`
    INSERT INTO targets (name, url, keyword, interval_sec, enabled, wait_selector, created_at)
    VALUES (@name, @url, @keyword, @interval_sec, @enabled, @wait_selector, @created_at)
  `),
  deleteTarget: db.prepare('DELETE FROM targets WHERE id = ?'),
  setEnabled: db.prepare('UPDATE targets SET enabled = ? WHERE id = ?'),
  updateResult: db.prepare(`
    UPDATE targets
    SET last_status = @last_status, last_checked = @last_checked,
        available = @available, last_error = @last_error
    WHERE id = @id
  `),
  insertEvent: db.prepare(`
    INSERT INTO events (target_id, type, message, created_at)
    VALUES (@target_id, @type, @message, @created_at)
  `),
  recentEvents: db.prepare('SELECT * FROM events ORDER BY created_at DESC LIMIT ?'),
};

export default db;
