'use strict';

const { db } = require('./db');

const DAY = 86400000;
const today = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / DAY);

// Настройки логики (можно вынести в env позже)
const CONFIRM_WITHIN_DAYS = 2;    // напоминать о визите за N дней
const REBOOK_GRACE_DAYS = 3;      // «пора записаться» = прошёл прогноз + N дней
const REBOOK_MAX_OVERDUE = 60;    // если просрочка больше — это уже реактивация, не рутинный дозвон
const CHURN_MULTIPLIER = 2;       // «уходящий» = не был дольше 2× средней периодичности
const NO_SHOW_RECENT_DAYS = 30;   // неявку зовём перезаписывать только если она свежая
const CHURN_MAX_DAYS = 180;       // не был дольше — считаем потерянным, задачу не создаём (не заваливаем список)
const REACTIVATION_MIN_VISITS = 2; // реактивируем только тех, кто ходил не разово

// Не создаём дубль: если по клиенту уже есть открытая задача такого типа
const hasOpen = db.prepare(
  `SELECT 1 FROM tasks WHERE client_id = ? AND type = ? AND status = 'open' LIMIT 1`
);
const insertTask = db.prepare(`
  INSERT INTO tasks (client_id, type, due_date, priority, status, reason, created_at)
  VALUES (?,?,?,?,'open',?, ?)
`);

function addTask(clientId, type, priority, reason) {
  if (hasOpen.get(clientId, type)) return false;
  insertTask.run(clientId, type, today(), priority, reason, new Date().toISOString());
  return true;
}

function generate() {
  const clients = db.prepare(`
    SELECT id, name, last_visit, avg_interval_days, predicted_next, visits_count
    FROM clients
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

  let created = 0;
  const now = today();

  for (const c of clients) {
    const upcoming = upMap.get(c.id);

    // 1) Есть будущая запись скоро → подтвердить визит
    if (upcoming) {
      const inDays = daysBetween(now, upcoming);
      if (inDays >= 0 && inDays <= CONFIRM_WITHIN_DAYS) {
        const when = new Date(upcoming).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
        if (addTask(c.id, 'confirm_visit', 1, `Запись ${when}. Позвонить, подтвердить визит.`)) created++;
      }
      continue; // если человек записан — не зовём его записываться
    }

    // 2) Свежая неявка без последующей записи → перезаписать (старые неявки не трогаем — это шум)
    const ns = noShowMap.get(c.id);
    if (ns && daysBetween(ns, now) <= NO_SHOW_RECENT_DAYS) {
      if (addTask(c.id, 'no_show', 1, `Не пришёл ${new Date(ns).toLocaleDateString('ru-RU')}. Позвонить, перезаписать.`)) created++;
      continue;
    }

    if (!c.last_visit || !c.avg_interval_days) continue;

    const sinceLast = daysBetween(c.last_visit, now);
    const overdue = c.predicted_next ? daysBetween(c.predicted_next, now) : null;

    // 4) Уходящий клиент (пропал недавно, но не совсем потерян) → реактивация
    if (sinceLast > c.avg_interval_days * CHURN_MULTIPLIER
        && sinceLast <= CHURN_MAX_DAYS
        && c.visits_count >= REACTIVATION_MIN_VISITS) {
      if (addTask(c.id, 'reactivation', 2,
        `Не был ${sinceLast} дн. при норме ~${Math.round(c.avg_interval_days)} дн. Реактивация: узнать, всё ли ок, вернуть.`)) created++;
      continue;
    }

    // 3) Пора записаться (прошёл прогноз next + grace, но ещё не «ушёл»)
    if (overdue !== null && overdue >= REBOOK_GRACE_DAYS && overdue <= REBOOK_MAX_OVERDUE) {
      if (addTask(c.id, 'rebook', 2,
        `Обычно ходит раз в ~${Math.round(c.avg_interval_days)} дн., пора уже ${overdue} дн. назад. Позвонить, записать.`)) created++;
    }
  }

  return created;
}

module.exports = { generate };
