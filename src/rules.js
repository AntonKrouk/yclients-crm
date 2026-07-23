'use strict';

const { db } = require('./db');

const DAY = 86400000;
const today = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / DAY);

// Настройки логики (можно вынести в env позже)
const DAILY_OPEN_TARGET = 10;     // держим не больше N открытых задач на филиал: невыполненные висят, новые догружаются до N
const FREQUENT_DAYS = 31;         // «частый» клиент = ходит не реже раза в месяц, ему приоритет в очереди
const REBOOK_GRACE_DAYS = 3;      // «пора записаться» = прошёл прогноз + N дней
const REBOOK_MAX_OVERDUE = 60;    // если просрочка больше — это уже реактивация, не рутинный дозвон
const CHURN_MULTIPLIER = 2;       // «уходящий» = не был дольше 2× средней периодичности
const NO_SHOW_RECENT_DAYS = 30;   // неявку зовём перезаписывать только если она свежая
const CHURN_MAX_DAYS = 180;       // не был дольше — считаем потерянным, задачу не создаём (не заваливаем список)
const REACTIVATION_MIN_VISITS = 2; // реактивируем только тех, кто ходил не разово

// Не создаём дубль: если по клиенту уже есть открытая/отложенная задача такого типа
const hasOpen = db.prepare(
  `SELECT 1 FROM tasks WHERE client_id = ? AND type = ? AND status IN ('open','snoozed') LIMIT 1`
);
const insertTask = db.prepare(`
  INSERT INTO tasks (client_id, type, due_date, priority, status, reason, created_at)
  VALUES (?,?,?,?,'open',?, ?)
`);

// Приоритет типов при заполнении дневных слотов: свежая неявка важнее рутинной записи
const TYPE_RANK = { no_show: 0, rebook: 1, reactivation: 2 };

function generate() {
  const nowIso = new Date().toISOString();

  // «Подтвердить визит» больше не создаём (админы подтверждают записи сами) — снимаем висящие
  db.prepare(`UPDATE tasks SET status='dismissed', closed_at=? WHERE type='confirm_visit' AND status IN ('open','snoozed')`)
    .run(nowIso);

  // Клиенты с пометкой «не беспокоить» в комментарии YClients — снимаем их открытые задачи
  db.prepare(`UPDATE tasks SET status='dismissed', closed_at=?
              WHERE status IN ('open','snoozed')
                AND client_id IN (SELECT id FROM clients WHERE COALESCE(do_not_call,0)=1)`)
    .run(nowIso);

  // Отложенные «перезвонить завтра», чей срок настал, возвращаем в открытые ДО подсчёта слотов
  db.prepare(`UPDATE tasks SET status='open' WHERE status='snoozed' AND due_date <= date('now')`).run();

  const clients = db.prepare(`
    SELECT id, name, branch, last_visit, avg_interval_days, predicted_next, visits_count
    FROM clients WHERE COALESCE(do_not_call,0) = 0
  `).all();

  const upcomingByClient = db.prepare(`
    SELECT client_id, MIN(date) AS next_date
    FROM visits WHERE status = 'upcoming' AND date >= datetime('now')
    GROUP BY client_id
  `).all();
  const upMap = new Map(upcomingByClient.map(r => [r.client_id, r.next_date]));

  const lastNoShow = db.prepare(`
    SELECT client_id, MAX(date) AS d FROM visits WHERE status = 'no_show' GROUP BY client_id
  `).all();
  const noShowMap = new Map(lastNoShow.map(r => [r.client_id, r.d]));

  const now = today();
  const candidates = [];

  for (const c of clients) {
    if (upMap.get(c.id)) continue; // уже записан — не зовём его записываться

    const frequent = c.avg_interval_days != null && c.avg_interval_days <= FREQUENT_DAYS ? 1 : 0;
    const base = { clientId: c.id, branch: c.branch || '', frequent, visits: c.visits_count || 0 };

    // 1) Свежая неявка без последующей записи → перезаписать (старые неявки не трогаем — это шум)
    const ns = noShowMap.get(c.id);
    if (ns && daysBetween(ns, now) <= NO_SHOW_RECENT_DAYS) {
      candidates.push({ ...base, type: 'no_show', priority: 1,
        reason: `Не пришёл ${new Date(ns).toLocaleDateString('ru-RU')}. Позвонить, перезаписать.` });
      continue;
    }

    if (!c.last_visit || !c.avg_interval_days) continue;

    const sinceLast = daysBetween(c.last_visit, now);
    const overdue = c.predicted_next ? daysBetween(c.predicted_next, now) : null;

    // 2) Уходящий клиент (пропал недавно, но не совсем потерян) → реактивация
    if (sinceLast > c.avg_interval_days * CHURN_MULTIPLIER
        && sinceLast <= CHURN_MAX_DAYS
        && c.visits_count >= REACTIVATION_MIN_VISITS) {
      candidates.push({ ...base, type: 'reactivation', priority: 2,
        reason: `Не был ${sinceLast} дн. при норме ~${Math.round(c.avg_interval_days)} дн. Реактивация: узнать, всё ли ок, вернуть.` });
      continue;
    }

    // 3) Пора записаться (прошёл прогноз next + grace, но ещё не «ушёл»)
    if (overdue !== null && overdue >= REBOOK_GRACE_DAYS && overdue <= REBOOK_MAX_OVERDUE) {
      candidates.push({ ...base, type: 'rebook', priority: 2,
        reason: `Обычно ходит раз в ~${Math.round(c.avg_interval_days)} дн., пора уже ${overdue} дн. назад. Позвонить, записать.` });
    }
  }

  // Очередь: сперва «частые» (ходят раз в месяц и чаще), внутри — по важности типа, потом по числу визитов
  candidates.sort((a, b) =>
    (b.frequent - a.frequent)
    || (TYPE_RANK[a.type] - TYPE_RANK[b.type])
    || (b.visits - a.visits));

  // Свободные слоты по филиалам: цель — DAILY_OPEN_TARGET открытых задач на филиал
  const openBy = new Map(db.prepare(`
    SELECT COALESCE(c.branch,'') AS b, COUNT(*) AS n
    FROM tasks t JOIN clients c ON c.id = t.client_id
    WHERE t.status = 'open' GROUP BY COALESCE(c.branch,'')
  `).all().map(r => [r.b, r.n]));

  let created = 0;
  for (const cand of candidates) {
    const open = openBy.get(cand.branch) || 0;
    if (open >= DAILY_OPEN_TARGET) continue;
    if (hasOpen.get(cand.clientId, cand.type)) continue;
    insertTask.run(cand.clientId, cand.type, today(), cand.priority, cand.reason, nowIso);
    openBy.set(cand.branch, open + 1);
    created++;
  }

  return created;
}

module.exports = { generate };
