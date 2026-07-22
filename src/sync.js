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
    }
  }

  const tasksN = rules.generate();
  return { mode: yc.isDemo() ? 'demo' : 'live', clients: totalC, visits: totalV, tasks: tasksN, at: now };
}

module.exports = { run, computeFrequency };
