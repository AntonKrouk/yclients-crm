'use strict';

const { db } = require('./db');
const yc = require('./yclients');
const rules = require('./rules');

const DAY = 86400000;

function iso(d) { return new Date(d).toISOString(); }

// Приводит запись YClients к нашему визиту + вытаскивает вложенного клиента.
// Реальная структура /records: services[].title/cost, staff.name, client{id,display_name,phone},
// datetime (ISO с таймзоной), attendance (1 пришёл, 0 ожидает, 2 подтверждён, -1 не пришёл), deleted.
function normalizeRecord(r) {
  const services = Array.isArray(r.services) ? r.services : [];
  const svcName = services.map(s => s.title || s.name).filter(Boolean).join(', ');
  const cost = services.reduce((s, x) => s + (Number(x.cost) || 0), 0);
  const staff = (r.staff && r.staff.name) || r.staff_name || '';
  const dt = r.datetime || r.date || r.create_date;
  const clientObj = r.client || null;
  const clientId = clientObj?.id || r.client_id;
  const att = r.attendance;
  let status = 'completed';
  const isFuture = new Date(dt).getTime() > Date.now();
  if (r.deleted) status = 'cancelled';
  else if (att === -1) status = 'no_show';
  else if (isFuture || att === 0 || att === 2) status = 'upcoming';

  const client = clientObj ? {
    id: clientObj.id,
    name: clientObj.display_name || [clientObj.name, clientObj.surname].filter(Boolean).join(' ') || 'Без имени',
    phone: clientObj.phone ? String(clientObj.phone) : '',
  } : null;

  return {
    yclients_record_id: r.id,
    client_id: clientId,
    client,
    date: iso(dt),
    service: svcName,
    staff,
    cost,
    status,
  };
}

function computeFrequency(visits) {
  const completed = visits
    .filter(v => v.status === 'completed')
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  if (completed.length === 0) return null;
  const first = completed[0].date;
  const last = completed[completed.length - 1].date;
  let avg = null;
  if (completed.length >= 2) {
    const span = new Date(last) - new Date(first);
    avg = span / (completed.length - 1) / DAY;
  }
  const predicted = avg ? iso(new Date(new Date(last).getTime() + avg * DAY)) : null;
  // любимый мастер/услуга — по частоте
  const top = (key) => {
    const m = {};
    completed.forEach(v => { if (v[key]) m[v[key]] = (m[v[key]] || 0) + 1; });
    return Object.entries(m).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  };
  return {
    first_visit: first,
    last_visit: last,
    visits_count: completed.length,
    spent: completed.reduce((s, v) => s + (v.cost || 0), 0),
    avg_interval_days: avg,
    predicted_next: predicted,
    favorite_staff: top('staff'),
    favorite_service: top('service'),
  };
}

const upsertClient = db.prepare(`
  INSERT INTO clients (yclients_id, company_id, branch, name, phone, first_visit, last_visit, visits_count, spent,
                       avg_interval_days, predicted_next, favorite_staff, favorite_service, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(yclients_id) DO UPDATE SET
    company_id=excluded.company_id, branch=excluded.branch,
    name=excluded.name, phone=excluded.phone, first_visit=excluded.first_visit,
    last_visit=excluded.last_visit, visits_count=excluded.visits_count, spent=excluded.spent,
    avg_interval_days=excluded.avg_interval_days, predicted_next=excluded.predicted_next,
    favorite_staff=excluded.favorite_staff, favorite_service=excluded.favorite_service, updated_at=excluded.updated_at
`);
const upsertVisit = db.prepare(`
  INSERT INTO visits (yclients_record_id, client_id, company_id, branch, date, service, staff, cost, status)
  VALUES (?,?,?,?,?,?,?,?,?)
  ON CONFLICT(yclients_record_id) DO UPDATE SET
    client_id=excluded.client_id, company_id=excluded.company_id, branch=excluded.branch,
    date=excluded.date, service=excluded.service, staff=excluded.staff, cost=excluded.cost, status=excluded.status
`);
const getClientLocalId = db.prepare('SELECT id FROM clients WHERE yclients_id = ?');

// Записывает клиентов и визиты одного филиала в базу с пометкой company_id/branch
function syncBranch(clients, records, company, now) {
  const byClient = new Map();
  for (const r of records) {
    const v = normalizeRecord(r);
    if (!v.client_id) continue;
    if (!byClient.has(v.client_id)) byClient.set(v.client_id, []);
    byClient.get(v.client_id).push(v);
  }
  const cid = Number(company.id) || null;
  let clientsN = 0, visitsN = 0;
  for (const c of clients) {
    const visits = byClient.get(c.id) || [];
    const freq = computeFrequency(visits) || {
      first_visit: null, last_visit: null, visits_count: 0, spent: 0,
      avg_interval_days: null, predicted_next: null, favorite_staff: null, favorite_service: null,
    };
    upsertClient.run(c.id, cid, company.name, c.name || '', c.phone || '', freq.first_visit, freq.last_visit,
      freq.visits_count, freq.spent, freq.avg_interval_days, freq.predicted_next,
      freq.favorite_staff, freq.favorite_service, now);
    const local = getClientLocalId.get(c.id);
    for (const v of visits) {
      upsertVisit.run(v.yclients_record_id, local.id, cid, company.name, v.date, v.service, v.staff, v.cost, v.status);
      visitsN++;
    }
    clientsN++;
  }
  return { clients: clientsN, visits: visitsN };
}

// Прайс-лист услуг филиала → таблица services (полная замена по филиалу)
const upsertService = db.prepare(`
  INSERT INTO services (yc_id, company_id, branch, title, category, price_min, price_max, active, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?)
  ON CONFLICT(company_id, yc_id) DO UPDATE SET
    branch=excluded.branch, title=excluded.title, category=excluded.category,
    price_min=excluded.price_min, price_max=excluded.price_max,
    active=excluded.active, updated_at=excluded.updated_at
`);

async function syncServices(comp, now) {
  const cid = Number(comp.id);
  let cats = {};
  try {
    const cc = await yc.fetchServiceCategories(comp.id);
    for (const c of (Array.isArray(cc) ? cc : [])) cats[c.id] = c.title || '';
  } catch { /* категории необязательны */ }
  const list = await yc.fetchServices(comp.id);
  const rows = Array.isArray(list) ? list : [];
  // те, кого больше нет в прайсе — помечаем неактивными, а не удаляем (могли попасть в старые списки)
  db.prepare('UPDATE services SET active=0 WHERE company_id=?').run(cid);
  for (const s of rows) {
    upsertService.run(s.id, cid, comp.name, s.title || '', cats[s.category_id] || '',
      s.price_min ?? null, s.price_max ?? null, s.active ? 1 : 0, now);
  }
  return rows.length;
}

function clientsFromRecords(records) {
  const m = new Map();
  for (const r of records) {
    const c = r.client || null;
    if (c && c.id && !m.has(c.id)) {
      m.set(c.id, {
        id: c.id,
        name: c.display_name || [c.name, c.surname].filter(Boolean).join(' ') || 'Без имени',
        phone: c.phone ? String(c.phone) : '',
      });
    }
  }
  return [...m.values()];
}

// --- Комментарии из карточек клиентов ----------------------------------------
// YClients отдаёт comment только в одиночной карточке (/client/{cid}/{id}), поэтому
// тянем их отдельным фоновым проходом с троттлингом (~170 запросов/мин).
// Инкрементально: непроверенные + активные клиенты не чаще раза в 3 дня.

const DNC_RE = /(не\s*звон|не\s*беспоко|нельзя\s*звон|не\s*тревож|не\s*писать|do\s*not\s*call)/i;
const THROTTLE_MS = 350;
let commentSync = { running: false, done: 0, total: 0 };

// Маркер нашего блока обзвона внутри комментария клиента YClients.
// Всё, что ДО него — «родной» текст админов; ниже — история звонков из дашборда.
const CRM_MARK = '——— Обзвон (CRM) ———';
// «родная» часть комментария (для детекта «не беспокоить» — наш лог не должен ложно триггерить)
function originalComment(text) {
  const t = String(text || '');
  const i = t.indexOf(CRM_MARK);
  return (i === -1 ? t : t.slice(0, i)).trim();
}
// человекочитаемый результат звонка
const RESULT_LABEL = {
  booked: 'записал', callback: 'перезвонить', no_answer: 'не ответил',
  refused: 'отказ', wrong_number: 'неверный номер', done: 'обработан',
};
// дозапись строки в CRM-блок (новые сверху), «родной» текст сохраняется
function appendCallLine(current, line) {
  const t = String(current || '');
  const i = t.indexOf(CRM_MARK);
  const original = (i === -1 ? t : t.slice(0, i)).trim();
  const log = (i === -1 ? '' : t.slice(i + CRM_MARK.length)).trim();
  const newLog = [line, log].filter(Boolean).join('\n');
  return [original, `${CRM_MARK}\n${newLog}`].filter(Boolean).join('\n\n');
}
// Записать результат звонка в карточку клиента YClients (дозаписью, сохранив исходный текст).
// clientLocalId — id в нашей БД. Тихо пропускаем демо/клиентов без yclients_id.
async function writeCallToYclients(clientLocalId, { result, note, admin, date } = {}) {
  if (yc.isDemo()) return { skipped: 'demo' };
  const c = db.prepare('SELECT yclients_id, company_id FROM clients WHERE id=?').get(clientLocalId);
  if (!c || !c.yclients_id || !c.company_id) return { skipped: 'no_yclients_id' };
  const d = date ? new Date(date) : new Date();
  const ds = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
  const who = (admin || 'админ').trim();
  const res = RESULT_LABEL[result] || result || 'звонок';
  const line = `${ds} ${who}: ${res}${note && note.trim() ? ` — «${note.trim()}»` : ''}`;
  const card = await yc.fetchClientCard(c.company_id, c.yclients_id);
  const next = appendCallLine(card?.comment || '', line);
  await yc.updateClient(c.company_id, c.yclients_id, { comment: next });
  // синхронизируем локальную копию комментария и флаг «не беспокоить» (по родной части)
  db.prepare('UPDATE clients SET comment=?, do_not_call=? WHERE id=?')
    .run(next, DNC_RE.test(originalComment(next)) ? 1 : 0, clientLocalId);
  return { ok: true, line };
}

async function syncComments({ full = false } = {}) {
  if (yc.isDemo()) return { skipped: 'demo' };
  if (commentSync.running) return { skipped: 'already_running' };
  const rows = db.prepare(`
    SELECT id, yclients_id, company_id, name FROM clients
    WHERE yclients_id IS NOT NULL AND company_id IS NOT NULL
    ${full ? '' : `AND (comment_checked_at IS NULL
                       OR (comment_checked_at < datetime('now','-3 days')
                           AND last_visit >= datetime('now','-120 days')))`}
  `).all();
  commentSync = { running: true, done: 0, total: rows.length };
  const upd = db.prepare('UPDATE clients SET comment=?, do_not_call=?, comment_checked_at=? WHERE id=?');
  let dnc = 0;
  try {
    for (const r of rows) {
      try {
        const card = await yc.fetchClientCard(r.company_id, r.yclients_id);
        const comment = String(card?.comment || '').trim();
        const flag = (DNC_RE.test(originalComment(comment)) || DNC_RE.test(r.name || '')) ? 1 : 0;
        upd.run(comment || null, flag, iso(Date.now()), r.id);
        if (flag) dnc++;
      } catch { /* сетевая ошибка или клиент удалён — не трогаем, попробуем в следующий проход */ }
      commentSync.done++;
      if (commentSync.done % 200 === 0) console.log(`[comments] ${commentSync.done}/${commentSync.total}`);
      await new Promise(rs => setTimeout(rs, THROTTLE_MS));
    }
    // «не беспокоить» — снимаем открытые задачи по таким клиентам
    const dismissed = db.prepare(`
      UPDATE tasks SET status='dismissed', closed_at=?
      WHERE status IN ('open','snoozed')
        AND client_id IN (SELECT id FROM clients WHERE COALESCE(do_not_call,0)=1)
    `).run(iso(Date.now())).changes;
    console.log(`[comments] проверено ${commentSync.done}/${commentSync.total}, «не беспокоить»: ${dnc}, снято задач: ${dismissed}`);
    return { checked: commentSync.done, total: commentSync.total, do_not_call: dnc, tasks_dismissed: dismissed };
  } finally {
    commentSync = { ...commentSync, running: false };
  }
}

function commentSyncStatus() { return { ...commentSync }; }

async function run(opts = {}) {
  const now = iso(Date.now());
  let totalC = 0, totalV = 0;

  if (yc.isDemo()) {
    const raw = yc.demoData();
    const res = syncBranch(raw.clients, raw.records, { id: 0, name: 'Демо' }, now);
    totalC += res.clients; totalV += res.visits;
  } else {
    await yc.ensureAuth(); // если токена нет, но есть логин/пароль в .env — получим токен
    const months = Number(opts.months) || Number(process.env.YCLIENTS_SYNC_MONTHS) || 12;
    const end = new Date();
    const start = new Date(); start.setMonth(start.getMonth() - months);
    const fmt = (d) => d.toISOString().slice(0, 10);

    // имена филиалов: из конфига, недостающие — из API
    const comps = yc.companies();
    let titles = {};
    try { for (const t of await yc.fetchMyCompanies()) titles[t.id] = t.title; } catch { /* необязательно */ }

    for (const comp of comps) {
      const name = comp.name || titles[comp.id] || comp.id;
      const records = await yc.fetchRecords(comp.id, fmt(start), fmt(end),
        (loaded, total) => { if (loaded % 1000 === 0 || loaded === total) console.log(`[sync] ${name}: записей ${loaded}/${total}`); });
      const clients = clientsFromRecords(records);
      const res = syncBranch(clients, records, { id: comp.id, name }, now);
      totalC += res.clients; totalV += res.visits;
      console.log(`[sync] ${name}: клиентов ${res.clients}, визитов ${res.visits} (окно ${months} мес.)`);
      try {
        const svcN = await syncServices({ id: comp.id, name }, now);
        console.log(`[sync] ${name}: услуг в прайсе ${svcN}`);
      } catch (e) { console.error(`[sync] ${name}: прайс-лист не загружен:`, e.message); }
    }
  }

  // «Не беспокоить» ловим и в имени клиента: в этом салоне админы пишут заметки прямо в имя
  // («писать в WA», «не звонить» и т.п.). Имя обновляется каждым синком — пересчитываем флаг.
  const flagRows = db.prepare(`SELECT id, name, comment, COALESCE(do_not_call,0) AS f FROM clients`).all();
  const updFlag = db.prepare('UPDATE clients SET do_not_call=? WHERE id=?');
  for (const r of flagRows) {
    const flag = (DNC_RE.test(r.name || '') || DNC_RE.test(originalComment(r.comment))) ? 1 : 0;
    if (flag !== r.f) updFlag.run(flag, r.id);
  }

  const tasksN = rules.generate();

  // Комментарии тянем фоном ПОСЛЕ ответа: первый проход долгий (~350 мс на клиента),
  // а «не беспокоить»-задачи, созданные до его завершения, снимутся внутри syncComments()
  if (!yc.isDemo() && !opts.skipComments) {
    setImmediate(() => syncComments().catch(e => console.error('[comments]', e.message)));
  }

  return { mode: yc.isDemo() ? 'demo' : 'live', clients: totalC, visits: totalV, tasks: tasksN, at: now };
}

module.exports = { run, computeFrequency, syncComments, commentSyncStatus, writeCallToYclients, CRM_MARK };
