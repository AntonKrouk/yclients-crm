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

show('Клиенты: всего / годятся в кандидаты (есть last_visit и ритм) / свежие', `
  SELECT branch, COUNT(*) AS clients,
         SUM(last_visit IS NOT NULL AND avg_interval_days IS NOT NULL) AS with_rhythm,
         MAX(substr(last_visit,1,10)) AS newest_last_visit,
         MAX(substr(updated_at,1,10)) AS newest_update
  FROM clients GROUP BY 1 ORDER BY 1`);
