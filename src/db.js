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

// Юникод-aware нижний регистр: встроенные SQLite lower()/LIKE приводят к строчным
// ТОЛЬКО латиницу, кириллица остаётся как есть → поиск по «Алексей» не находил «Смирнов Алексей».
// JS toLowerCase() корректно фолдит кириллицу. Используем lower_u() во всех поисковых LIKE.
db.function('lower_u', (s) => (s == null ? null : String(s).toLowerCase()));

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
    assignee    TEXT,                   -- ответственный админ за проработку списка
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

  -- Прайс-лист услуг из YClients (для подсказок в конструкторе, включая услуги без визитов)
  CREATE TABLE IF NOT EXISTS services (
    id          INTEGER PRIMARY KEY,
    yc_id       INTEGER,
    company_id  INTEGER,
    branch      TEXT,
    title       TEXT,
    category    TEXT,
    price_min   REAL,
    price_max   REAL,
    active      INTEGER DEFAULT 1,
    updated_at  TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_services_uniq ON services(company_id, yc_id);

  -- VIP-клиенты: постоянный ручной список. Живёт, пока админ сам не удалит запись.
  -- Такие клиенты не должны попадать в выборки конструктора — их ведут персонально.
  CREATE TABLE IF NOT EXISTS vip_clients (
    id         INTEGER PRIMARY KEY,
    client_id  INTEGER UNIQUE REFERENCES clients(id),
    note       TEXT,
    added_by   TEXT,
    added_at   TEXT
  );

  -- Администраторы (редактируемый список) — для выбора «кто звонил» при фиксации звонка
  CREATE TABLE IF NOT EXISTS admins (
    id     INTEGER PRIMARY KEY,
    name   TEXT UNIQUE,
    active INTEGER DEFAULT 1,
    sort   INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_visits_client ON visits(client_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_actions_client ON task_actions(client_id);
`);

// --- Миграция: мультифилиальность (company_id + branch у clients и visits) ---
function ensureColumn(table, col, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}
ensureColumn('clients', 'company_id', 'INTEGER');
ensureColumn('clients', 'branch', 'TEXT');
ensureColumn('visits', 'company_id', 'INTEGER');
ensureColumn('visits', 'branch', 'TEXT');
ensureColumn('lists', 'assignee', 'TEXT');

// Комментарий из карточки клиента YClients + флаг «не беспокоить» (вычисляется по тексту)
ensureColumn('clients', 'comment', 'TEXT');
ensureColumn('clients', 'do_not_call', 'INTEGER DEFAULT 0');
ensureColumn('clients', 'comment_checked_at', 'TEXT');
// Ручное переопределение «не беспокоить» из дашборда: NULL = авто по комменту, 1 = принудительно да, 0 = принудительно нет
ensureColumn('clients', 'dnc_manual', 'INTEGER');
// Настоящие деньги из карточки YClients (с учётом депозитов) + остаток депозита
ensureColumn('clients', 'yc_spent', 'REAL');
ensureColumn('clients', 'yc_balance', 'REAL');
// Сколько строк-услуг стоит за визитами: visits_count теперь = походы в салон (календарные дни),
// а за один поход клиент берёт несколько услуг у разных мастеров — держим оба числа.
ensureColumn('clients', 'services_count', 'INTEGER');
// Персональная скидка клиента из карточки YClients (поле discount, в процентах).
// Заполняется проходом по карточкам вместе с комментарием и суммами.
ensureColumn('clients', 'yc_discount', 'REAL');
// Эффективная скидка: max(поле YClients, процент из имени, процент из комментария).
// Пересчитывается каждым синком — админы правят скидку прямо в имени клиента.
ensureColumn('clients', 'discount_pct', 'REAL');

// Одноразовый сброс под режим «не больше 10 открытых задач на филиал»:
// старый движок навалил сотни открытых задач — снимаем их, дальше держим по лимиту
if (!db.prepare("SELECT value FROM meta WHERE key='daily_cap_reset'").get()) {
  db.exec("UPDATE tasks SET status='dismissed', closed_at=datetime('now') WHERE status IN ('open','snoozed')");
  db.prepare("INSERT INTO meta(key,value) VALUES('daily_cap_reset','1')").run();
}
db.exec('CREATE INDEX IF NOT EXISTS idx_clients_branch ON clients(branch)');
db.exec('CREATE INDEX IF NOT EXISTS idx_visits_branch ON visits(branch)');

// Бэкфилл прежних строк (одиночный филиал) первым филиалом из конфига
(() => {
  const first = require('./yclients').companies()[0];
  if (!first || !first.id) return;
  const fid = Number(first.id);
  const fname = first.name || String(fid);
  if (!fid) return;
  db.prepare('UPDATE clients SET company_id=?, branch=? WHERE company_id IS NULL').run(fid, fname);
  db.prepare('UPDATE visits SET company_id=?, branch=? WHERE company_id IS NULL').run(fid, fname);
})();

module.exports = { db, DATA_DIR };
