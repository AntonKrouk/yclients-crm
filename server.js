'use strict';

require('./src/env');
const path = require('node:path');
const express = require('express');
const { db } = require('./src/db');
const sync = require('./src/sync');
const telegram = require('./src/telegram');
const yc = require('./src/yclients');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3020;

const TYPE_LABEL = {
  confirm_visit: 'Подтвердить визит',
  rebook: 'Пора записать',
  no_show: 'Не пришёл — перезаписать',
  reactivation: 'Реактивация',
};

// --- Служебное ---------------------------------------------------------------

app.get('/api/health', (req, res) => res.json({ ok: true, mode: yc.isDemo() ? 'demo' : 'live' }));

// Синхронизация с YClients (или демо) + генерация задач + уведомление в Telegram
app.post('/api/sync', async (req, res) => {
  try {
    const months = Number(req.body?.months) || Number(req.query.months) || undefined;
    const result = await sync.run({ months });
    const counts = taskCounts();
    const tg = await telegram.notifyDailySummary(counts);
    res.json({ ...result, telegram: tg });
  } catch (e) {
    console.error('[sync]', e);
    res.status(500).json({ error: e.message });
  }
});

// Охват данных: сколько клиентов/визитов и за какой период есть в базе (для вкладки «Выборки»)
app.get('/api/data-range', (req, res) => {
  const r = db.prepare(`SELECT MIN(date) AS min_date, MAX(date) AS max_date, COUNT(*) AS visits FROM visits`).get();
  const clients = db.prepare('SELECT COUNT(*) n FROM clients').get().n;
  res.json({ ...r, clients });
});

// Список услуг с частотой — для подсказок в фильтре выборок
app.get('/api/services-list', (req, res) => {
  const rows = db.prepare(`SELECT service FROM visits WHERE status='completed' AND service <> ''`).all();
  const m = new Map();
  for (const row of rows) {
    for (const part of String(row.service).split(', ')) {
      const s = part.trim();
      if (s) m.set(s, (m.get(s) || 0) + 1);
    }
  }
  const list = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 400).map(([name, count]) => ({ name, count }));
  res.json(list);
});

// Общий запрос выборки клиентов по фильтрам — используется и в /api/segments, и при создании списков
function querySegment(f = {}) {
  const service = (f.service || '').toLowerCase().trim();
  const staff = (f.staff || '').toLowerCase().trim();
  const from = (f.from || '').trim();
  const to = (f.to || '').trim();
  const minVisits = Math.max(1, Number(f.min_visits) || 1);
  const minSpent = Math.max(0, Number(f.min_spent) || 0);

  const conds = ["v.status = 'completed'"];
  const params = [];
  if (service) { conds.push('lower(v.service) LIKE ?'); params.push('%' + service + '%'); }
  if (staff) { conds.push('lower(v.staff) LIKE ?'); params.push('%' + staff + '%'); }
  if (from) { conds.push('v.date >= ?'); params.push(from); }
  if (to) { conds.push('v.date <= ?'); params.push(to + 'T23:59:59'); }

  const sql = `
    SELECT c.id, c.name, c.phone, c.visits_count AS total_visits,
           COUNT(v.id) AS match_visits,
           MAX(v.date) AS last_match,
           ROUND(SUM(v.cost)) AS match_spent,
           GROUP_CONCAT(DISTINCT v.staff) AS masters
    FROM clients c JOIN visits v ON v.client_id = c.id
    WHERE ${conds.join(' AND ')}
    GROUP BY c.id
    HAVING match_visits >= ? AND match_spent >= ?
    ORDER BY match_visits DESC, match_spent DESC
    LIMIT 5000`;
  params.push(minVisits, minSpent);
  return db.prepare(sql).all(...params);
}

// Выборка клиентов по фильтрам (услуга / период / мастер / число визитов)
app.get('/api/segments', (req, res) => {
  const clients = querySegment(req.query);
  res.json({
    count: clients.length,
    total_visits_matched: clients.reduce((s, r) => s + r.match_visits, 0),
    total_spent_matched: clients.reduce((s, r) => s + (r.match_spent || 0), 0),
    clients,
  });
});

// --- Списки-кампании обзвона -------------------------------------------------

// Создать список из фильтра: снимок подходящих клиентов фиксируется в list_members
app.post('/api/lists', (req, res) => {
  const { name, filter } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Укажите название списка' });
  const rows = querySegment(filter || {});
  if (rows.length === 0) return res.status(400).json({ error: 'Под эти условия никто не подходит' });
  const now = new Date().toISOString();
  const info = db.prepare('INSERT INTO lists(name,filter_json,status,created_at) VALUES(?,?,?,?)')
    .run(name.trim(), JSON.stringify(filter || {}), 'active', now);
  const listId = info.lastInsertRowid;
  const ins = db.prepare('INSERT INTO list_members(list_id,client_id,status,match_visits,match_spent,updated_at) VALUES(?,?,?,?,?,?)');
  for (const r of rows) ins.run(listId, r.id, 'pending', r.match_visits, r.match_spent, now);
  res.json({ ok: true, id: listId, members: rows.length });
});

// Активные списки с прогрессом — для главного дашборда
app.get('/api/lists', (req, res) => {
  const lists = db.prepare("SELECT id,name,created_at FROM lists WHERE status='active' ORDER BY created_at DESC").all();
  res.json(lists.map(l => {
    const total = db.prepare('SELECT COUNT(*) n FROM list_members WHERE list_id=?').get(l.id).n;
    const done = db.prepare("SELECT COUNT(*) n FROM list_members WHERE list_id=? AND status='done'").get(l.id).n;
    return { ...l, total, done };
  }));
});

// Участники списка (клиенты) со статусом обработки
app.get('/api/lists/:id/members', (req, res) => {
  const rows = db.prepare(`
    SELECT m.id AS member_id, m.status, m.result, m.note, m.admin, m.match_visits, m.match_spent,
           c.id AS client_id, c.name, c.phone, c.visits_count, c.favorite_staff, c.last_visit
    FROM list_members m JOIN clients c ON c.id = m.client_id
    WHERE m.list_id = ?
    ORDER BY (m.status='done') ASC, m.match_visits DESC`).all(req.params.id);
  res.json(rows);
});

// Отметить результат звонка по участнику списка + записать в ленту клиента
app.post('/api/lists/:id/members/:memberId/action', (req, res) => {
  const { result, note, admin } = req.body || {};
  const m = db.prepare('SELECT * FROM list_members WHERE id=?').get(Number(req.params.memberId));
  if (!m) return res.status(404).json({ error: 'member not found' });
  const status = (result === 'callback' || result === 'no_answer') ? 'snoozed' : 'done';
  db.prepare('UPDATE list_members SET status=?, result=?, note=?, admin=?, updated_at=? WHERE id=?')
    .run(status, result || null, note || '', admin || 'admin', new Date().toISOString(), m.id);
  db.prepare('INSERT INTO task_actions(task_id,client_id,admin,result,note,created_at) VALUES(NULL,?,?,?,?,?)')
    .run(m.client_id, admin || 'admin', result || null, note || '', new Date().toISOString());
  res.json({ ok: true, status });
});

// Убрать список с дашборда (архив; история звонков остаётся в ленте клиентов)
app.delete('/api/lists/:id', (req, res) => {
  db.prepare("UPDATE lists SET status='archived' WHERE id=?").run(Number(req.params.id));
  res.json({ ok: true });
});

// Вход в YClients: логин+пароль администратора → user_token (пароль не сохраняется).
// После успеха сразу синхронизируемся, чтобы подтянуть боевые данные.
app.post('/api/yclients/login', async (req, res) => {
  const { login, password } = req.body || {};
  if (!login || !password) return res.status(400).json({ error: 'Укажите логин и пароль' });
  try {
    const auth = await yc.authenticate(login, password);
    const result = await sync.run();
    res.json({ ok: true, user: auth.name || login, sync: result });
  } catch (e) {
    console.error('[yclients/login]', e.message);
    res.status(401).json({ error: e.message });
  }
});

// --- Задачи ------------------------------------------------------------------

function taskCounts() {
  const rows = db.prepare(`SELECT type, COUNT(*) n FROM tasks WHERE status='open' GROUP BY type`).all();
  const out = {};
  for (const r of rows) out[r.type] = r.n;
  return out;
}

app.get('/api/tasks', (req, res) => {
  const status = req.query.status || 'open';
  const rows = db.prepare(`
    SELECT t.id, t.type, t.due_date, t.priority, t.status, t.reason, t.created_at, t.assigned_to,
           c.id AS client_id, c.name, c.phone, c.last_visit, c.avg_interval_days,
           c.favorite_staff, c.favorite_service, c.visits_count
    FROM tasks t JOIN clients c ON c.id = t.client_id
    WHERE t.status = ?
    ORDER BY t.priority ASC, t.created_at ASC
  `).all(status);
  res.json(rows.map(r => ({ ...r, type_label: TYPE_LABEL[r.type] || r.type })));
});

// Зафиксировать результат звонка + заметку. Меняет статус задачи.
app.post('/api/tasks/:id/action', (req, res) => {
  const taskId = Number(req.params.id);
  const { result, note, admin, snooze_days } = req.body || {};
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) return res.status(404).json({ error: 'task not found' });

  db.prepare(`
    INSERT INTO task_actions (task_id, client_id, admin, result, note, created_at)
    VALUES (?,?,?,?,?,?)
  `).run(taskId, task.client_id, admin || 'admin', result || null, note || '', new Date().toISOString());

  // Логика статуса: перезвонить → откладываем; иначе закрываем
  let newStatus = 'done';
  let due = task.due_date;
  if (result === 'callback' || result === 'no_answer') {
    newStatus = 'snoozed';
    const d = new Date();
    d.setDate(d.getDate() + (Number(snooze_days) || 1));
    due = d.toISOString().slice(0, 10);
  }
  db.prepare(`UPDATE tasks SET status=?, due_date=?, assigned_to=?, closed_at=? WHERE id=?`)
    .run(newStatus, due, admin || task.assigned_to, newStatus === 'done' ? new Date().toISOString() : null, taskId);

  res.json({ ok: true, status: newStatus });
});

// Вернуть отложенную задачу в работу (для «снуз» на сегодня)
app.post('/api/tasks/reopen-due', (req, res) => {
  const n = db.prepare(`UPDATE tasks SET status='open' WHERE status='snoozed' AND due_date <= date('now')`).run();
  res.json({ reopened: n.changes });
});

// --- Клиенты / история -------------------------------------------------------

app.get('/api/clients', (req, res) => {
  const q = `%${(req.query.q || '').toLowerCase()}%`;
  const rows = db.prepare(`
    SELECT id, name, phone, last_visit, visits_count, spent, avg_interval_days,
           predicted_next, favorite_staff, favorite_service
    FROM clients
    WHERE lower(name) LIKE ? OR phone LIKE ?
    ORDER BY last_visit DESC
    LIMIT 500
  `).all(q, q);
  res.json(rows);
});

// Подробная статистика по одному клиенту (из его визитов и звонков)
function computeClientStats(id, client) {
  const visits = db.prepare('SELECT date, service, staff, cost, status FROM visits WHERE client_id = ?').all(id);
  const completed = visits.filter(v => v.status === 'completed');
  const noShow = visits.filter(v => v.status === 'no_show').length;
  const cancelled = visits.filter(v => v.status === 'cancelled').length;
  const upcoming = visits.filter(v => v.status === 'upcoming').length;

  const totalSpent = completed.reduce((s, v) => s + (v.cost || 0), 0);
  const avgCheck = completed.length ? Math.round(totalSpent / completed.length) : 0;

  // разбивка по услугам и мастерам
  const group = (key) => {
    const m = {};
    completed.forEach(v => {
      const k = v[key] || '—';
      if (!m[k]) m[k] = { name: k, count: 0, sum: 0 };
      m[k].count++; m[k].sum += v.cost || 0;
    });
    return Object.values(m).sort((a, b) => b.count - a.count);
  };

  // активность по месяцам за последние 12 мес.
  const months = [];
  const base = new Date(); base.setDate(1);
  for (let i = 11; i >= 0; i--) {
    const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    months.push({ key, label: d.toLocaleDateString('ru-RU', { month: 'short' }), count: 0 });
  }
  const mMap = new Map(months.map(m => [m.key, m]));
  completed.forEach(v => {
    const dt = new Date(v.date);
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
    if (mMap.has(key)) mMap.get(key).count++;
  });

  // статус клиента по той же логике, что и правила
  const DAY = 86400000;
  const sinceLast = client.last_visit ? Math.round((Date.now() - new Date(client.last_visit)) / DAY) : null;
  let status = 'new', statusLabel = 'Новый';
  if (client.avg_interval_days && sinceLast != null) {
    if (upcoming > 0) { status = 'booked'; statusLabel = 'Записан'; }
    else if (sinceLast > client.avg_interval_days * 2) { status = 'churn'; statusLabel = 'Уходит'; }
    else if (client.predicted_next && Date.now() > new Date(client.predicted_next).getTime() + 3 * DAY) { status = 'due'; statusLabel = 'Пора записать'; }
    else { status = 'active'; statusLabel = 'Активен'; }
  } else if (upcoming > 0) { status = 'booked'; statusLabel = 'Записан'; }

  const attended = completed.length + noShow;
  return {
    total_visits: completed.length,
    no_show: noShow,
    cancelled,
    upcoming,
    completion_rate: attended ? Math.round((completed.length / attended) * 100) : null,
    total_spent: totalSpent,
    avg_check: avgCheck,
    since_last_days: sinceLast,
    services: group('service'),
    masters: group('staff'),
    months,
    status,
    status_label: statusLabel,
  };
}

app.get('/api/clients/:id/stats', (req, res) => {
  const id = Number(req.params.id);
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  if (!client) return res.status(404).json({ error: 'client not found' });
  res.json({ client, stats: computeClientStats(id, client) });
});

// Единая лента событий клиента: визиты + звонки/заметки + статистика
app.get('/api/clients/:id/timeline', (req, res) => {
  const id = Number(req.params.id);
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  if (!client) return res.status(404).json({ error: 'client not found' });

  const visits = db.prepare('SELECT date, service, staff, cost, status FROM visits WHERE client_id = ?').all(id)
    .map(v => ({ kind: 'visit', date: v.date, status: v.status, title: v.service || 'Визит', staff: v.staff, cost: v.cost }));

  const actions = db.prepare(`
    SELECT a.created_at AS date, a.admin, a.result, a.note, t.type
    FROM task_actions a LEFT JOIN tasks t ON t.id = a.task_id
    WHERE a.client_id = ?
  `).all(id).map(a => ({ kind: 'call', date: a.date, admin: a.admin, result: a.result, note: a.note, task_type: a.type }));

  const tasks = db.prepare(`SELECT id, type, status, reason, created_at AS date FROM tasks WHERE client_id = ?`).all(id)
    .map(t => ({ kind: 'task', date: t.date, type: t.type, type_label: TYPE_LABEL[t.type] || t.type, status: t.status, reason: t.reason }));

  const timeline = [...visits, ...actions, ...tasks].sort((a, b) => new Date(b.date) - new Date(a.date));
  res.json({ client, stats: computeClientStats(id, client), timeline });
});

// --- Дашборд владельца -------------------------------------------------------

app.get('/api/stats', (req, res) => {
  const open = taskCounts();
  const openTotal = Object.values(open).reduce((a, b) => a + b, 0);

  const todayActions = db.prepare(`
    SELECT result, COUNT(*) n FROM task_actions WHERE date(created_at) = date('now') GROUP BY result
  `).all();
  const resultMap = {};
  for (const r of todayActions) resultMap[r.result] = r.n;

  const byAdmin = db.prepare(`
    SELECT COALESCE(admin,'—') admin,
           COUNT(*) total,
           SUM(CASE WHEN result='booked' THEN 1 ELSE 0 END) booked
    FROM task_actions WHERE date(created_at) = date('now')
    GROUP BY admin ORDER BY total DESC
  `).all();

  const doneToday = db.prepare(`SELECT COUNT(*) n FROM tasks WHERE status='done' AND date(closed_at)=date('now')`).get().n;
  const booked = resultMap.booked || 0;
  const contacted = (resultMap.booked || 0) + (resultMap.refused || 0) + (resultMap.callback || 0);
  const conversion = contacted ? Math.round((booked / contacted) * 100) : 0;

  res.json({
    mode: yc.isDemo() ? 'demo' : 'live',
    open_total: openTotal,
    open_by_type: { ...open, labels: TYPE_LABEL },
    done_today: doneToday,
    booked_today: booked,
    conversion_pct: conversion,
    results_today: resultMap,
    by_admin: byAdmin,
    clients_total: db.prepare('SELECT COUNT(*) n FROM clients').get().n,
  });
});

// Первичное наполнение + автологин + очистка демо-данных при переходе на боевой режим
async function bootstrap() {
  // автовход по логину/паролю из .env (если задан), чтобы получить user_token
  try { await yc.ensureAuth(); } catch (e) { console.error('[bootstrap] автовход не удался:', e.message); }

  const mode = yc.isDemo() ? 'demo' : 'live';
  const prev = db.prepare('SELECT value FROM meta WHERE key = ?').get('mode')?.value;
  if (prev && prev !== mode) {
    console.log(`[bootstrap] режим сменился ${prev} → ${mode}, очищаю прежние данные`);
    db.exec('DELETE FROM task_actions; DELETE FROM tasks; DELETE FROM visits; DELETE FROM clients;');
  }
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run('mode', mode);

  const n = db.prepare('SELECT COUNT(*) n FROM clients').get().n;
  if (n === 0) {
    console.log(`[bootstrap] пустая база (режим ${mode}) — запускаю первичную синхронизацию…`);
    try { console.log('[bootstrap]', await sync.run()); }
    catch (e) { console.error('[bootstrap] sync failed:', e.message); }
  }
}

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`YClients CRM на http://0.0.0.0:${PORT} (режим: ${yc.isDemo() ? 'DEMO' : 'LIVE'})`);
  await bootstrap();
});
