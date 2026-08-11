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

  -- Покупки товаров. Приходят двумя путями: внутри записи (goods_transactions в /records —
  -- клиент купил шампунь на визите) и отдельной продажей на кассе без записи (/transactions
  -- + состав документа из /company/{id}/sale/{doc}). Сертификаты YClients продаёт как товар,
  -- поэтому они тоже здесь.
  CREATE TABLE IF NOT EXISTS purchases (
    id          INTEGER PRIMARY KEY,
    yc_id       INTEGER UNIQUE,         -- id товарной строки в YClients
    client_id   INTEGER REFERENCES clients(id),
    company_id  INTEGER,
    branch      TEXT,
    record_id   INTEGER,                -- запись-визит; NULL = покупка без визита
    date        TEXT,
    title       TEXT,
    good_id     INTEGER,
    qty         REAL DEFAULT 1,
    cost        REAL,                   -- сумма к оплате за строку
    discount    REAL DEFAULT 0,
    staff       TEXT,
    source      TEXT,                   -- record | sale
    updated_at  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_purchases_client ON purchases(client_id);
  CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(date);

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
// Эффективная скидка: max(поле YClients, процент из имени). Комментарий НЕ источник —
// там пишут про разовые скидки на продажах. Пересчитывается каждым синком.
ensureColumn('clients', 'discount_pct', 'REAL');
// Категории оказанных услуг визита (через ', '), денормализация прайс-листа.
// Нужна для группировки конструктора: без неё фильтр по группе перебирал бы
// каждую строку визита против 750 названий услуг.
ensureColumn('visits', 'service_category', 'TEXT');
// Черновик заметки о звонке: админ печатает, отвлекается, уходит на другую вкладку —
// текст должен пережить это и дождаться нажатия кнопки результата. Сохраняется на сервере,
// поэтому виден и после перезагрузки страницы, и второму администратору.
ensureColumn('tasks', 'draft_note', 'TEXT');
ensureColumn('list_members', 'draft_note', 'TEXT');
// Срок перезвона по участнику списка — то же, что due_date у задачи:
// «YYYY-MM-DD» или «YYYY-MM-DD HH:MM», если админ договорился на время.
ensureColumn('list_members', 'callback_at', 'TEXT');
// Из какой строки списка сделан звонок. Нужно, чтобы результат можно было ИСПРАВИТЬ
// («отказался» → «передумал и записался») и статус участника поменялся вместе с записью
// в ленте. У звонков по задачам эту роль играет task_id.
ensureColumn('task_actions', 'member_id', 'INTEGER');

// Разовая уборка: клиент уже дал окончательный ответ (записался, придёт, отказался,
// просил не звонить), а строки списков висели «в работе» — раньше звонок не всегда был
// привязан к строке, да и один человек попадает сразу в несколько списков.
if (!db.prepare("SELECT value FROM meta WHERE key='lists_close_answered_v1'").get()) {
  const n = db.prepare(`
    UPDATE list_members SET
      status = 'done',
      result = COALESCE(result, (SELECT a.result FROM task_actions a
        WHERE a.client_id = list_members.client_id
          AND a.result IN ('booked','coming','refused','no_calls')
        ORDER BY a.created_at DESC LIMIT 1)),
      note = COALESCE(NULLIF(note,''), 'ответил ранее'),
      callback_at = NULL
    WHERE status IN ('pending','snoozed')
      AND EXISTS (SELECT 1 FROM task_actions a
        WHERE a.client_id = list_members.client_id
          AND a.result IN ('booked','coming','refused','no_calls')
          AND a.created_at > list_members.updated_at)`).run().changes;
  if (n) console.log(`[migrate] закрыто строк списков по уже ответившим клиентам: ${n}`);
  db.prepare("INSERT INTO meta(key,value) VALUES('lists_close_answered_v1','1')").run();
}

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
