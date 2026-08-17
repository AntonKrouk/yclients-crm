'use strict';

require('./src/env');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { db } = require('./src/db');
const sync = require('./src/sync');
const telegram = require('./src/telegram');
const yc = require('./src/yclients');
const people = require('./src/people');

const app = express();
app.use(express.json());

// --- Защита входа (пароль дашборда) -----------------------------------------
// Включается, когда задан DASHBOARD_PASSWORD. Без него (локально/демо) вход открыт.
const DASH_PW = process.env.DASHBOARD_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || DASH_PW || 'dev-secret';
const CRON_SECRET = process.env.CRON_SECRET || '';
const AUTH_ON = Boolean(DASH_PW);
const sessionCookie = () => crypto.createHmac('sha256', SECRET).update('authorized-v1').digest('hex');

function parseCookies(req) {
  const h = req.headers.cookie || '';
  return Object.fromEntries(
    h.split(';').map(s => s.trim()).filter(Boolean)
      .map(s => { const i = s.indexOf('='); return [s.slice(0, i), decodeURIComponent(s.slice(i + 1))]; })
  );
}

app.post('/api/login', (req, res) => {
  if (!AUTH_ON) return res.json({ ok: true });
  if ((req.body || {}).password === DASH_PW) {
    res.setHeader('Set-Cookie', `sess=${sessionCookie()}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`);
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Неверный пароль' });
});
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'sess=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.use((req, res, next) => {
  if (!AUTH_ON) return next();
  if (req.path === '/api/login' || req.path === '/api/health') return next();
  // авто-синк по крону: разрешаем синки с валидным токеном без куки
  const CRON_PATHS = ['/api/sync', '/api/sync-upcoming', '/api/sync-comments'];
  if (CRON_PATHS.includes(req.path) && CRON_SECRET && req.query.token === CRON_SECRET) return next();
  if (parseCookies(req).sess === sessionCookie()) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Требуется вход' });
  return res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3020;

const TYPE_LABEL = {
  confirm_visit: 'Подтвердить визит',
  rebook: 'Пора записать',
  no_show: 'Не пришёл — перезаписать',
  reactivation: 'Реактивация',
  manual: 'Добавлен вручную',
};

// --- Служебное ---------------------------------------------------------------

app.get('/api/health', (req, res) => res.json({ ok: true, mode: yc.isDemo() ? 'demo' : 'live' }));

// Синхронизация с YClients (или демо) + генерация задач + уведомление в Telegram
app.post('/api/sync', async (req, res) => {
  try {
    const months = Number(req.body?.months) || Number(req.query.months) || undefined;
    // Явное окно дат — для догрузки истории кусками (на 2 ГБ памяти 7 лет разом не влезают).
    // skip_comments=1 нужен там же: гонять проход по карточкам после каждого куска незачем.
    const from = req.body?.from || req.query.from || undefined;
    const to = req.body?.to || req.query.to || undefined;
    const skipComments = req.query.skip_comments === '1' || Boolean(req.body?.skip_comments);
    const result = await sync.run({ months, from, to, skipComments });
    const counts = taskCounts();
    const tg = await telegram.notifyDailySummary(counts);
    res.json({ ...result, telegram: tg });
  } catch (e) {
    console.error('[sync]', e);
    res.status(500).json({ error: e.message });
  }
});

// Лёгкий синк только будущих записей (секунды) — для частого крона в течение дня.
// Клиент записался сам, пока админы работают → его задача снимается, не дожидаясь ночного синка.
app.post('/api/sync-upcoming', async (req, res) => {
  try {
    res.json(await sync.syncUpcoming());
  } catch (e) {
    console.error('[sync-upcoming]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Подтянуть комментарии из карточек YClients (фоново, долго). ?full=1 — по всем клиентам
app.post('/api/sync-comments', (req, res) => {
  const st = sync.commentSyncStatus();
  if (st.running) return res.json({ started: false, ...st });
  const full = req.query.full === '1' || req.body?.full;
  setImmediate(() => sync.syncComments({ full }).catch(e => console.error('[comments]', e.message)));
  res.json({ started: true });
});
app.get('/api/sync-comments/status', (req, res) => res.json(sync.commentSyncStatus()));

// --- Администраторы (редактируемый список для выбора «кто звонил») ------------
app.get('/api/admins', (req, res) => {
  res.json(db.prepare('SELECT id, name FROM admins WHERE active=1 ORDER BY sort, name').all());
});
app.post('/api/admins', (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Укажите имя' });
  db.prepare('INSERT INTO admins(name,active) VALUES(?,1) ON CONFLICT(name) DO UPDATE SET active=1').run(name);
  res.json({ ok: true, admins: db.prepare('SELECT id, name FROM admins WHERE active=1 ORDER BY sort, name').all() });
});
app.delete('/api/admins/:id', (req, res) => {
  db.prepare('UPDATE admins SET active=0 WHERE id=?').run(Number(req.params.id));
  res.json({ ok: true, admins: db.prepare('SELECT id, name FROM admins WHERE active=1 ORDER BY sort, name').all() });
});

// Кто в YClients действительно администратор: берём пользователей филиала с ролью
// administrator/manager (user_role_slug) по ВСЕМ филиалам. Имя в users бывает короткое
// («Екатерина») — дополняем полным ФИО из staff по user_id, если оно длиннее.
const ADMIN_ROLES = new Set(['administrator', 'manager']);
async function ycAdmins() {
  const byId = new Map();
  for (const comp of yc.companies()) {
    let users = [], staff = [];
    try { users = await yc.fetchUsers(comp.id); } catch (e) { console.error('[admins] users', comp.id, e.message); continue; }
    try { staff = await yc.fetchStaff(comp.id); } catch { /* ФИО необязательны */ }
    const fullName = new Map();
    for (const s of (staff || [])) {
      if (s.user_id && s.name && !s.fired) fullName.set(String(s.user_id), s.name.trim());
    }
    for (const u of (users || [])) {
      if (!ADMIN_ROLES.has(u.user_role_slug)) continue;
      const key = String(u.id);
      const full = fullName.get(key) || '';
      const name = (full.length > (u.name || '').length ? full : (u.name || '')).trim();
      if (!name) continue;
      const prev = byId.get(key);
      if (prev) { if (!prev.branches.includes(comp.name)) prev.branches.push(comp.name); continue; }
      byId.set(key, { user_id: key, name, phone: u.phone || '', role: u.user_role_slug, branches: [comp.name] });
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

// Показать администраторов из YClients (с пометкой, кто уже в списке «кто звонит»)
app.get('/api/admins/yclients', async (req, res) => {
  if (yc.isDemo()) return res.status(400).json({ error: 'Демо-режим: список из YClients недоступен' });
  try {
    const list = await ycAdmins();
    const have = new Set(db.prepare('SELECT name FROM admins WHERE active=1').all().map(r => r.name));
    res.json(list.map(a => ({ ...a, added: have.has(a.name) })));
  } catch (e) {
    console.error('[admins/yclients]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Добавить выбранных (или всех) администраторов YClients в список «кто звонит»
app.post('/api/admins/import', async (req, res) => {
  if (yc.isDemo()) return res.status(400).json({ error: 'Демо-режим: импорт недоступен' });
  try {
    const only = Array.isArray(req.body?.names) && req.body.names.length ? new Set(req.body.names) : null;
    const list = (await ycAdmins()).filter(a => !only || only.has(a.name));
    const ins = db.prepare('INSERT INTO admins(name,active) VALUES(?,1) ON CONFLICT(name) DO UPDATE SET active=1');
    for (const a of list) ins.run(a.name);
    res.json({ ok: true, imported: list.length, admins: db.prepare('SELECT id, name FROM admins WHERE active=1 ORDER BY sort, name').all() });
  } catch (e) {
    console.error('[admins/import]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Список филиалов (для переключателя на дашборде)
app.get('/api/branches', (req, res) => {
  const rows = db.prepare(`
    SELECT branch, company_id, COUNT(*) AS clients
    FROM clients WHERE branch IS NOT NULL AND branch <> ''
    GROUP BY branch ORDER BY branch`).all();
  res.json(rows);
});

// Охват данных: сколько клиентов/визитов и за какой период есть в базе (для вкладки «Выборки»)
app.get('/api/data-range', (req, res) => {
  const branch = (req.query.branch || '').trim();
  const w = branch ? 'WHERE branch = ?' : '';
  const args = branch ? [branch] : [];
  const r = db.prepare(`SELECT MIN(date) AS min_date, MAX(date) AS max_date, COUNT(*) AS visits FROM visits ${w}`).get(...args);
  const clients = db.prepare(`SELECT COUNT(*) n FROM clients ${branch ? 'WHERE branch = ?' : ''}`).get(...args).n;
  res.json({ ...r, clients });
});

// Список услуг для подсказок в конструкторе: прайс-лист YClients + частота по визитам.
// Прайс даёт полный перечень (в т.ч. услуги без единого визита), визиты — популярность.
app.get('/api/services-list', (req, res) => {
  const branch = (req.query.branch || '').trim();

  // частота по факту оказанных услуг (услуги в визите склеены через ', ')
  const vrows = db.prepare(`SELECT service FROM visits WHERE status='completed' AND service <> '' ${branch ? 'AND branch = ?' : ''}`)
    .all(...(branch ? [branch] : []));
  const counts = new Map();
  for (const row of vrows) {
    for (const part of String(row.service).split(', ')) {
      const s = part.trim();
      if (s) counts.set(s, (counts.get(s) || 0) + 1);
    }
  }

  // прайс-лист (активные услуги)
  const srows = db.prepare(`SELECT title, category, price_min, price_max FROM services
    WHERE active = 1 AND title <> '' ${branch ? 'AND branch = ?' : ''}`)
    .all(...(branch ? [branch] : []));

  const byTitle = new Map();
  for (const s of srows) {
    if (!byTitle.has(s.title)) byTitle.set(s.title, { name: s.title, count: 0, category: s.category || '', price_min: s.price_min, price_max: s.price_max, in_price: true });
  }
  for (const [name, count] of counts) {
    if (byTitle.has(name)) byTitle.get(name).count = count;
    else byTitle.set(name, { name, count, category: '', price_min: null, price_max: null, in_price: false });
  }

  // сортировка: сперва то, что реально оказывали (по частоте), затем прайс без визитов (по алфавиту)
  const list = [...byTitle.values()].sort((a, b) =>
    (b.count - a.count) || a.name.localeCompare(b.name, 'ru')).slice(0, 1000);
  res.json(list);
});

// --- VIP-клиенты ---------------------------------------------------------------
// Ручной постоянный список: клиент лежит здесь, пока админ сам его не удалит.
// Такие клиенты ведутся персонально, поэтому из конструктора выборок исключаются —
// вместе со «вторыми» карточками того же человека в другом филиале.

const vipRows = () => db.prepare(`
  SELECT v.client_id, v.note, v.added_by, v.added_at, c.name, c.phone, c.last_visit, c.visits_count
  FROM vip_clients v JOIN clients c ON c.id = v.client_id
`).all();

// Ключи людей (по телефону), которые в VIP — чтобы отсечь и дубли по филиалам
function vipPersonKeys() {
  return new Set(vipRows().map(r => people.personKey({ id: r.client_id, phone: r.phone })));
}

app.get('/api/vip', (req, res) => {
  const rows = vipRows();
  // ближайшая будущая запись — по всем карточкам человека
  const nextVisit = (ids) => db.prepare(`SELECT date, service, staff, branch FROM visits
    WHERE client_id IN (${ids.map(() => '?').join(',')}) AND status='upcoming' AND date >= datetime('now')
    ORDER BY date ASC LIMIT 1`).get(...ids);
  const items = rows.map(r => {
    const p = loadPerson(r.client_id);
    if (!p) return null;
    const s = computeClientStats(p.client.id, p.client, p.ids);
    return {
      client_id: r.client_id,
      name: p.client.name, phone: p.client.phone,
      branches: p.client.branches, cards: p.ids.length,
      note: r.note || '', added_by: r.added_by || '', added_at: r.added_at,
      do_not_call: p.client.do_not_call,
      deposit_balance: p.client.yc_balance || 0,
      visits: s.total_visits,
      spent: p.client.yc_spent != null ? p.client.yc_spent : s.total_spent,
      avg_check: s.avg_check,
      last_visit: s.last_visit,
      since_last_days: s.since_last_days,
      status: s.status, status_label: s.status_label,
      top_master: s.masters[0] && s.masters[0].name !== '—' ? s.masters[0].name : '',
      next_visit: nextVisit(p.ids) || null,
    };
  }).filter(Boolean);
  items.sort((a, b) => (b.spent || 0) - (a.spent || 0));
  res.json({ count: items.length, total_spent: items.reduce((s, i) => s + (i.spent || 0), 0), items });
});

app.post('/api/vip', (req, res) => {
  const clientId = Number(req.body?.client_id);
  const client = db.prepare('SELECT id FROM clients WHERE id=?').get(clientId);
  if (!client) return res.status(404).json({ error: 'Клиент не найден' });
  db.prepare(`INSERT INTO vip_clients(client_id, note, added_by, added_at) VALUES(?,?,?,?)
              ON CONFLICT(client_id) DO UPDATE SET note=excluded.note`)
    .run(clientId, (req.body?.note || '').trim(), (req.body?.admin || '').trim() || null, new Date().toISOString());
  // VIP ведут персонально — автоматические задачи по нему снимаем сразу, не дожидаясь синка
  const dropped = db.prepare(`UPDATE tasks SET status='dismissed', closed_at=?
                              WHERE client_id=? AND status IN ('open','snoozed')`)
    .run(new Date().toISOString(), clientId).changes;
  res.json({ ok: true, tasks_dismissed: dropped });
});

app.patch('/api/vip/:clientId', (req, res) => {
  db.prepare('UPDATE vip_clients SET note=? WHERE client_id=?')
    .run((req.body?.note || '').trim(), Number(req.params.clientId));
  res.json({ ok: true });
});

app.delete('/api/vip/:clientId', (req, res) => {
  const n = db.prepare('DELETE FROM vip_clients WHERE client_id=?').run(Number(req.params.clientId)).changes;
  res.json({ ok: true, removed: n });
});

// Поиск кандидатов в VIP: имя/телефон, один человек — одна строка, уже добавленные помечены
app.get('/api/vip/search', (req, res) => {
  const q = `%${(req.query.q || '').toLowerCase().trim()}%`;
  if (q === '%%') return res.json([]);
  const rows = db.prepare(`
    SELECT id, name, phone, branch, visits_count, last_visit, COALESCE(yc_spent, spent, 0) AS real_spent
    FROM clients WHERE lower_u(name) LIKE ? OR phone LIKE ?
    ORDER BY visits_count DESC LIMIT 200`).all(q, q);
  const inVip = new Set(vipRows().map(r => r.client_id));
  const out = people.groupByPerson(rows).map(cards => ({
    id: cards[0].id,
    name: cards[0].name,
    phone: cards[0].phone,
    branches: [...new Set(cards.map(c => c.branch).filter(Boolean))],
    visits: cards.reduce((s, c) => s + (c.visits_count || 0), 0),
    spent: cards.reduce((s, c) => s + (c.real_spent || 0), 0),
    last_visit: cards.map(c => c.last_visit).filter(Boolean).sort().pop() || null,
    added: cards.some(c => inVip.has(c.id)),
  }));
  out.sort((a, b) => (b.spent - a.spent) || (b.visits - a.visits));
  res.json(out.slice(0, 30));
});

// Группы услуг (категории прайс-листа YClients) с числом услуг и фактических визитов.
// Вложенности у категорий нет — в YClients этого салона все они одного уровня.
app.get('/api/service-categories', (req, res) => {
  const branch = (req.query.branch || '').trim();
  const args = branch ? [branch] : [];
  const rows = db.prepare(`SELECT category, COUNT(*) AS services FROM services
    WHERE active = 1 AND COALESCE(category,'') <> '' ${branch ? 'AND branch = ?' : ''}
    GROUP BY category`).all(...args);
  // сколько визитов пришлось на каждую группу — по денормализованной колонке
  const vrows = db.prepare(`SELECT service_category FROM visits
    WHERE status='completed' AND COALESCE(service_category,'') <> '' ${branch ? 'AND branch = ?' : ''}`)
    .all(...args);
  const visits = new Map();
  for (const r of vrows) {
    for (const part of String(r.service_category).split(', ')) {
      const s = part.trim();
      if (s) visits.set(s, (visits.get(s) || 0) + 1);
    }
  }
  const list = rows.map(r => ({ name: r.category, services: r.services, visits: visits.get(r.category) || 0 }))
    .sort((a, b) => (b.visits - a.visits) || a.name.localeCompare(b.name, 'ru'));
  res.json(list);
});

// Список товаров для фильтра «покупал товар» — строится по фактическим покупкам,
// а не по справочнику YClients: /goods отдаёт только складские остатки (25 позиций),
// тогда как в purchases лежит вся история продаж.
app.get('/api/goods-list', (req, res) => {
  const branch = (req.query.branch || '').trim();
  const rows = db.prepare(`SELECT title, COUNT(*) AS purchases, COUNT(DISTINCT client_id) AS clients,
      COALESCE(ROUND(SUM(cost)),0) AS sum, MAX(date) AS last_date
    FROM purchases WHERE COALESCE(title,'') <> '' ${branch ? 'AND branch = ?' : ''}
    GROUP BY lower_u(title)
    ORDER BY purchases DESC, sum DESC
    LIMIT 1000`).all(...(branch ? [branch] : []));
  res.json(rows);
});

// Поиск клиента для ручной сборки списка (то же, что в VIP, но с пометкой «уже выбран»
// решает фронт). Возвращает человека целиком — карточки филиалов склеены.
app.get('/api/client-search', (req, res) => {
  const q = `%${(req.query.q || '').toLowerCase().trim()}%`;
  if (q === '%%') return res.json([]);
  const rows = db.prepare(`
    SELECT id, name, phone, branch, visits_count, last_visit, COALESCE(do_not_call,0) AS do_not_call,
           COALESCE(yc_spent, spent, 0) AS real_spent, COALESCE(discount_pct,0) AS discount
    FROM clients WHERE lower_u(name) LIKE ? OR phone LIKE ?
    ORDER BY visits_count DESC LIMIT 200`).all(q, q);
  const out = people.groupByPerson(rows).map(cards => ({
    id: cards[0].id,
    ids: cards.map(c => c.id),
    name: cards[0].name,
    phone: cards[0].phone,
    branches: [...new Set(cards.map(c => c.branch).filter(Boolean))],
    visits: cards.reduce((s, c) => s + (c.visits_count || 0), 0),
    spent: cards.reduce((s, c) => s + (c.real_spent || 0), 0),
    discount: Math.max(...cards.map(c => c.discount || 0)),
    do_not_call: cards.some(c => c.do_not_call) ? 1 : 0,
    last_visit: cards.map(c => c.last_visit).filter(Boolean).sort().pop() || null,
  }));
  out.sort((a, b) => (b.spent - a.spent) || (b.visits - a.visits));
  res.json(out.slice(0, 30));
});

// Общий запрос выборки клиентов по фильтрам — используется и в /api/segments, и при создании списков
function querySegment(f = {}) {
  const service = (f.service || '').toLowerCase().trim();
  // Группа услуг из прайс-листа YClients («Маникюр/Педикюр», «Общие массажи» и т.п.).
  // Категория лежит готовой в visits.service_category — денормализация из services.
  const category = (f.category || '').toLowerCase().trim();
  // Товар из покупок (таблица purchases): и купленные вместе с визитом, и отдельные продажи.
  // Поле — свободный ввод, поэтому ищем по вхождению названия.
  const good = (f.good || '').toLowerCase().trim();
  const staff = (f.staff || '').toLowerCase().trim();
  const from = (f.from || '').trim();
  const to = (f.to || '').trim();
  // Фильтр по товару должен находить и тех, кто НИ РАЗУ не был на услуге (купил и ушёл),
  // поэтому при чистом товарном запросе порог визитов опускаем до нуля.
  const hasVisitFilter = !!(service || category || (f.staff || '').trim() || (f.from || '').trim() || (f.to || '').trim());
  const wantsGoods = !!good;
  const minVisits = Number(f.min_visits) > 0
    ? Number(f.min_visits)
    : (wantsGoods && !hasVisitFilter ? 0 : 1);
  // Диапазон «сколько человек потратил всего» — как фильтр по пробегу у авто.
  // Считается по ПОЛНОЙ сумме человека (все карточки, все филиалы), а не по сумме
  // попавших в выборку визитов: иначе «клиенты от 300 тыс.» отсекались бы фильтром услуги.
  // min_spent оставлен для совместимости со списками, созданными до появления диапазона.
  const spentFrom = Math.max(0, Number(f.spent_from) || Number(f.min_spent) || 0);
  const spentTo = Number(f.spent_to) > 0 ? Number(f.spent_to) : Infinity;
  const branch = (f.branch || '').trim();
  const comment = (f.comment || '').toLowerCase().trim();
  const dnc = (f.dnc || '').trim(); // '' = исключить «не беспокоить» (по умолч.) | 'all' = включая | 'only' = только они
  const deposit = (f.deposit || '').trim(); // депозитники: 'nonzero' = остаток или долг (≠0) | 'positive' = только с остатком | 'debt' = только с долгом
  // Персональная скидка из карточки YClients: 'any' = есть любая | 'none' = без скидки.
  // discount_from — «скидка не меньше N %». Поле заполняется проходом по карточкам.
  const discount = (f.discount || '').trim();
  const discountFrom = Math.max(0, Number(f.discount_from) || 0);

  // Условия делятся на два набора: по ВИЗИТУ они уходят в ON (иначе LEFT JOIN
  // выродился бы в INNER и товарный фильтр терял бы покупателей без визитов),
  // по КЛИЕНТУ — в WHERE.
  const vConds = ["v.status = 'completed'"];
  const vParams = [];
  if (service) { vConds.push('lower_u(v.service) LIKE ?'); vParams.push('%' + service + '%'); }
  if (category) { vConds.push("lower_u(COALESCE(v.service_category,'')) LIKE ?"); vParams.push('%' + category + '%'); }
  if (staff) { vConds.push('lower_u(v.staff) LIKE ?'); vParams.push('%' + staff + '%'); }
  if (from) { vConds.push('v.date >= ?'); vParams.push(from); }
  if (to) { vConds.push('v.date <= ?'); vParams.push(to + 'T23:59:59'); }

  const conds = [];
  const params = [];
  if (branch) { conds.push('c.branch = ?'); params.push(branch); }
  if (good) {
    conds.push('EXISTS (SELECT 1 FROM purchases p WHERE p.client_id = c.id AND lower_u(p.title) LIKE ?)');
    params.push('%' + good + '%');
  }
  if (comment) { conds.push('lower_u(COALESCE(c.comment,\'\')) LIKE ?'); params.push('%' + comment + '%'); }
  if (deposit === 'positive' || deposit === 'only') conds.push('COALESCE(c.yc_balance,0) > 0');
  else if (deposit === 'debt') conds.push('COALESCE(c.yc_balance,0) < 0');
  else if (deposit === 'nonzero') conds.push('COALESCE(c.yc_balance,0) <> 0');
  if (dnc === 'only') conds.push('COALESCE(c.do_not_call,0) = 1');
  else if (dnc !== 'all') conds.push('COALESCE(c.do_not_call,0) = 0');
  if (discount === 'any') conds.push('COALESCE(c.discount_pct,0) > 0');
  else if (discount === 'none') conds.push('COALESCE(c.discount_pct,0) = 0');
  if (discountFrom) { conds.push('COALESCE(c.discount_pct,0) >= ?'); params.push(discountFrom); }

  // VIP ведут персонально — в выборки конструктора они не попадают вовсе
  conds.push('c.id NOT IN (SELECT client_id FROM vip_clients)');

  // Пресет NEW: первички для NPS-обзвана. Человек считается «новым», пока у него ровно один
  // визит И его ещё не обработал админ. Статус снимается сам — вторым визитом или любой
  // отметкой звонка из дашборда (она же уходит комментарием в карточку YClients).
  const isNew = (f.preset || '').trim() === 'new';

  // Покупки клиента: при выбранном товаре — только по нему, иначе все (колонка «Товары»)
  const goodSql = good ? ' AND lower_u(p.title) LIKE ?' : '';
  const goodParams = good ? ['%' + good + '%', '%' + good + '%'] : [];
  const sql = `
    SELECT c.id, c.name, c.phone, c.branch, c.comment, COALESCE(c.do_not_call,0) AS do_not_call,
           c.visits_count AS total_visits, c.last_visit,
           COALESCE(c.yc_spent, c.spent, 0) AS real_spent, COALESCE(c.yc_balance,0) AS deposit_balance,
           COALESCE(c.discount_pct,0) AS discount,
           (SELECT COUNT(*) FROM purchases p WHERE p.client_id = c.id${goodSql}) AS goods_count,
           (SELECT COALESCE(ROUND(SUM(p.cost)),0) FROM purchases p WHERE p.client_id = c.id${goodSql}) AS goods_spent,
           COUNT(v.id) AS match_visits,
           MAX(v.date) AS last_match,
           ROUND(SUM(v.cost)) AS match_spent,
           GROUP_CONCAT(DISTINCT v.staff) AS masters
    FROM clients c LEFT JOIN visits v ON v.client_id = c.id AND ${vConds.join(' AND ')}
    WHERE ${conds.join(' AND ')}
    GROUP BY c.id
    LIMIT 20000`;
  // порядок параметров: подзапросы SELECT → условия ON → условия WHERE
  const rows = db.prepare(sql).all(...goodParams, ...vParams, ...params);

  // Склейка карточек одного человека + отсев тех, у кого VIP-карточка в другом филиале
  const vipKeys = vipPersonKeys();
  // «уже обработан админом» — есть хоть одна отметка звонка в ленте клиента
  const handled = isNew
    ? new Set(db.prepare('SELECT DISTINCT client_id FROM task_actions').all().map(r => r.client_id))
    : null;
  const merged = [];
  for (const cards of people.groupByPerson(rows)) {
    if (vipKeys.has(people.personKey(cards[0]))) continue;
    if (isNew && cards.some(c => handled.has(c.id))) continue;
    const base = { ...cards[0] };
    if (cards.length > 1) {
      base.cards = cards.length;
      base.branches = [...new Set(cards.map(c => c.branch).filter(Boolean))];
      base.match_visits = cards.reduce((s, c) => s + c.match_visits, 0);
      base.match_spent = cards.reduce((s, c) => s + (c.match_spent || 0), 0);
      base.total_visits = cards.reduce((s, c) => s + (c.total_visits || 0), 0);
      base.real_spent = cards.reduce((s, c) => s + (c.real_spent || 0), 0);
      base.goods_count = cards.reduce((s, c) => s + (c.goods_count || 0), 0);
      base.goods_spent = cards.reduce((s, c) => s + (c.goods_spent || 0), 0);
      base.deposit_balance = cards.reduce((s, c) => s + (c.deposit_balance || 0), 0);
      base.discount = Math.max(...cards.map(c => c.discount || 0)); // скидка бывает только в одной карточке
      base.last_match = cards.map(c => c.last_match).sort().pop();
      base.masters = [...new Set(cards.flatMap(c => (c.masters || '').split(',')).filter(Boolean))].join(',');
      base.do_not_call = cards.some(c => c.do_not_call) ? 1 : 0;
    }
    if (base.match_visits < minVisits) continue;
    if (base.real_spent < spentFrom || base.real_spent > spentTo) continue;
    // NEW: ровно один визит за всю историю человека (по обеим карточкам)
    if (isNew && (base.total_visits || 0) !== 1) continue;
    merged.push(base);
  }
  // первички сортируем от самых свежих — по ним обратная связь ценнее всего
  if (isNew) merged.sort((a, b) => String(b.last_match || '').localeCompare(String(a.last_match || '')));
  else merged.sort((a, b) => (b.real_spent - a.real_spent) || (b.match_visits - a.match_visits));
  return merged.slice(0, 5000);
}

// Выборка клиентов по фильтрам (услуга / период / мастер / визиты / сумма трат)
app.get('/api/segments', (req, res) => {
  const clients = querySegment(req.query);
  const noSums = clients.filter(c => !c.real_spent).length;
  res.json({
    count: clients.length,
    total_visits_matched: clients.reduce((s, r) => s + r.match_visits, 0),
    total_spent_matched: clients.reduce((s, r) => s + (r.match_spent || 0), 0),
    total_spent_lifetime: clients.reduce((s, r) => s + (r.real_spent || 0), 0),
    without_sums: noSums,
    clients,
  });
});

// --- Списки-кампании обзвона -------------------------------------------------

// Участники списка, собранного вручную: берём выбранные карточки как есть.
// Никаких фильтров конструктора (VIP, «не беспокоить») — админ выбрал человека осознанно.
function manualMembers(ids) {
  const uniq = [...new Set(ids.map(Number).filter(Boolean))];
  if (!uniq.length) return [];
  const ph = uniq.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, name, phone, branch, visits_count, COALESCE(yc_spent, spent, 0) AS spent
    FROM clients WHERE id IN (${ph})`).all(...uniq);
  // Один человек = карточка в КАЖДОМ филиале. Если выбраны обе — в списке он должен
  // быть один раз, иначе админ дважды позвонит одному и тому же.
  return people.groupByPerson(rows).map(cards => {
    const main = cards.slice().sort((a, b) => (b.visits_count || 0) - (a.visits_count || 0))[0];
    return {
      id: main.id,
      match_visits: cards.reduce((s, c) => s + (c.visits_count || 0), 0),
      match_spent: cards.reduce((s, c) => s + (c.spent || 0), 0),
    };
  });
}

// Создать список из фильтра: снимок подходящих клиентов фиксируется в list_members
app.post('/api/lists', (req, res) => {
  const { name, filter, assignee, client_ids, exclude_ids } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Укажите название списка' });
  // Два способа набрать список: фильтром конструктора или поштучно выбранными клиентами.
  const manual = Array.isArray(client_ids) && client_ids.length > 0;
  // Строки, вычеркнутые админом прямо в таблице выборки, в список не берём
  const excluded = new Set((Array.isArray(exclude_ids) ? exclude_ids : []).map(Number).filter(Boolean));
  const rows = (manual ? manualMembers(client_ids) : querySegment(filter || {}))
    .filter(r => !excluded.has(Number(r.id)));
  if (rows.length === 0) return res.status(400).json({ error: manual ? 'Не выбрано ни одного клиента' : 'Под эти условия никто не подходит' });
  const now = new Date().toISOString();
  const info = db.prepare('INSERT INTO lists(name,filter_json,assignee,status,created_at) VALUES(?,?,?,?,?)')
    .run(name.trim(), JSON.stringify(filter || {}), (assignee || '').trim() || null, 'active', now);
  const listId = info.lastInsertRowid;
  const ins = db.prepare('INSERT INTO list_members(list_id,client_id,status,match_visits,match_spent,updated_at) VALUES(?,?,?,?,?,?)');
  for (const r of rows) ins.run(listId, r.id, 'pending', r.match_visits, r.match_spent, now);
  res.json({ ok: true, id: listId, members: rows.length });
});

// Активные списки с прогрессом — для главного дашборда
app.get('/api/lists', (req, res) => {
  const lists = db.prepare("SELECT id,name,assignee,created_at FROM lists WHERE status='active' ORDER BY created_at DESC").all();
  res.json(lists.map(l => {
    const total = db.prepare('SELECT COUNT(*) n FROM list_members WHERE list_id=?').get(l.id).n;
    // обработан = по человеку звонили, независимо от исхода: «не ответил» и «перезвонить»
    // это тоже работа админа, и в прогрессе она должна быть видна
    const done = db.prepare("SELECT COUNT(*) n FROM list_members WHERE list_id=? AND status IN ('done','snoozed')").get(l.id).n;
    return { ...l, total, done };
  }));
});

// Участники списка (клиенты) со статусом обработки
app.get('/api/lists/:id/members', (req, res) => {
  const rows = db.prepare(`
    SELECT m.id AS member_id, m.status, m.result, m.note, m.draft_note, m.admin, m.callback_at,
           m.match_visits, m.match_spent,
           (SELECT a.id FROM task_actions a WHERE a.member_id = m.id
             ORDER BY a.created_at DESC, a.id DESC LIMIT 1) AS action_id,
           c.id AS client_id, c.name, c.phone, c.visits_count, c.favorite_staff, c.last_visit
    FROM list_members m JOIN clients c ON c.id = m.client_id
    WHERE m.list_id = ?
    -- порядок работы: сперва «перезвонить сегодня», затем ещё не обзвоненные,
    -- затем отложенные на потом, обработанные — в конце
    ORDER BY (m.status='done') ASC,
             (m.status='snoozed' AND date(m.callback_at) <= date('now','localtime')) DESC,
             (m.status='snoozed') ASC,
             m.match_visits DESC`).all(req.params.id);
  // отложенный на сегодня (или просроченный) участник — как красная задача на дашборде
  const today = new Date().toISOString().slice(0, 10);
  res.json(rows.map(r => ({
    ...r,
    callback_today: !!(r.status === 'snoozed' && r.callback_at && r.callback_at.slice(0, 10) <= today),
  })));
});

// Фиксация звонка по участнику списка: обновляет статус, пишет в ленту клиента и в YClients.
// Вынесено в функцию, чтобы этим же путём отмечался звонок при создании записи из формы.
// Человек нередко попадает сразу в несколько списков (и ещё двумя карточками — по одной
// на филиал). Ответил один раз — значит ответил всем: закрываем его строки во всех
// активных списках, иначе ему позвонят ещё столько раз, в скольких списках он состоит.
// Касается только окончательных ответов: «перезвонить» и «не ответил» — это не ответ.
const FINAL_RESULTS = new Set(['booked', 'coming', 'refused', 'no_calls']);
function closeSameClientRows(clientId, { result, note, admin, exceptMemberId = null }) {
  const me = db.prepare('SELECT id, phone FROM clients WHERE id=?').get(Number(clientId));
  if (!me) return 0;
  const digits = people.normPhone(me.phone);
  const ids = people.isRealPhone(digits)
    ? db.prepare(`SELECT id FROM clients
        WHERE substr(replace(replace(replace(replace(phone,' ',''),'-',''),'(',''),')',''), -10) = ?`)
      .all(digits.slice(-10)).map(r => r.id)
    : [me.id];
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT m.id FROM list_members m JOIN lists l ON l.id = m.list_id
    WHERE l.status='active' AND m.status IN ('pending','snoozed') AND m.client_id IN (${ph})`).all(...ids)
    .filter(r => r.id !== Number(exceptMemberId));
  if (!rows.length) return 0;
  const upd = db.prepare(`UPDATE list_members SET status='done', result=?, note=?, admin=?,
                          updated_at=?, callback_at=NULL WHERE id=?`);
  const now = new Date().toISOString();
  const mark = note ? note : 'ответил в другом списке';
  for (const r of rows) upd.run(result, mark, admin || 'admin', now, r.id);
  return rows.length;
}

function applyMemberAction(memberId, { result, note, admin, snooze_until } = {}) {
  const m = db.prepare('SELECT * FROM list_members WHERE id=?').get(Number(memberId));
  if (!m) return null;
  // имя звонившего не пришло — подписываем ответственным за список, а не безликим «admin»
  if (!(admin || '').trim()) {
    admin = db.prepare('SELECT assignee FROM lists WHERE id=?').get(m.list_id)?.assignee || admin;
  }
  const status = SNOOZE_RESULTS.has(result) ? 'snoozed' : 'done';
  const text = (note && note.trim()) ? note : (m.draft_note || '');   // пустая заметка → черновик
  // срок перезвона: как у задач — сегодня со временем, дата или пауза «не звонить»
  const until = status === 'snoozed' ? (normSnooze(snooze_until) || todayPlus(1)) : null;
  db.prepare(`UPDATE list_members SET status=?, result=?, note=?, admin=?, updated_at=?,
              draft_note=NULL, callback_at=? WHERE id=?`)
    .run(status, result || null, text, admin || 'admin', new Date().toISOString(), until, m.id);
  recordAction({ memberId: m.id, clientId: m.client_id, admin: admin || 'admin', result: result || null, note: text });
  if (FINAL_RESULTS.has(result)) {
    const n = closeSameClientRows(m.client_id, { result, note: text, admin, exceptMemberId: m.id });
    if (n) console.log(`[lists] закрыто строк этого же человека в других списках: ${n}`);
  }

  // Пишем результат звонка обратно в карточку клиента YClients (фоном)
  setImmediate(() => sync.writeCallToYclients(m.client_id, { result, note: text, admin })
    .catch(e => console.error('[yc-writeback list]', e.message)));

  return { status, client_id: m.client_id };
}

// Отметить результат звонка по участнику списка + записать в ленту клиента
app.post('/api/lists/:id/members/:memberId/action', (req, res) => {
  const { result, note, admin, snooze_until } = req.body || {};
  const r = applyMemberAction(req.params.memberId, { result, note, admin, snooze_until });
  if (!r) return res.status(404).json({ error: 'member not found' });
  res.json({ ok: true, status: r.status });
});

// Убрать клиента из списка обзвона (передумали звонить, попал по ошибке).
// История звонков в task_actions остаётся — она привязана к клиенту, а не к строке списка.
app.delete('/api/lists/:id/members/:memberId', (req, res) => {
  const n = db.prepare('DELETE FROM list_members WHERE id=? AND list_id=?')
    .run(Number(req.params.memberId), Number(req.params.id)).changes;
  if (!n) return res.status(404).json({ error: 'member not found' });
  res.json({ ok: true });
});

// Сменить ответственного админа у списка
app.patch('/api/lists/:id', (req, res) => {
  const { assignee } = req.body || {};
  db.prepare('UPDATE lists SET assignee=? WHERE id=?')
    .run((assignee || '').trim() || null, Number(req.params.id));
  res.json({ ok: true });
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

function taskCounts(branch) {
  const w = branch ? 'AND c.branch = ?' : '';
  const rows = db.prepare(`SELECT t.type, COUNT(*) n FROM tasks t JOIN clients c ON c.id = t.client_id
    WHERE t.status='open' ${w} GROUP BY t.type`).all(...(branch ? [branch] : []));
  const out = {};
  for (const r of rows) out[r.type] = r.n;
  return out;
}

app.get('/api/tasks', (req, res) => {
  const status = req.query.status || 'open';
  const branch = (req.query.branch || '').trim();
  // К открытым задачам добавляем отложенные НА СЕГОДНЯ: админ договорился перезвонить
  // «после обеда» — такая карточка должна висеть перед глазами весь день, а не всплывать
  // в 18:00, когда о ней уже забыли. Помечаем их callback_today, фронт красит красным.
  const todayCallback = status === 'open'
    ? `OR (t.status='snoozed' AND date(t.due_date) = date('now','localtime'))` : '';
  const rows = db.prepare(`
    SELECT t.id, t.type, t.due_date, t.priority, t.status, t.reason, t.created_at, t.assigned_to, t.draft_note,
           c.id AS client_id, c.name, c.phone, c.last_visit, c.avg_interval_days,
           c.favorite_staff, c.favorite_service, c.visits_count, c.branch
    FROM tasks t JOIN clients c ON c.id = t.client_id
    WHERE (t.status = ? ${todayCallback}) ${branch ? 'AND c.branch = ?' : ''}
    -- ручные задачи наверх: админ добавил человека только что и ждёт, что тот попадётся на глаза
    ORDER BY (t.status='snoozed') DESC, (t.type='manual') DESC, t.priority ASC, t.created_at ASC
  `).all(...(branch ? [status, branch] : [status]));
  res.json(rows.map(r => ({
    ...r,
    type_label: TYPE_LABEL[r.type] || r.type,
    // время перезвона показываем только у отложенных на сегодня
    callback_at: r.status === 'snoozed' ? r.due_date : null,
  })));
});

// Добавить клиента в задачи вручную — по одному, кнопкой в «Клиентах» и «Конструкторе».
// Такая задача не занимает дневной лимит (движок по-прежнему добирает свои 10 на филиал)
// и не снимается автоматической уборкой: висит, пока админ не отметит по ней результат.
app.post('/api/tasks/manual', (req, res) => {
  const { client_id, admin, note } = req.body || {};
  const client = db.prepare('SELECT id, name, branch FROM clients WHERE id = ?').get(Number(client_id));
  if (!client) return res.status(404).json({ error: 'Клиент не найден' });

  // Уже висит задача по этому человеку — второй карточки не заводим, иначе админ
  // звонил бы дважды по одному поводу. Отвечаем, что он уже в списке.
  const open = db.prepare(`SELECT id, type, status, COALESCE(source,'auto') AS source
                           FROM tasks WHERE client_id = ? AND status IN ('open','snoozed')
                           ORDER BY id DESC LIMIT 1`).get(client.id);
  if (open) {
    return res.json({ ok: true, already: true, task_id: open.id, source: open.source,
      type_label: TYPE_LABEL[open.type] || open.type, name: client.name });
  }

  const who = (admin || '').trim();
  const reason = (note || '').trim()
    || `Добавлен вручную${who ? ' — ' + who : ''}. Позвонить, обсудить запись.`;
  const r = db.prepare(`INSERT INTO tasks (client_id, type, due_date, priority, status, reason, created_at, source, added_by)
                        VALUES (?, 'manual', date('now','localtime'), 1, 'open', ?, ?, 'manual', ?)`)
    .run(client.id, reason, new Date().toISOString(), who || null);
  res.json({ ok: true, added: true, task_id: r.lastInsertRowid, name: client.name });
});

// Фиксация звонка по задаче: статус задачи + запись в ленту клиента + обратная запись в YClients.
// Вынесено в функцию — тем же путём отмечается звонок при создании записи из формы.
// Срок «перезвонить»: админ выбирает его в календаре — либо конкретная дата (YYYY-MM-DD),
// либо «позже сегодня» с временем (YYYY-MM-DD HH:MM). Время в часовом поясе салона (МСК),
// сравнивается с datetime('now','localtime') — сервер живёт в Europe/Moscow.
const SNOOZE_RE = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/;
const normSnooze = (v) => (typeof v === 'string' && SNOOZE_RE.test(v.trim()) ? v.trim() : null);
// Результаты, после которых задача не закрывается, а ждёт своего срока.
// no_calls — «просил пока не звонить»: та же отложенная задача, только надолго (60 дней).
const SNOOZE_RESULTS = new Set(['callback', 'no_answer', 'no_calls']);
const todayPlus = (days) => {
  const d = new Date(); d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

// Один звонок — одна строка в журнале. Админ нажимает кнопку дважды (промахнулся,
// не понял, что сработало, или сразу уточнил результат) — это по-прежнему тот же звонок,
// поэтому свежую запись обновляем, а не плодим новую. Разговор через час — уже новая.
const SAME_CALL_MINUTES = 10;
function recordAction({ taskId = null, memberId = null, clientId, admin, result, note }) {
  const now = new Date().toISOString();
  const since = new Date(Date.now() - SAME_CALL_MINUTES * 60000).toISOString();
  const key = taskId ? 'task_id' : (memberId ? 'member_id' : null);
  const recent = key
    ? db.prepare(`SELECT id FROM task_actions WHERE ${key}=? AND created_at >= ?
                  ORDER BY created_at DESC, id DESC LIMIT 1`).get(taskId || memberId, since)
    : null;
  if (recent) {
    db.prepare('UPDATE task_actions SET admin=?, result=?, note=?, created_at=? WHERE id=?')
      .run(admin, result, note, now, recent.id);
    return recent.id;
  }
  return db.prepare(`INSERT INTO task_actions (task_id, member_id, client_id, admin, result, note, created_at)
                     VALUES (?,?,?,?,?,?,?)`).run(taskId, memberId, clientId, admin, result, note, now).lastInsertRowid;
}

function applyTaskAction(rawTaskId, { result, note, admin, snooze_days, snooze_until } = {}) {
  const taskId = Number(rawTaskId);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) return null;

  // Заметку берём из запроса, но если она пуста — из черновика (админ мог печатать
  // в другой вкладке или нажать кнопку до того, как черновик долетел обратно в поле)
  const text = (note && note.trim()) ? note : (task.draft_note || '');
  recordAction({ taskId, clientId: task.client_id, admin: admin || 'admin', result: result || null, note: text });
  db.prepare('UPDATE tasks SET draft_note=NULL WHERE id=?').run(taskId);
  // человек ответил по задаче — в списках обзвона он тоже больше не ждёт звонка
  if (FINAL_RESULTS.has(result)) closeSameClientRows(task.client_id, { result, note: text, admin });

  // Логика статуса: перезвонить → откладываем; иначе закрываем
  let newStatus = 'done';
  let due = task.due_date;
  if (SNOOZE_RESULTS.has(result)) {
    newStatus = 'snoozed';
    const until = normSnooze(snooze_until);
    if (until) {
      due = until;
    } else {
      const d = new Date();
      d.setDate(d.getDate() + (Number(snooze_days) || 1));
      due = d.toISOString().slice(0, 10);
    }
  }
  db.prepare(`UPDATE tasks SET status=?, due_date=?, assigned_to=?, closed_at=? WHERE id=?`)
    .run(newStatus, due, admin || task.assigned_to, newStatus === 'done' ? new Date().toISOString() : null, taskId);

  // Пишем результат звонка обратно в карточку клиента YClients (фоном, чтобы ответ был мгновенным)
  setImmediate(() => sync.writeCallToYclients(task.client_id, { result, note: text, admin })
    .catch(e => console.error('[yc-writeback task]', e.message)));

  return { status: newStatus, client_id: task.client_id, due_date: due };
}

// Исправить результат уже зафиксированного звонка: клиент отказался, а через час перезвонил
// и записался — раньше это было не поправить, в журнале навсегда оставался «отказ».
// Меняем запись в ленте И статус источника (задачи или строки списка), в YClients дописываем
// уточняющую строку — затирать историю в карточке клиента нельзя.
function fixAction(rawId, { result, note, admin, snooze_until } = {}) {
  const id = Number(rawId);
  const a = db.prepare('SELECT * FROM task_actions WHERE id=?').get(id);
  if (!a) return null;

  const text = note != null ? String(note) : (a.note || '');
  db.prepare('UPDATE task_actions SET result=?, note=?, admin=COALESCE(?,admin) WHERE id=?')
    .run(result, text, (admin || '').trim() || null, id);

  const snoozed = SNOOZE_RESULTS.has(result);
  // срок для отложенных: из календаря, иначе «просил не звонить» — два месяца, остальное — завтра
  const until = snoozed ? (normSnooze(snooze_until) || todayPlus(result === 'no_calls' ? 60 : 1)) : null;

  if (a.task_id) {
    db.prepare(`UPDATE tasks SET status=?, due_date=COALESCE(?,due_date), closed_at=? WHERE id=?`)
      .run(snoozed ? 'snoozed' : 'done', until, snoozed ? null : new Date().toISOString(), a.task_id);
  }
  if (a.member_id) {
    db.prepare(`UPDATE list_members SET status=?, result=?, note=?, callback_at=?, updated_at=? WHERE id=?`)
      .run(snoozed ? 'snoozed' : 'done', result, text, until, new Date().toISOString(), a.member_id);
  }
  // Звонок мог быть записан без привязки к строке (старые записи) — тогда строки списков
  // висели бы «в работе» уже после ответа клиента. Закрываем их по клиенту.
  if (FINAL_RESULTS.has(result)) {
    closeSameClientRows(a.client_id, { result, note: text, admin: admin || a.admin, exceptMemberId: a.member_id });
  }

  setImmediate(() => sync.writeCallToYclients(a.client_id,
    { result, note: `исправлено${text ? ': ' + text : ''}`, admin: admin || a.admin })
    .catch(e => console.error('[yc-writeback fix]', e.message)));

  return { ok: true, result, status: snoozed ? 'snoozed' : 'done', due_date: until };
}

app.patch('/api/actions/:id', (req, res) => {
  const { result, note, admin, snooze_until } = req.body || {};
  if (!result) return res.status(400).json({ error: 'Укажите результат' });
  const r = fixAction(req.params.id, { result, note, admin, snooze_until });
  if (!r) return res.status(404).json({ error: 'action not found' });
  res.json(r);
});

// Черновик заметки: сохраняется, пока админ печатает. Без этого набранный текст пропадал
// при уходе на другую вкладку или перезагрузке — а звонок уже состоялся, и записать его
// содержание было не с чего.
app.patch('/api/tasks/:id/note', (req, res) => {
  const note = String((req.body || {}).note ?? '');
  db.prepare('UPDATE tasks SET draft_note=? WHERE id=?').run(note, Number(req.params.id));
  res.json({ ok: true });
});

app.patch('/api/lists/:id/members/:memberId/note', (req, res) => {
  const note = String((req.body || {}).note ?? '');
  db.prepare('UPDATE list_members SET draft_note=? WHERE id=? AND list_id=?')
    .run(note, Number(req.params.memberId), Number(req.params.id));
  res.json({ ok: true });
});

// Зафиксировать результат звонка + заметку. Меняет статус задачи.
app.post('/api/tasks/:id/action', (req, res) => {
  const { result, note, admin, snooze_days, snooze_until } = req.body || {};
  const r = applyTaskAction(req.params.id, { result, note, admin, snooze_days, snooze_until });
  if (!r) return res.status(404).json({ error: 'task not found' });
  res.json({ ok: true, status: r.status, due_date: r.due_date });
});

// Вернуть отложенную задачу в работу. Возвращаем те, чей срок УЖЕ ПРОШЁЛ по дате:
// отложенные на сегодня и так показываются в списке (красной карточкой со временем),
// поэтому переводить их в open посреди дня незачем — иначе они потеряли бы пометку.
app.post('/api/tasks/reopen-due', (req, res) => {
  const n = db.prepare(`UPDATE tasks SET status='open'
    WHERE status='snoozed' AND date(due_date) < date('now','localtime')`).run();
  res.json({ reopened: n.changes });
});

// --- Запись клиента к мастеру (создание записи прямо в YClients) --------------
// Цепочка справочников повторяет виджет онлайн-записи: мастера → услуги мастера →
// рабочие дни → свободные слоты. Филиал берём из карточки клиента (у человека может быть
// по карточке в каждом филиале — записываем в тот, из которого пришла задача).

const CLIENT_FIELDS = 'id, yclients_id, company_id, branch, name, phone, favorite_staff, favorite_service';
const getClient = (id) => db.prepare(`SELECT ${CLIENT_FIELDS} FROM clients WHERE id=?`).get(Number(id));

// company_id: явный параметр или филиал клиента
function bookingCompany(req) {
  const cid = (req.query.company_id || '').trim();
  if (cid) return cid;
  const c = req.query.client_id ? getClient(req.query.client_id) : null;
  return c?.company_id ? String(c.company_id) : '';
}
const svcIds = (v) => String(v || '').split(',').map(s => s.trim()).filter(Boolean);

// Клиент захотел записаться в ДРУГОЙ салон, не тот, из которого пришла задача.
// В YClients человек — отдельная карточка в каждом филиале, поэтому ищем его карточку
// в выбранном салоне по телефону (последние 10 цифр). Не нашли — записываем «новым»:
// YClients заведёт карточку сам по телефону и имени, ночной синк её подтянет.
function cardInCompany(client, companyId) {
  const cid = Number(companyId);
  if (!cid || cid === Number(client.company_id)) return client;
  const digits = people.normPhone(client.phone);
  if (!people.isRealPhone(digits)) return null;
  return db.prepare(`SELECT ${CLIENT_FIELDS} FROM clients
    WHERE company_id = ? AND substr(replace(replace(replace(replace(phone,' ',''),'-',''),'(',''),')',''), -10) = ?
    ORDER BY visits_count DESC LIMIT 1`).get(cid, digits.slice(-10)) || null;
}

// Что показать в форме записи до обращения к YClients: филиалы сети и тот, где числится
// клиент (он подставляется по умолчанию, но админ волен выбрать другой салон).
app.get('/api/booking/context', (req, res) => {
  const c = req.query.client_id ? getClient(req.query.client_id) : null;
  const branches = db.prepare(`SELECT branch, company_id FROM clients
    WHERE branch IS NOT NULL AND branch <> '' GROUP BY branch ORDER BY branch`).all();
  res.json({ branches, company_id: c?.company_id || null, branch: c?.branch || null });
});

app.get('/api/booking/staff', async (req, res) => {
  const cid = bookingCompany(req);
  if (!cid) return res.status(400).json({ error: 'Не определён филиал' });
  try {
    const list = await yc.fetchBookStaff(cid);
    const client = req.query.client_id ? getClient(req.query.client_id) : null;
    res.json((Array.isArray(list) ? list : [])
      .filter(s => s.bookable && !s.fired)
      .map(s => ({
        id: s.id, name: s.name, specialization: s.specialization || '',
        // подсветим «любимого» мастера клиента, чтобы админ не искал его в списке
        favorite: Boolean(client?.favorite_staff && client.favorite_staff === s.name),
      })));
  } catch (e) { console.error('[booking/staff]', e.message); res.status(502).json({ error: e.message }); }
});

app.get('/api/booking/services', async (req, res) => {
  const cid = bookingCompany(req);
  const staffId = (req.query.staff_id || '').trim();
  if (!cid) return res.status(400).json({ error: 'Не определён филиал' });
  try {
    const data = await yc.fetchBookServices(cid, staffId);
    const cats = {};
    for (const c of (data?.category || [])) cats[c.id] = c.title || '';
    const client = req.query.client_id ? getClient(req.query.client_id) : null;
    res.json((data?.services || []).map(s => ({
      id: s.id, title: s.title, category: cats[s.category_id] || '',
      price_min: s.price_min, price_max: s.price_max, seance_length: s.seance_length || 0,
      favorite: Boolean(client?.favorite_service && String(client.favorite_service).includes(s.title)),
    })));
  } catch (e) { console.error('[booking/services]', e.message); res.status(502).json({ error: e.message }); }
});

app.get('/api/booking/dates', async (req, res) => {
  const cid = bookingCompany(req);
  const staffId = (req.query.staff_id || '').trim();
  if (!cid || !staffId) return res.status(400).json({ error: 'Нужны филиал и мастер' });
  try {
    const d = await yc.fetchBookDates(cid, staffId, svcIds(req.query.service_ids));
    res.json({ dates: d?.booking_dates || d?.working_dates || [] });
  } catch (e) { console.error('[booking/dates]', e.message); res.status(502).json({ error: e.message }); }
});

app.get('/api/booking/times', async (req, res) => {
  const cid = bookingCompany(req);
  const staffId = (req.query.staff_id || '').trim();
  const date = (req.query.date || '').trim();
  if (!cid || !staffId || !date) return res.status(400).json({ error: 'Нужны филиал, мастер и дата' });
  try {
    const list = await yc.fetchBookTimes(cid, staffId, date, svcIds(req.query.service_ids));
    res.json((Array.isArray(list) ? list : []).map(t => ({
      time: t.time, datetime: t.datetime, seance_length: t.seance_length || t.sum_length || 0,
    })));
  } catch (e) { console.error('[booking/times]', e.message); res.status(502).json({ error: e.message }); }
});

// Создать запись в YClients + сразу подтянуть её к нам + зафиксировать звонок как «Записал».
// Записей может быть несколько: за один визит клиент идёт к нескольким мастерам (маникюр и
// педикюр параллельно), а в YClients каждая услуга у своего мастера — отдельная запись.
const BOOKING_MAX_ITEMS = 4;
app.post('/api/booking/create', async (req, res) => {
  if (yc.isDemo()) return res.status(400).json({ error: 'Демо-режим: запись в YClients недоступна' });
  const {
    client_id, staff_id, service_ids, datetime, seance_length, items,
    comment, send_sms, task_id, member_id, action_id, note, admin, company_id,
  } = req.body || {};

  // старая форма слала одну запись плоскими полями — понимаем оба вида
  const list = Array.isArray(items) && items.length
    ? items
    : [{ staff_id, service_ids, datetime, seance_length }];

  const client = getClient(client_id);
  if (!client) return res.status(404).json({ error: 'Клиент не найден' });
  if (!client.yclients_id || !client.company_id) return res.status(400).json({ error: 'У клиента нет карточки в YClients' });
  if (list.length > BOOKING_MAX_ITEMS) return res.status(400).json({ error: `За раз не больше ${BOOKING_MAX_ITEMS} записей` });
  for (const it of list) {
    if (!it.staff_id || !it.datetime || !Array.isArray(it.service_ids) || !it.service_ids.length) {
      return res.status(400).json({ error: 'Нужны мастер, услуга и время' });
    }
  }

  // Салон выбирает админ прямо в форме, причём У КАЖДОЙ СТРОКИ свой: клиент может взять
  // одну услугу в одном салоне, а другую — в соседнем. Карточку клиента в нужном салоне
  // ищем отдельно для каждого (в другом филиале у человека своя карточка, а то и никакой —
  // тогда YClients заведёт её по телефону и имени).
  const branchNameStmt = db.prepare('SELECT branch FROM clients WHERE company_id=? AND branch IS NOT NULL LIMIT 1');
  const salonOf = (it) => {
    const cid = Number(it.company_id) || Number(company_id) || Number(client.company_id);
    return { cid, card: cardInCompany(client, cid),
      branchName: branchNameStmt.get(cid)?.branch || client.branch };
  };

  // Записи создаём по очереди: YClients принимает по одному мастеру за запрос, а
  // save_if_busy:false страхует от гонки — окно могли занять, пока админ говорил с клиентом.
  // Часть могла не пройти: удачные НЕ откатываем (клиент на них уже согласился), но честно
  // возвращаем список несостоявшихся, чтобы админ увидел, чего не хватает.
  const created = [], failed = [];
  for (const it of list) {
    const salon = salonOf(it);
    try {
      const r = await yc.createRecord(salon.cid, {
        staff_id: Number(it.staff_id),
        services: it.service_ids.map(id => ({ id: Number(id) })),
        // карточки в этом салоне может не быть — тогда YClients заведёт её по телефону и имени
        client: {
          ...(salon.card?.yclients_id ? { id: salon.card.yclients_id } : {}),
          phone: String(client.phone || '').replace(/\D/g, ''),
          name: client.name || '',
        },
        datetime: it.datetime,
        seance_length: Number(it.seance_length) || undefined,
        save_if_busy: false,
        // СМС клиенту салон отправляет сам с телефона администратора (решение Антона
        // 13.08.2026) — из CRM не шлём, иначе клиент получит два сообщения
        send_sms: send_sms === true,
        comment: comment || '',
        api_id: '',
      });
      const rec = Array.isArray(r) ? r[0] : r;
      if (!rec?.id) throw new Error('YClients не вернул номер записи');
      created.push({ rec, requested: it, salon });
    } catch (e) {
      console.error('[booking/create]', e.message);
      failed.push({ staff_id: it.staff_id, datetime: it.datetime, error: e.message });
    }
  }
  if (!created.length) {
    return res.status(502).json({ error: 'YClients не принял запись: ' + (failed[0]?.error || 'неизвестная ошибка') });
  }

  // Подтягиваем созданные записи к себе, чтобы они сразу были видны в ленте и в журнале
  let imported = 0;
  for (const c of created) {
    try {
      if ((await sync.importRecord(c.salon.cid, c.salon.branchName, c.rec.id))?.ok) imported++;
    } catch (e) { console.error('[booking/import]', e.message); }
  }

  const fmt = (dt) => new Date(dt).toLocaleString('ru-RU',
    { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
  const madeList = created.map(({ rec, requested, salon }) => {
    const staffName = rec.staff?.name || '';
    const svcTitles = (rec.services || []).map(s => s.title).filter(Boolean).join(', ');
    return { record_id: rec.id, datetime: rec.datetime || requested.datetime,
      when: fmt(rec.datetime || requested.datetime), staff: staffName, services: svcTitles,
      branch: salon.branchName || '' };
  });
  // в failed отдаём staff_id: имя мастера подставит дашборд, он его и выбирал
  // Салон в заметке называем, только если записи разъехались по разным — иначе это шум:
  // обычно человек идёт в свой салон, и админ его и так видит в карточке.
  const manyBranches = new Set(madeList.map(m => m.branch)).size > 1;
  const booking = 'Запись: ' + madeList.map(m =>
    `${m.when}, ${m.services}${m.staff ? ' — ' + m.staff : ''}${manyBranches && m.branch ? ` (${m.branch})` : ''}`
  ).join('; ');
  const fullNote = [note && note.trim(), booking].filter(Boolean).join('. ');

  // Фиксируем звонок как «Записал»: задача/участник списка + лента клиента + карточка YClients.
  // action_id — запись пришла из исправления результата: правим прежний звонок, а не добавляем новый.
  let action = null;
  if (action_id) action = fixAction(action_id, { result: 'booked', note: fullNote, admin });
  else if (task_id) action = applyTaskAction(task_id, { result: 'booked', note: fullNote, admin });
  else if (member_id) action = applyMemberAction(member_id, { result: 'booked', note: fullNote, admin });
  else {
    db.prepare('INSERT INTO task_actions(task_id,client_id,admin,result,note,created_at) VALUES(NULL,?,?,?,?,?)')
      .run(client.id, admin || 'admin', 'booked', fullNote, new Date().toISOString());
    setImmediate(() => sync.writeCallToYclients(client.id, { result: 'booked', note: fullNote, admin })
      .catch(e => console.error('[yc-writeback booking]', e.message)));
  }

  res.json({
    ok: true, created: madeList, failed,
    // одиночные поля — для совместимости со старыми вызовами
    record_id: madeList[0].record_id, datetime: madeList[0].datetime,
    staff: madeList[0].staff, services: madeList[0].services, when: madeList[0].when,
    imported, status: action?.status || null,
  });
});

// Ручная отметка «не беспокоить» из дашборда (переопределяет авто-детект по комментарию).
// value: true — принудительно ДА, false — принудительно НЕТ, null — снять ручную отметку (вернуть авто).
app.post('/api/clients/:id/dnc', (req, res) => {
  const id = Number(req.params.id);
  const c = db.prepare('SELECT id, name, comment FROM clients WHERE id=?').get(id);
  if (!c) return res.status(404).json({ error: 'client not found' });
  const v = req.body?.value;
  const manual = v === true ? 1 : v === false ? 0 : null;
  // при снятии ручной отметки возвращаемся к авто-детекту по имени/комментарию
  const auto = (sync.DNC_RE.test(c.name || '') || sync.DNC_RE.test(sync.originalComment(c.comment))) ? 1 : 0;
  const eff = manual != null ? manual : auto;
  db.prepare('UPDATE clients SET dnc_manual=?, do_not_call=? WHERE id=?').run(manual, eff, id);
  // если теперь «не беспокоить» — снимаем его открытые задачи
  if (eff) {
    db.prepare(`UPDATE tasks SET status='dismissed', closed_at=? WHERE client_id=? AND status IN ('open','snoozed')`)
      .run(new Date().toISOString(), id);
  }
  res.json({ ok: true, do_not_call: eff, manual });
});

// --- Клиенты / история -------------------------------------------------------

app.get('/api/clients', (req, res) => {
  const q = `%${(req.query.q || '').toLowerCase()}%`;
  const branch = (req.query.branch || '').trim();
  const rows = db.prepare(`
    SELECT id, name, phone, branch, last_visit, visits_count, spent, avg_interval_days,
           predicted_next, favorite_staff, favorite_service, comment, COALESCE(do_not_call,0) AS do_not_call
    FROM clients
    WHERE (lower_u(name) LIKE ? OR phone LIKE ?) ${branch ? 'AND branch = ?' : ''}
    ORDER BY last_visit DESC
    LIMIT 500
  `).all(...(branch ? [q, q, branch] : [q, q]));
  res.json(rows);
});

// --- Человек = все его карточки ------------------------------------------------
// В YClients у клиента отдельная карточка в каждом филиале (разный id, один телефон).
// Карточка в дашборде должна показывать человека целиком, иначе визиты и деньги
// оказываются вдвое меньше, чем в YClients.
function personCards(client) {
  const d = people.normPhone(client.phone);
  if (!people.isRealPhone(d)) return [client];
  const rows = db.prepare(`SELECT * FROM clients WHERE replace(replace(replace(replace(phone,' ',''),'-',''),'(',''),')','') LIKE ?`)
    .all('%' + d.slice(-10));
  const same = rows.filter(r => people.personKey(r) === people.personKey(client));
  return same.length ? same : [client];
}

// Подробная статистика по клиенту. ids — все карточки человека (обычно одна, у «двухфилиальных» две)
function computeClientStats(id, client, ids = [id]) {
  const ph = ids.map(() => '?').join(',');
  const visits = db.prepare(`SELECT date, service, staff, cost, status FROM visits WHERE client_id IN (${ph})`).all(...ids);
  const completed = visits.filter(v => v.status === 'completed');
  const cancelled = visits.filter(v => v.status === 'cancelled').length;
  // «Записан» — ТОЛЬКО будущая запись. Записи с прошедшей датой, которым в YClients так и не
  // проставили посещаемость (attendance 0/2), навсегда остаются в статусе upcoming: карточка
  // из-за них показывала «Записан», а движок задач (он смотрит date >= now) справедливо
  // ставил «пора записать». Отсюда и расхождение — считаем их отдельно, как «не отмечены».
  const nowMs = Date.now();
  const isFuture = v => new Date(v.date).getTime() >= nowMs;
  const upcoming = visits.filter(v => v.status === 'upcoming' && isFuture(v)).length;
  const unmarked = visits.filter(v => v.status === 'upcoming' && !isFuture(v)).length;

  // Визит = поход в салон (календарный день): за один поход клиент берёт несколько услуг
  // у разных мастеров, и каждая приезжает из YClients отдельной записью.
  const trips = sync.toTrips(completed);
  const noShowTrips = sync.toTrips(visits.filter(v => v.status === 'no_show')).length;

  const totalSpent = completed.reduce((s, v) => s + (v.cost || 0), 0);
  const avgCheck = trips.length ? Math.round(totalSpent / trips.length) : 0;

  // разбивка по услугам и мастерам: полный список с долей от всех визитов (в %)
  const group = (key) => {
    const m = {};
    completed.forEach(v => {
      const k = v[key] || '—';
      if (!m[k]) m[k] = { name: k, count: 0, sum: 0 };
      m[k].count++; m[k].sum += v.cost || 0;
    });
    return Object.values(m).sort((a, b) => b.count - a.count)
      .map(x => ({ ...x, pct: completed.length ? Math.round(x.count / completed.length * 100) : 0 }));
  };

  // Покупки товаров: и те, что сделаны на визите, и отдельные продажи на кассе.
  // Считаются по всем карточкам человека, как визиты и деньги.
  const purchases = db.prepare(
    `SELECT date, title, qty, cost, staff, record_id, source, branch
     FROM purchases WHERE client_id IN (${ph}) ORDER BY date DESC`).all(...ids);
  const goodsSpent = purchases.reduce((s, p) => s + (p.cost || 0), 0);
  const goodsMap = {};
  purchases.forEach(p => {
    const k = p.title || '—';
    if (!goodsMap[k]) goodsMap[k] = { name: k, count: 0, sum: 0, last: null };
    goodsMap[k].count += p.qty || 1;
    goodsMap[k].sum += p.cost || 0;
    if (!goodsMap[k].last || p.date > goodsMap[k].last) goodsMap[k].last = p.date;
  });
  const goods = Object.values(goodsMap).sort((a, b) => b.sum - a.sum)
    .map(x => ({ ...x, pct: goodsSpent ? Math.round(x.sum / goodsSpent * 100) : 0 }));

  // активность по месяцам за последние 12 мес.
  const months = [];
  const base = new Date(); base.setDate(1);
  for (let i = 11; i >= 0; i--) {
    const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    months.push({ key, label: d.toLocaleDateString('ru-RU', { month: 'short' }), count: 0 });
  }
  const mMap = new Map(months.map(m => [m.key, m]));
  trips.forEach(t => {                       // по походам, а не по строкам-услугам
    const key = t.day.slice(0, 7);
    if (mMap.has(key)) mMap.get(key).count++;
  });

  // Периодичность и прогноз считаем по СЛИТОЙ истории человека, а не по одной карточке:
  // иначе у «двухфилиального» клиента интервал получается из трёх визитов одного филиала.
  const freq = sync.computeFrequency(visits) || {};
  const lastVisit = freq.last_visit || client.last_visit;
  const avgInterval = freq.avg_interval_days ?? client.avg_interval_days;
  const predictedNext = freq.predicted_next || client.predicted_next;

  // статус клиента по той же логике, что и правила
  const DAY = 86400000;
  const sinceLast = lastVisit ? Math.round((Date.now() - new Date(lastVisit)) / DAY) : null;
  let status = 'new', statusLabel = 'Новый';
  if (avgInterval && sinceLast != null) {
    if (upcoming > 0) { status = 'booked'; statusLabel = 'Записан'; }
    else if (sinceLast > avgInterval * 2) { status = 'churn'; statusLabel = 'Уходит'; }
    else if (predictedNext && Date.now() > new Date(predictedNext).getTime() + 3 * DAY) { status = 'due'; statusLabel = 'Пора записать'; }
    else { status = 'active'; statusLabel = 'Активен'; }
  } else if (upcoming > 0) { status = 'booked'; statusLabel = 'Записан'; }

  const attended = trips.length + noShowTrips;
  return {
    total_visits: trips.length,          // походов в салон
    services_done: completed.length,     // оказанных услуг (строк-записей)
    no_show: noShowTrips,
    cancelled,
    upcoming,
    unmarked,
    cards: ids.length,
    completion_rate: attended ? Math.round((trips.length / attended) * 100) : null,
    total_spent: totalSpent,
    avg_check: avgCheck,
    since_last_days: sinceLast,
    last_visit: lastVisit || null,
    avg_interval_days: avgInterval ?? null,
    predicted_next: predictedNext || null,
    services: group('service'),
    masters: group('staff'),
    goods,                               // разбивка по товарам (сумма, штук, доля, последняя покупка)
    goods_spent: goodsSpent,             // сколько человек оставил на товарах за всё время
    goods_items: purchases.length,       // строк-покупок
    months,
    status,
    status_label: statusLabel,
  };
}

// Карточка человека целиком: сам клиент + сводка по всем его карточкам (филиалам)
function loadPerson(id) {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(Number(id));
  if (!client) return null;
  const cards = personCards(client);
  const ids = cards.map(c => c.id);
  // деньги и депозит из YClients суммируем по всем карточкам человека
  const ycSpent = cards.reduce((s, c) => s + (c.yc_spent ?? 0), 0);
  const hasYcSpent = cards.some(c => c.yc_spent != null);
  const merged = {
    ...client,
    yc_spent: hasYcSpent ? ycSpent : null,
    yc_balance: cards.reduce((s, c) => s + (c.yc_balance || 0), 0),
    discount_pct: Math.max(...cards.map(c => c.discount_pct || 0)),
    branches: cards.map(c => c.branch).filter(Boolean),
    // комментарии админов бывают в обеих карточках — показываем оба
    comment: [...new Set(cards.map(c => c.comment).filter(Boolean))].join('\n'),
    do_not_call: cards.some(c => c.do_not_call) ? 1 : 0,
  };
  return { client: merged, ids, cards };
}

app.get('/api/clients/:id/stats', (req, res) => {
  const p = loadPerson(req.params.id);
  if (!p) return res.status(404).json({ error: 'client not found' });
  res.json({ client: p.client, stats: computeClientStats(p.client.id, p.client, p.ids) });
});

// Единая лента событий клиента: визиты + звонки/заметки + статистика.
// Собирается по ВСЕМ карточкам человека, чтобы визиты из второго филиала не терялись.
app.get('/api/clients/:id/timeline', (req, res) => {
  const p = loadPerson(req.params.id);
  if (!p) return res.status(404).json({ error: 'client not found' });
  const ph = p.ids.map(() => '?').join(',');
  const nowMs = Date.now();

  const visits = db.prepare(`SELECT date, service, staff, cost, status, branch FROM visits WHERE client_id IN (${ph})`).all(...p.ids)
    .map(v => ({
      kind: 'visit', date: v.date,
      // прошедшая запись, которой не проставили посещаемость в YClients — не «предстоит»
      status: (v.status === 'upcoming' && new Date(v.date).getTime() < nowMs) ? 'unmarked' : v.status,
      title: v.service || 'Визит', staff: v.staff, cost: v.cost, branch: v.branch,
    }));

  const actions = db.prepare(`
    SELECT a.created_at AS date, a.admin, a.result, a.note, t.type
    FROM task_actions a LEFT JOIN tasks t ON t.id = a.task_id
    WHERE a.client_id IN (${ph})
  `).all(...p.ids).map(a => ({ kind: 'call', date: a.date, admin: a.admin, result: a.result, note: a.note, task_type: a.type }));

  const tasks = db.prepare(`SELECT id, type, status, reason, created_at AS date FROM tasks WHERE client_id IN (${ph})`).all(...p.ids)
    .map(t => ({ kind: 'task', date: t.date, type: t.type, type_label: TYPE_LABEL[t.type] || t.type, status: t.status, reason: t.reason }));

  const timeline = [...visits, ...actions, ...tasks].sort((a, b) => new Date(b.date) - new Date(a.date));
  res.json({ client: p.client, stats: computeClientStats(p.client.id, p.client, p.ids), timeline });
});

// --- Дашборд владельца -------------------------------------------------------

app.get('/api/stats', (req, res) => {
  const branch = (req.query.branch || '').trim();
  const bw = branch ? 'AND c.branch = ?' : '';
  const bArgs = branch ? [branch] : [];

  const open = taskCounts(branch);
  const openTotal = Object.values(open).reduce((a, b) => a + b, 0);

  // Обзор — про АВТОЗАДАЧИ. Звонки по спискам конструктора (task_id IS NULL) считаются
  // отдельно, на вкладке «Обзвоны», иначе одна работа размывала бы показатели другой.
  const todayActions = db.prepare(`
    SELECT a.result, COUNT(*) n FROM task_actions a JOIN clients c ON c.id = a.client_id
    WHERE a.task_id IS NOT NULL AND date(a.created_at) = date('now') ${bw} GROUP BY a.result
  `).all(...bArgs);
  const resultMap = {};
  for (const r of todayActions) resultMap[r.result] = r.n;

  const byAdmin = db.prepare(`
    SELECT COALESCE(a.admin,'—') admin,
           COUNT(*) total,
           SUM(CASE WHEN a.result='booked' THEN 1 ELSE 0 END) booked
    FROM task_actions a JOIN clients c ON c.id = a.client_id
    WHERE a.task_id IS NOT NULL AND date(a.created_at) = date('now') ${bw}
    GROUP BY a.admin ORDER BY total DESC
  `).all(...bArgs);

  // «Обработано сегодня» = по скольким задачам админ отчитался, включая «перезвонить»
  // и «не ответил»: раньше считались только закрытые, и половина работы пропадала.
  const doneToday = db.prepare(`SELECT COUNT(DISTINCT a.task_id) n FROM task_actions a
    JOIN clients c ON c.id = a.client_id
    WHERE a.task_id IS NOT NULL AND date(a.created_at)=date('now','localtime') ${bw}`).get(...bArgs).n;
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
    clients_total: db.prepare(`SELECT COUNT(*) n FROM clients ${branch ? 'WHERE branch = ?' : ''}`).get(...bArgs).n,
  });
});

// Детальный журнал обзвона для владельца: кто звонил, кому, результат, заметка,
// и если записал — ближайшая запись клиента (услуга/мастер/время из YClients-визитов).
// scope: 'tasks' — звонки по автозадачам (вкладка «Обзор»), 'lists' — по спискам
// конструктора (вкладка «Обзвоны»). У звонков из списков task_id = NULL.
function journalHandler(scope) {
  return (req, res) => {
  const branch = (req.query.branch || '').trim();
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
  const filterAdmin = (req.query.admin || '').trim();
  const filterResult = (req.query.result || '').trim();

  const conds = [`a.created_at >= datetime('now', ?)`,
    scope === 'lists' ? 'a.task_id IS NULL' : 'a.task_id IS NOT NULL'];
  const args = [`-${days} days`];
  if (branch) { conds.push('c.branch = ?'); args.push(branch); }
  if (filterAdmin) { conds.push('a.admin = ?'); args.push(filterAdmin); }
  if (filterResult) { conds.push('a.result = ?'); args.push(filterResult); }

  // К «перезвонить» и «не ответил» показываем ДОГОВОРЁННОСТЬ: когда именно набрать снова.
  // Срок живёт в задаче (due_date) или в строке списка (callback_at) — берём тот, что есть.
  const rows = db.prepare(`
    SELECT a.id, a.created_at, a.admin, a.result, a.note,
           COALESCE(t.due_date, m.callback_at) AS callback_at,
           c.id AS client_id, c.name, c.phone, c.branch
    FROM task_actions a
    JOIN clients c ON c.id = a.client_id
    LEFT JOIN tasks t ON t.id = a.task_id AND t.status = 'snoozed'
    LEFT JOIN list_members m ON m.id = a.member_id AND m.status = 'snoozed'
    WHERE ${conds.join(' AND ')}
    ORDER BY a.created_at DESC
    LIMIT 300
  `).all(...args);

  // ближайшая будущая запись клиента (для тех, кого записали)
  const upStmt = db.prepare(`
    SELECT date, service, staff, branch FROM visits
    WHERE client_id = ? AND status = 'upcoming' AND date >= datetime('now')
    ORDER BY date ASC LIMIT 1`);

  const items = rows.map(r => {
    const booking = (r.result === 'booked') ? upStmt.get(r.client_id) : null;
    return { ...r, booking: booking || null };
  });
  res.json({ days, count: items.length, items });
  };
}
app.get('/api/overview/journal', journalHandler('tasks'));
app.get('/api/calls/journal', journalHandler('lists'));

// Статистика вкладки «Обзвоны»: прогресс по спискам конструктора и результаты звонков
// именно по ним. Списки — ручная работа админов «позвать вот этих», у неё своя воронка.
app.get('/api/calls/stats', (req, res) => {
  const branch = (req.query.branch || '').trim();
  const bw = branch ? 'AND c.branch = ?' : '';
  const bArgs = branch ? [branch] : [];

  const progress = db.prepare(`
    SELECT COUNT(DISTINCT l.id) lists, COUNT(m.id) members,
           SUM(CASE WHEN m.status IN ('done','snoozed') THEN 1 ELSE 0 END) done,
           SUM(CASE WHEN m.status='snoozed' THEN 1 ELSE 0 END) snoozed
    FROM lists l JOIN list_members m ON m.list_id = l.id
    JOIN clients c ON c.id = m.client_id
    WHERE l.status='active' ${bw}
  `).get(...bArgs);

  const results = {};
  for (const r of db.prepare(`
    SELECT a.result, COUNT(*) n FROM task_actions a JOIN clients c ON c.id = a.client_id
    WHERE a.task_id IS NULL AND date(a.created_at) = date('now') ${bw} GROUP BY a.result
  `).all(...bArgs)) results[r.result] = r.n;

  const byAdmin = db.prepare(`
    SELECT COALESCE(a.admin,'—') admin, COUNT(*) total,
           SUM(CASE WHEN a.result IN ('booked','coming') THEN 1 ELSE 0 END) booked
    FROM task_actions a JOIN clients c ON c.id = a.client_id
    WHERE a.task_id IS NULL AND date(a.created_at) = date('now') ${bw}
    GROUP BY a.admin ORDER BY total DESC
  `).all(...bArgs);

  // «Придёт» — согласие прийти на мероприятие/показ, записи в YClients при этом нет,
  // но для списков это такой же успешный итог звонка, как запись.
  const booked = results.booked || 0;
  const coming = results.coming || 0;
  const contacted = booked + coming + (results.refused || 0) + (results.callback || 0) + (results.no_calls || 0);
  res.json({
    lists: progress.lists || 0,
    members: progress.members || 0,
    done: progress.done || 0,
    left: (progress.members || 0) - (progress.done || 0),
    called_today: Object.values(results).reduce((a, b) => a + b, 0),
    booked_today: booked,
    coming_today: coming,
    conversion_pct: contacted ? Math.round(((booked + coming) / contacted) * 100) : 0,
    results_today: results,
    by_admin: byAdmin,
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

  // Разовая починка агрегатов, испорченных прежней логикой «считаем по окну синка»:
  // у 600+ клиентов visits_count/spent были занижены (а у не заходивших год — обнулены),
  // хотя вся история лежит в visits. Пересчитываем по локальной истории один раз.
  // v2 — заодно переводит visits_count на «походы в салон» (календарные дни) вместо строк-услуг
  if (!db.prepare("SELECT value FROM meta WHERE key='aggregates_rebuilt_v2'").get()) {
    const fixed = sync.rebuildAggregates();
    db.prepare("INSERT INTO meta(key,value) VALUES('aggregates_rebuilt_v2',?)").run(String(fixed));
    console.log(`[bootstrap] агрегаты пересчитаны по полной истории: клиентов ${fixed}`);
  }

  // «Не беспокоить» и скидки живут в имени клиента — пересчитываем при старте,
  // чтобы после выката они появились сразу, не дожидаясь ночного синка.
  const f = sync.recomputeFlags();
  if (f.discount_changed || f.dnc_changed) {
    console.log(`[bootstrap] признаки из имён: скидок обновлено ${f.discount_changed}, «не беспокоить» ${f.dnc_changed}`);
  }

  // Группировка конструктора по услугам работает по visits.service_category —
  // вся ранее загруженная история приехала до появления колонки, проставляем разово.
  const cats = sync.backfillVisitCategories();
  if (cats) console.log(`[bootstrap] категории услуг проставлены визитам: ${cats}`);

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
