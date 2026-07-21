'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

// На Timeweb/локально путь к данным через DATA_DIR (persistent volume), иначе рядом с проектом.
// Относительный DATA_DIR раскрываем от КОРНЯ ПРОЕКТА, а не от cwd процесса —
// иначе при запуске из другой папки база уедет не туда и данные «потеряются».
const rawDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_DIR = path.isAbsolute(rawDir) ? rawDir : path.resolve(__dirname, '..', rawDir);
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'crm.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS clients (
    id                  INTEGER PRIMARY KEY,
    yclients_id         INTEGER UNIQUE,
    name                TEXT,
    phone               TEXT,
    first_visit         TEXT,
    last_visit          TEXT,
    visits_count        INTEGER DEFAULT 0,
    spent               REAL DEFAULT 0,
    avg_interval_days   REAL,
    predicted_next      TEXT,
    favorite_staff      TEXT,
    favorite_service    TEXT,
    updated_at          TEXT
  );

  CREATE TABLE IF NOT EXISTS visits (
    id                  INTEGER PRIMARY KEY,
    yclients_record_id  INTEGER UNIQUE,
    client_id           INTEGER REFERENCES clients(id),
    date                TEXT,           -- ISO
    service             TEXT,
    staff               TEXT,
    cost                REAL DEFAULT 0,
    status              TEXT            -- completed | upcoming | no_show | cancelled
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id                  INTEGER PRIMARY KEY,
    client_id           INTEGER REFERENCES clients(id),
    type                TEXT,           -- confirm_visit | rebook | reactivation | no_show
    due_date            TEXT,
    priority            INTEGER DEFAULT 2,  -- 1 высокий .. 3 низкий
    status              TEXT DEFAULT 'open', -- open | done | snoozed
    reason              TEXT,
    assigned_to         TEXT,
    created_at          TEXT,
    closed_at           TEXT
  );

  CREATE TABLE IF NOT EXISTS task_actions (
    id                  INTEGER PRIMARY KEY,
    task_id             INTEGER REFERENCES tasks(id),
    client_id           INTEGER REFERENCES clients(id),
    admin               TEXT,
    result              TEXT,           -- booked | callback | refused | no_answer | wrong_number | done
    note                TEXT,
    created_at          TEXT
  );

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  -- Списки-кампании обзвона, собранные через конструктор выборок
  CREATE TABLE IF NOT EXISTS lists (
    id          INTEGER PRIMARY KEY,
    name        TEXT,
    filter_json TEXT,
    status      TEXT DEFAULT 'active',  -- active | archived
    created_at  TEXT
  );

  CREATE TABLE IF NOT EXISTS list_members (
    id            INTEGER PRIMARY KEY,
    list_id       INTEGER REFERENCES lists(id),
    client_id     INTEGER REFERENCES clients(id),
    status        TEXT DEFAULT 'pending',  -- pending | done | snoozed
    result        TEXT,
    note          TEXT,
    admin         TEXT,
    match_visits  INTEGER,
    match_spent   REAL,
    updated_at    TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_lm_list ON list_members(list_id);

  CREATE INDEX IF NOT EXISTS idx_visits_client ON visits(client_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_actions_client ON task_actions(client_id);
`);

module.exports = { db, DATA_DIR };
