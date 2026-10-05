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
// 3–60 дн., ≥3 визитов, ритм ≤180; реактивация: не был >2× ритма, но ≤180 дн., ≥2 визитов).
// ПРИБЛИЖЁННО: считается по карточкам, а движок — по людям (дубли в двух филиалах, звонок
// из соседнего филиала, ручные списки). Показывает, где кончаются кандидаты.
show('Воронка: в окне правила → записаны → на паузе после звонка → остаток', `
  WITH c AS (
    SELECT c.branch, c.visits_count AS vc, c.avg_interval_days AS iv,
           julianday('now') - julianday(c.last_visit) AS since,
           julianday('now') - julianday(c.predicted_next) AS overdue,
           EXISTS(SELECT 1 FROM visits v WHERE v.client_id = c.id AND v.status = 'upcoming'
                  AND v.date >= datetime('now')) AS booked,
           (SELECT MAX(a.created_at) FROM task_actions a WHERE a.client_id = c.id) AS call_at
    FROM clients c
    WHERE COALESCE(c.do_not_call,0) = 0 AND COALESCE(c.free_client,0) = 0
      AND c.last_visit IS NOT NULL AND c.avg_interval_days IS NOT NULL),
  r AS (
    SELECT branch, booked, call_at,
      CASE WHEN since > 2*iv AND since <= 180 AND vc >= 2 THEN 'reactivation'
           WHEN overdue BETWEEN 3 AND 60 AND vc >= 3 AND iv <= 180 THEN 'rebook' END AS rule
    FROM c)
  SELECT branch, rule, COUNT(*) AS in_window, SUM(booked) AS booked,
    SUM(NOT booked AND call_at IS NOT NULL AND call_at >= date('now', CASE rule WHEN 'rebook' THEN '-14 day' ELSE '-60 day' END)) AS paused,
    SUM(NOT booked AND (call_at IS NULL OR call_at < date('now', CASE rule WHEN 'rebook' THEN '-14 day' ELSE '-60 day' END))) AS left
  FROM r WHERE rule IS NOT NULL GROUP BY 1,2 ORDER BY 1,2`);

show('Клиенты: всего / годятся в кандидаты (есть last_visit и ритм) / свежие', `
  SELECT branch, COUNT(*) AS clients,
         SUM(last_visit IS NOT NULL AND avg_interval_days IS NOT NULL) AS with_rhythm,
         MAX(substr(last_visit,1,10)) AS newest_last_visit,
         MAX(substr(updated_at,1,10)) AS newest_update
  FROM clients GROUP BY 1 ORDER BY 1`);
