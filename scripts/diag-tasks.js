'use strict';

// Диагностика «не пришли задачи» (порядок — CLAUDE.md, раздел «Диагностика»). Только
// чтение, базу не меняет. Запуск на сервере: node scripts/diag-tasks.js
// Задачи считаются ПО СТАТУСАМ отдельно: open и snoozed — разные вещи (16.09.2026 на
// подсчёте «скопом» сгорел час).
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const file = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'crm.db');
const db = new DatabaseSync(file, { readOnly: true });
const show = (title, sql) => { console.log('\n== ' + title); console.table(db.prepare(sql).all()); };

show('Задачи, созданные за 4 дня: день / филиал / статус / тип', `
  SELECT substr(t.created_at,1,10) AS day, COALESCE(c.branch,'?') AS branch, t.status, t.type,
         COALESCE(t.source,'auto') AS source, COUNT(*) AS n
  FROM tasks t LEFT JOIN clients c ON c.id = t.client_id
  WHERE t.created_at >= date('now','-4 day')
  GROUP BY 1,2,3,4,5 ORDER BY 1 DESC,2,3,4`);

show('Висят сейчас (open / snoozed) по филиалам и типам', `
  SELECT COALESCE(c.branch,'?') AS branch, t.status, t.type, COALESCE(t.source,'auto') AS source,
         COUNT(*) AS n, MIN(substr(t.created_at,1,10)) AS oldest, MAX(t.due_date) AS max_due
  FROM tasks t LEFT JOIN clients c ON c.id = t.client_id
  WHERE t.status IN ('open','snoozed')
  GROUP BY 1,2,3,4 ORDER BY 1,2,3`);

show('Свежесть визитов по филиалам (не встал ли синк одного филиала)', `
  SELECT branch, company_id, COUNT(*) AS rows, MAX(substr(date,1,10)) AS last_row,
         SUM(date >= date('now','-7 day') AND date < date('now','+1 day')) AS last_7d,
         SUM(date >= date('now','+1 day')) AS future
  FROM visits GROUP BY 1,2 ORDER BY 1`);

// Воронка обычного обзвона — те же пороги, что в src/rules.js (пора записаться: просрочка
// 3–60 дн., ≥3 визитов, ритм ≤180; реактивация: не был >2× ритма, но ≤180 дн., ≥2 визитов)
// и та же пауза после звонка (rules.js, cooldownLeft): последний звонок ЧЕЛОВЕКУ по всем
// его карточкам (здесь — по хвосту телефона), срок по результату: отказ 90 дн., «просил не
// звонить» 60, иначе 14 (пора записать) / 60 (реактивация); визит после звонка снимает паузу.
// Неявки (у движка они проверяются раньше) здесь не учтены.
const BASE = `
  c AS (
    SELECT c.id, c.branch, c.phone, c.last_visit, c.visits_count AS vc, c.avg_interval_days AS iv,
           julianday('now') - julianday(c.last_visit) AS since,
           julianday('now') - julianday(c.predicted_next) AS overdue
    FROM clients c
    WHERE COALESCE(c.do_not_call,0) = 0 AND COALESCE(c.free_client,0) = 0
      AND c.last_visit IS NOT NULL AND c.avg_interval_days IS NOT NULL),
  w AS (
    SELECT *, CASE WHEN since > 2*iv AND since <= 180 AND vc >= 2 THEN 'reactivation'
                   WHEN overdue BETWEEN 3 AND 60 AND vc >= 3 AND iv <= 180 THEN 'rebook' END AS rule,
           EXISTS(SELECT 1 FROM visits v WHERE v.client_id = c.id AND v.status = 'upcoming'
                  AND v.date >= datetime('now')) AS booked
    FROM c),
  pc AS (
    SELECT w.*, (SELECT a.created_at || '|' || COALESCE(a.result,'') FROM task_actions a JOIN clients d ON d.id = a.client_id
                 WHERE d.id = w.id OR (length(w.phone) >= 10 AND substr(d.phone,-10) = substr(w.phone,-10))
                 ORDER BY a.created_at DESC LIMIT 1) AS lc
    FROM w WHERE rule IS NOT NULL),
  x AS (
    SELECT *, substr(lc, 1, instr(lc,'|') - 1) AS call_at, substr(lc, instr(lc,'|') + 1) AS call_res FROM pc),
  y AS (
    SELECT *, CASE WHEN lc IS NULL OR last_visit > call_at THEN 0
      ELSE MAX(0, (CASE call_res WHEN 'refused' THEN 90 WHEN 'no_calls' THEN 60
                                 ELSE CASE rule WHEN 'rebook' THEN 14 ELSE 60 END END)
                  - CAST(julianday(date('now')) - julianday(substr(call_at,1,10)) AS INTEGER)) END AS pause_left
    FROM x)`;

show('Воронка: в окне правила → записаны → пауза после отказа / после звонка → остаток', `
  WITH ${BASE}
  SELECT branch, rule, COUNT(*) AS in_window, SUM(booked) AS booked,
    SUM(NOT booked AND pause_left > 0 AND call_res = 'refused') AS pause_refused,
    SUM(NOT booked AND pause_left > 0 AND call_res <> 'refused') AS pause_other,
    SUM(NOT booked AND pause_left = 0) AS left
  FROM y GROUP BY 1,2 ORDER BY 1,2`);

// Почему «остаток» воронки не превращается в задачи: первая причина, по которой движок
// пропускает человека. Дубль — приближённо: та же хвостовка телефона у другой карточки
// с большим числом визитов (движок группирует точнее, src/people.js).
show('Остаток воронки: что его отсекает (первая причина)', `
  WITH ${BASE},
  why AS (
    SELECT branch, rule, CASE
      WHEN id IN (SELECT client_id FROM vip_clients UNION SELECT client_id FROM deposit_clients
                  UNION SELECT client_id FROM alice_clients) THEN '1 ручной список (VIP/Депозит/Алиса)'
      WHEN EXISTS(SELECT 1 FROM list_members m JOIN lists l ON l.id = m.list_id WHERE m.client_id = y.id
                  AND l.status = 'active' AND m.status IN ('pending','snoozed')) THEN '2 в активном списке обзвона'
      WHEN length(phone) >= 10 AND EXISTS(SELECT 1 FROM clients d WHERE d.id <> y.id
                  AND substr(d.phone,-10) = substr(y.phone,-10)
                  AND (d.visits_count > y.vc OR (d.visits_count = y.vc AND d.id < y.id))) THEN '3 дубль, задача в другом филиале'
      WHEN EXISTS(SELECT 1 FROM tasks t WHERE t.client_id = y.id AND t.status IN ('open','snoozed')) THEN '4 уже есть задача'
      ELSE '5 свободен' END AS reason
    FROM y WHERE NOT booked AND pause_left = 0)
  SELECT branch, rule, reason, COUNT(*) AS n FROM why GROUP BY 1,2,3 ORDER BY 1,2,3`);

// «Отказ» закрывает человека на 90 дней. Если так отмечают и «не ответил / игнорирует»
// (05.10.2026 в журнале Баскова все шесть «отказов» — с заметкой «ИГНОР»), пул обзвона
// выгорает на три месяца вперёд. Для «не ответил» есть своя кнопка — короткая пауза.
{
  // Регистр приводим в JS: в SQLite lower() и LIKE без учёта регистра работают только
  // для латиницы, а «ИГНОР» админы пишут заглавными
  const IGNORE = /игнор|не отвеч|не ответ|не бер|не дозвон|недозвон/;
  const agg = new Map();
  for (const r of db.prepare(`
    SELECT c.branch, COALESCE(a.admin,'—') AS admin, a.note FROM task_actions a JOIN clients c ON c.id = a.client_id
    WHERE a.result = 'refused' AND a.created_at >= date('now','-90 day')`).all()) {
    const k = r.branch + '|' + r.admin;
    if (!agg.has(k)) agg.set(k, { branch: r.branch, admin: r.admin, refused: 0, ignore_note: 0 });
    const g = agg.get(k);
    g.refused++;
    if (IGNORE.test(String(r.note || '').toLowerCase())) g.ignore_note++;
  }
  console.log('\n== Отказы за 90 дней: всего и с заметкой «игнор / не отвечает / не берёт / недозвон»');
  console.table([...agg.values()].sort((x, y) => x.branch.localeCompare(y.branch) || y.refused - x.refused));
}

show('Активные списки обзвона: сколько людей ждут звонка (их движок в задачи не берёт)', `
  SELECT l.id, l.name, l.assignee, substr(l.created_at,1,10) AS created,
         SUM(m.status = 'pending') AS pending, SUM(m.status = 'snoozed') AS snoozed, SUM(m.status = 'done') AS done
  FROM lists l JOIN list_members m ON m.list_id = l.id
  WHERE l.status = 'active' GROUP BY l.id ORDER BY pending DESC`);

show('Клиенты: всего / годятся в кандидаты (есть last_visit и ритм) / свежие', `
  SELECT branch, COUNT(*) AS clients,
         SUM(last_visit IS NOT NULL AND avg_interval_days IS NOT NULL) AS with_rhythm,
         MAX(substr(last_visit,1,10)) AS newest_last_visit,
         MAX(substr(updated_at,1,10)) AS newest_update
  FROM clients GROUP BY 1 ORDER BY 1`);
