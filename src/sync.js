'use strict';

const { db } = require('./db');
const yc = require('./yclients');
const rules = require('./rules');
const people = require('./people');

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
    // Когда запись СОЗДАЛИ. YClients отдаёт это отдельным полем; по дате визита
    // отличить «записался после звонка» от «был записан и так» невозможно.
    booked_at: r.create_date ? iso(r.create_date) : null,
  };
}

// Товары, проданные В РАМКАХ записи: YClients кладёт их прямо в /records полем
// goods_transactions, отдельных запросов не нужно. amount приходит со знаком минус —
// это списание со склада, нам нужно количество. Сертификаты продаются как товар и
// попадают сюда же (тип видно по названию, отдельного флага в API нет).
function purchasesFromRecord(r) {
  const goods = Array.isArray(r.goods_transactions) ? r.goods_transactions : [];
  if (!goods.length || r.deleted) return [];
  const staff = (r.staff && r.staff.name) || r.staff_name || '';
  const date = iso(r.datetime || r.date || r.create_date);
  return goods.map(g => ({
    yc_id: g.id,
    record_id: r.id || null,
    date,
    title: g.title || '',
    good_id: g.good_id || null,
    qty: Math.abs(Number(g.amount) || 1),
    cost: Number(g.cost_to_pay ?? g.cost ?? g.price) || 0,
    discount: Number(g.discount) || 0,
    staff,
    source: 'record',
  }));
}

// --- Визит = один поход в салон, а не одна строка записи -----------------------
// В этом салоне клиент за одно посещение берёт несколько услуг у РАЗНЫХ мастеров
// (услуга «*Параллельная работа мастеров»), и каждая приезжает из YClients отдельной
// записью. Считая их разными визитами, мы получали периодичность в часы вместо недель:
// у Бразговской выходило «~6 дней» при реальных ~3 неделях, а у карточки с тремя услугами
// в один день — 0.04 дня. На этом стоит вся логика задач (реактивация = 2× периодичности),
// поэтому клиентов звали возвращаться через неделю после визита.
// Считаем по календарным дням в часовом поясе салона.
const dayKey = (d) => new Date(d).toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });

// Группирует записи в походы: [{ day: 'YYYY-MM-DD', date: самая ранняя запись дня, cost, rows }]
function toTrips(visits) {
  const byDay = new Map();
  for (const v of visits) {
    const k = dayKey(v.date);
    if (!byDay.has(k)) byDay.set(k, { day: k, date: v.date, cost: 0, rows: 0 });
    const t = byDay.get(k);
    if (new Date(v.date) < new Date(t.date)) t.date = v.date;
    t.cost += v.cost || 0;
    t.rows++;
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

function computeFrequency(visits) {
  const completed = visits.filter(v => v.status === 'completed');
  if (completed.length === 0) return null;
  const trips = toTrips(completed);
  const first = trips[0].date;
  const last = trips[trips.length - 1].date;
  let avg = null;
  if (trips.length >= 2) {
    // интервал считаем между ДНЯМИ походов — время внутри дня роли не играет
    const span = new Date(trips[trips.length - 1].day) - new Date(trips[0].day);
    avg = span / (trips.length - 1) / DAY;
  }
  const predicted = avg ? iso(new Date(new Date(last).getTime() + avg * DAY)) : null;
  // любимый мастер/услуга — по частоте оказанных услуг
  const top = (key) => {
    const m = {};
    completed.forEach(v => { if (v[key]) m[v[key]] = (m[v[key]] || 0) + 1; });
    return Object.entries(m).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  };
  return {
    first_visit: first,
    last_visit: last,
    visits_count: trips.length,              // походов в салон
    services_count: completed.length,        // строк-записей (услуг) — для справки в карточке
    spent: completed.reduce((s, v) => s + (v.cost || 0), 0),
    avg_interval_days: avg,
    predicted_next: predicted,
    favorite_staff: top('staff'),
    favorite_service: top('service'),
  };
}

// Карточку клиента заводим/обновляем БЕЗ агрегатов: имя, телефон, филиал. Визиты и деньги
// пересчитываются отдельно (recomputeClient) по всей локальной истории — см. комментарий там.
const upsertClient = db.prepare(`
  INSERT INTO clients (yclients_id, company_id, branch, name, phone, birth_date, updated_at)
  VALUES (?,?,?,?,?,?,?)
  ON CONFLICT(yclients_id) DO UPDATE SET
    company_id=excluded.company_id, branch=excluded.branch,
    name=excluded.name, phone=excluded.phone, updated_at=excluded.updated_at,
    -- дату рождения синк по записям не знает (в /records её нет) и передаёт NULL —
    -- в этом случае бережём то, что уже добыл проход по карточкам
    birth_date=COALESCE(excluded.birth_date, clients.birth_date)
`);
const upsertVisitStmt = db.prepare(`
  INSERT INTO visits (yclients_record_id, client_id, company_id, branch, date, service, staff, cost, status, service_category, booked_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(yclients_record_id) DO UPDATE SET
    client_id=excluded.client_id, company_id=excluded.company_id, branch=excluded.branch,
    date=excluded.date, service=excluded.service, staff=excluded.staff, cost=excluded.cost,
    status=excluded.status, service_category=excluded.service_category,
    -- момент создания не перезаписываем пустотой: старые записи приехали без него
    booked_at=COALESCE(excluded.booked_at, visits.booked_at)
`);
// Обёртка: категорию услуги считаем сами по прайс-листу, вызывающим об этом знать не нужно.
const upsertVisit = {
  run(recId, clientId, cid, branch, date, service, staff, cost, status, bookedAt = null) {
    return upsertVisitStmt.run(recId, clientId, cid, branch, date, service, staff, cost, status,
      categoriesOf(service), bookedAt);
  },
};

// --- Категории услуг визита (денормализация прайс-листа) ---------------------
// visits.service хранит названия услуг склеенными через ', '. Чтобы конструктор мог
// фильтровать по ГРУППЕ услуг, держим рядом готовые названия категорий: иначе каждый
// запрос сверял бы 108 тыс. визитов с 750 строками прайса.
let svcCatCache = null;
function serviceCatMap() {
  if (svcCatCache) return svcCatCache;
  const m = new Map();
  const rows = db.prepare("SELECT title, category FROM services WHERE title <> '' AND COALESCE(category,'') <> ''").all();
  for (const s of rows) m.set(String(s.title).toLowerCase().trim(), s.category);
  svcCatCache = m;
  return m;
}
// '' (а не NULL) для визитов без узнаваемой услуги — чтобы бэкфилл не перебирал их каждый раз
function categoriesOf(serviceText) {
  const m = serviceCatMap();
  if (!m.size) return null;
  const out = new Set();
  for (const part of String(serviceText || '').split(', ')) {
    const c = m.get(part.trim().toLowerCase());
    if (c) out.add(c);
  }
  return out.size ? [...out].join(', ') : '';
}
// Проставляет категории визитам, у которых их ещё нет (после первой загрузки прайса
// и для всей истории, приехавшей до появления этой колонки).
function backfillVisitCategories() {
  if (!serviceCatMap().size) return 0;
  const rows = db.prepare("SELECT id, service FROM visits WHERE service_category IS NULL AND service <> ''").all();
  if (!rows.length) return 0;
  const upd = db.prepare('UPDATE visits SET service_category=? WHERE id=?');
  db.exec('BEGIN');
  try {
    for (const r of rows) upd.run(categoriesOf(r.service), r.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return rows.length;
}
const upsertPurchase = db.prepare(`
  INSERT INTO purchases (yc_id, client_id, company_id, branch, record_id, date, title, good_id, qty, cost, discount, staff, source, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(yc_id) DO UPDATE SET
    client_id=excluded.client_id, company_id=excluded.company_id, branch=excluded.branch,
    record_id=excluded.record_id, date=excluded.date, title=excluded.title, good_id=excluded.good_id,
    qty=excluded.qty, cost=excluded.cost, discount=excluded.discount, staff=excluded.staff,
    source=excluded.source, updated_at=excluded.updated_at
`);
const getClientLocalId = db.prepare('SELECT id FROM clients WHERE yclients_id = ?');

// --- Агрегаты клиента: ВСЕГДА по всей локальной истории визитов ---------------
// Раньше visits_count/spent считались по записям ТЕКУЩЕГО окна синка. Из-за этого
// «Загрузить 3 года» складывало глубокую историю в visits, а следующий рутинный синк
// (окно 12 мес.) затирал агрегаты урезанными числами — суммы в конструкторе выходили
// в разы меньше настоящих, а у клиентов, не заходивших год, обнулялись вовсе.
// Теперь окно синка определяет только то, ЧТО докачали; счёт идёт по таблице visits.
const clientVisitsStmt = db.prepare('SELECT date, service, staff, cost, status FROM visits WHERE client_id = ?');
const updAggregates = db.prepare(`
  UPDATE clients SET first_visit=?, last_visit=?, visits_count=?, services_count=?, spent=?,
    avg_interval_days=?, predicted_next=?, favorite_staff=?, favorite_service=?, updated_at=? WHERE id=?
`);
const EMPTY_FREQ = {
  first_visit: null, last_visit: null, visits_count: 0, services_count: 0, spent: 0,
  avg_interval_days: null, predicted_next: null, favorite_staff: null, favorite_service: null,
};

function recomputeClient(localId, now) {
  const f = computeFrequency(clientVisitsStmt.all(localId)) || EMPTY_FREQ;
  updAggregates.run(f.first_visit, f.last_visit, f.visits_count, f.services_count, f.spent,
    f.avg_interval_days, f.predicted_next, f.favorite_staff, f.favorite_service, now, localId);
}

// Разовый (и безопасный к повтору) пересчёт агрегатов по всем клиентам — чинит строки,
// испорченные прежней логикой окна.
function rebuildAggregates() {
  const now = iso(Date.now());
  const ids = db.prepare('SELECT id FROM clients').all();
  for (const r of ids) recomputeClient(r.id, now);
  return ids.length;
}

// Записывает клиентов и визиты одного филиала в базу с пометкой company_id/branch
function syncBranch(clients, records, company, now) {
  const byClient = new Map();
  const goodsByClient = new Map();
  for (const r of records) {
    const v = normalizeRecord(r);
    if (!v.client_id) continue;
    if (!byClient.has(v.client_id)) byClient.set(v.client_id, []);
    byClient.get(v.client_id).push(v);
    const goods = purchasesFromRecord(r);
    if (goods.length) {
      if (!goodsByClient.has(v.client_id)) goodsByClient.set(v.client_id, []);
      goodsByClient.get(v.client_id).push(...goods);
    }
  }
  const cid = Number(company.id) || null;
  let clientsN = 0, visitsN = 0, goodsN = 0;
  for (const c of clients) {
    const visits = byClient.get(c.id) || [];
    upsertClient.run(c.id, cid, company.name, c.name || '', c.phone || '',
      c.birth_date ? normBirthDate(c.birth_date) : null, now);
    const local = getClientLocalId.get(c.id);
    for (const v of visits) {
      upsertVisit.run(v.yclients_record_id, local.id, cid, company.name, v.date, v.service, v.staff, v.cost, v.status, v.booked_at);
      visitsN++;
    }
    for (const g of goodsByClient.get(c.id) || []) {
      upsertPurchase.run(g.yc_id, local.id, cid, company.name, g.record_id, g.date, g.title,
        g.good_id, g.qty, g.cost, g.discount, g.staff, g.source, now);
      goodsN++;
    }
    recomputeClient(local.id, now); // после записи визитов — по всей истории, а не по окну
    clientsN++;
  }
  return { clients: clientsN, visits: visitsN, goods: goodsN };
}

// Отменённые и удалённые записи YClients из выдачи /records просто пропадают, а не приходят
// с флагом. Поэтому после синка сверяем БУДУЩИЕ визиты филиала со свежей выдачей: чего нет —
// помечаем отменённым. Иначе клиент навсегда остался бы «уже записан»: задач ему не ставили бы,
// а в журнале обзвона висела бы несуществующая запись.
function reconcileFuture(records, company, endIso) {
  const alive = new Set(records.filter(r => !r.deleted).map(r => String(r.id)));
  const rows = db.prepare(`SELECT id, yclients_record_id FROM visits
    WHERE company_id = ? AND status = 'upcoming' AND date > ? AND date <= ?`)
    .all(Number(company.id) || null, iso(Date.now()), endIso);
  const upd = db.prepare("UPDATE visits SET status='cancelled' WHERE id=?");
  let n = 0;
  for (const r of rows) {
    if (!alive.has(String(r.yclients_record_id))) { upd.run(r.id); n++; }
  }
  return n;
}

// Подтянуть ОДНУ запись из YClients в локальную базу — вызывается сразу после создания записи
// из дашборда, чтобы она мгновенно появилась в ленте клиента и в журнале без полного синка
// (полный проход по 22 тыс. записей занимает минуты). Ночной синк потом всё равно всё сверит.
async function importRecord(cid, branch, recordId) {
  const r = await yc.fetchRecord(cid, recordId);
  const v = normalizeRecord(r);
  if (!v.client_id) return { skipped: 'no_client' };
  const local = getClientLocalId.get(v.client_id);
  if (!local) return { skipped: 'client_not_in_db' };
  upsertVisit.run(v.yclients_record_id, local.id, Number(cid) || null, branch || null,
    v.date, v.service, v.staff, v.cost, v.status, v.booked_at);
  // пересчитываем агрегаты клиента по локальным визитам (новая запись — будущая,
  // на статистику завершённых не влияет, но держим строку клиента консистентной)
  recomputeClient(local.id, iso(Date.now()));
  // запись сделана прямо из дашборда — звонок должен стать «Записан» сразу, не дожидаясь синка
  recomputeAutoBooked();
  return { ok: true, client_id: local.id, visit: v };
}

// --- «Звонок сработал»: человек записался в течение окна после разговора ---------
// Правило согласовано с руководством 24.08.2026: если клиент записался в течение
// ATTRIBUTION_DAYS дней после звонка, звонок считается результативным ВЕЗДЕ — и в журнале
// «Обзора», и в конверсии админов, и в аналитике. Флаг держим в task_actions.auto_booked:
// считать его на лету при каждом запросе значило бы сверять каждый звонок со всей таблицей
// визитов, а меняется он только после синка — значит, и пересчитывать надо там.
// Момент записи берём из YClients (booked_at). У записей без него ориентируемся на дату
// визита: она хотя бы не меняется задним числом. Отменённые записи не в счёт.
const ATTRIBUTION_DAYS = Number(process.env.CALL_ATTRIBUTION_DAYS) || 21;

function recomputeAutoBooked() {
  // имена колонок разводим явно: a.id и c.id приехали бы под одним ключом,
  // и второй затёр бы первый — флаг лёг бы не на тот звонок
  const actions = db.prepare(`SELECT a.id AS action_id, a.created_at, c.id AS id, c.phone
                              FROM task_actions a JOIN clients c ON c.id = a.client_id`).all();
  if (!actions.length) return 0;
  // моменты записи по ЧЕЛОВЕКУ: у двухфилиального клиента карточки разные, человек один
  const byPerson = new Map();
  for (const v of db.prepare(`
    SELECT COALESCE(v.booked_at, v.date) AS at, c.id, c.phone
    FROM visits v JOIN clients c ON c.id = v.client_id
    WHERE COALESCE(v.status,'') <> 'cancelled' AND COALESCE(v.booked_at, v.date) IS NOT NULL`).all()) {
    const k = people.personKey(v);
    if (!byPerson.has(k)) byPerson.set(k, []);
    byPerson.get(k).push(new Date(v.at).getTime());
  }
  const upd = db.prepare('UPDATE task_actions SET auto_booked=? WHERE id=?');
  let hits = 0;
  db.exec('BEGIN');
  try {
    for (const a of actions) {
      const t0 = new Date(a.created_at).getTime();
      const list = byPerson.get(people.personKey(a)) || [];
      const hit = list.some(t => t >= t0 && t <= t0 + ATTRIBUTION_DAYS * DAY) ? 1 : 0;
      upd.run(hit, a.action_id);
      hits += hit;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return hits;
}

// Лёгкий синк ТОЛЬКО будущего: окно «сегодня → +N дней» это пара страниц на филиал (секунды
// против минут у полного прохода), поэтому его можно гонять кроном часто. Нужен затем, чтобы
// клиент, записавшийся сам во время рабочего дня, быстро уходил из списка задач.
// ВАЖНО: обновляем только визиты. Карточки клиентов НЕ пересчитываем — их статистика считается
// по завершённым визитам, а здесь их нет, и пересчёт обнулил бы историю (visits_count, spent).
async function syncUpcoming(opts = {}) {
  if (yc.isDemo()) return { skipped: 'demo' };
  await yc.ensureAuth();
  const days = Number(opts.futureDays) || Number(process.env.YCLIENTS_SYNC_FUTURE_DAYS) || 180;
  const start = new Date();
  const end = new Date(); end.setDate(end.getDate() + days);
  const fmt = (d) => d.toISOString().slice(0, 10);

  let visits = 0, cancelled = 0, unknown = 0;
  for (const comp of yc.companies()) {
    const name = comp.name || comp.id;
    const cid = Number(comp.id) || null;
    const records = await yc.fetchRecords(comp.id, fmt(start), fmt(end));
    for (const r of records) {
      const v = normalizeRecord(r);
      if (!v.client_id) continue;                      // блокировка времени без клиента
      const local = getClientLocalId.get(v.client_id);
      if (!local) { unknown++; continue; }             // новый клиент — приедет полным синком
      upsertVisit.run(v.yclients_record_id, local.id, cid, name, v.date, v.service, v.staff, v.cost, v.status, v.booked_at);
      visits++;
    }
    cancelled += reconcileFuture(records, { id: comp.id, name }, iso(end));
  }
  // Только обслуживание: снять задачи по записавшимся и уже обзвоненным. Новые задачи
  // добирает утренний полный синк — иначе разобранный список тут же наполнялся бы снова.
  rules.generate({ fill: false });
  recomputeAutoBooked();
  console.log(`[upcoming] визитов ${visits}, отменено ${cancelled}, новых клиентов пропущено ${unknown}`);
  return { visits, cancelled, unknown, tasks: 0, at: iso(Date.now()) };
}

// Покупки БЕЗ визита (пришёл на кассу и купил шампунь или сертификат). В /records таких продаж
// нет вовсе, поэтому идём через /transactions: там товарная строка помечена sold_item_type
// 'goods_transaction' и несёт клиента, но НЕ несёт названия товара — его добираем из состава
// документа (/company/{id}/sale/{doc}), по одному запросу на документ.
// Транзакции с record_id пропускаем: эти товары уже приехали вместе с записью.
async function syncStandalonePurchases(company, startDate, endDate, now) {
  const cid = Number(company.id) || null;
  const tx = await yc.fetchTransactions(company.id, startDate, endDate,
    (n) => { if (n % 2000 === 0) console.log(`[goods] ${company.name}: транзакций ${n}`); });
  const standalone = tx.filter(t => t.sold_item_type === 'goods_transaction'
    && !t.record_id && t.client && t.client.id);
  // документы, разобранные прошлым синком, повторно не дёргаем — иначе каждый ночной проход
  // по 7 годам заново тянул бы тысячи документов
  const known = new Set(db.prepare('SELECT yc_id FROM purchases').all().map(r => Number(r.yc_id)));
  const byDoc = new Map();
  for (const t of standalone) {
    if (known.has(Number(t.sold_item_id))) continue;
    if (!byDoc.has(t.document_id)) byDoc.set(t.document_id, []);
    byDoc.get(t.document_id).push(t);
  }
  let saved = 0, skipped = 0;
  for (const [docId, items] of byDoc) {
    let doc = null;
    try { doc = await yc.fetchSaleDocument(company.id, docId); }
    catch { skipped += items.length; continue; }  // документ удалён или недоступен
    const state = (doc && doc.state && doc.state.items) || [];
    for (const t of items) {
      const local = getClientLocalId.get(t.client.id);
      if (!local) { skipped++; continue; }         // клиента ещё нет в базе — подхватит следующий синк
      const item = state.find(i => Number(i.id) === Number(t.sold_item_id)) || {};
      upsertPurchase.run(t.sold_item_id, local.id, cid, company.name, null, iso(t.date),
        item.title || 'Товар', item.good_id || null, Math.abs(Number(item.amount) || 1),
        Number(item.cost_to_pay_total ?? t.amount) || 0, Number(item.client_discount_percent) || 0,
        '', 'sale', now);
      saved++;
    }
    await new Promise(rs => setTimeout(rs, THROTTLE_MS));
  }
  return { transactions: tx.length, standalone: standalone.length, saved, skipped };
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
  svcCatCache = null; // прайс изменился — карта «услуга → категория» пересоберётся
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

// Персональные скидки в этом салоне админы пишут ТЕКСТОМ В ИМЕНИ клиента
// («Ия Устинова -15%», «Смирнова Елена-20%»), а штатное поле discount карточки
// YClients салон не заполняет вовсе (проверено на боевом: у всех «процентных»
// клиентов card.discount = 0).
// ИСТОЧНИК ТОЛЬКО ИМЯ (+ штатное поле, если его когда-нибудь начнут заполнять).
// Комментарий НЕ используем намеренно: туда админы пишут про разовые скидки на
// продажах («отдали шампунь -20%»), и такие клиенты ложно попадали в держатели
// постоянной скидки. Постоянная скидка = та, что приписана к имени.
// {1,2} намеренно: трёхзначные проценты это не скидка.
const DISCOUNT_RE = /(\d{1,2})\s*%/;
function parseDiscount(text) {
  const m = String(text || '').match(DISCOUNT_RE);
  const n = m ? Number(m[1]) : 0;
  return n > 0 && n <= 99 ? n : 0;
}
// Эффективная скидка клиента = max(поле карточки YClients, скидка из имени)
function effectiveDiscount(row) {
  return Math.max(Number(row.yc_discount) || 0, parseDiscount(row.name));
}
const THROTTLE_MS = 350;
let commentSync = { running: false, done: 0, total: 0 };

// Дата рождения из карточки YClients → 'YYYY-MM-DD'. Формат в поле birth_date плавает:
// у части клиентов «1985-04-17», у части «17.04.1985», иногда с временем. Приводим к одному
// виду, чтобы выборка именинников шла простым substr(birth_date,6,5) = 'MM-DD'.
// Пустая строка = «в YClients даты нет» (см. комментарий у колонки в db.js).
function normBirthDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);            // 1985-04-17[ 00:00:00]
  if (!m) {
    m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})/);            // 17.04.1985
    if (m) m = [m[0], m[3], m[2], m[1]];
  }
  if (!m) return '';
  const [, y, mo, d] = m;
  const Y = Number(y), M = Number(mo), D = Number(d);
  if (M < 1 || M > 12 || D < 1 || D > 31) return '';
  // В карточке YClients год НЕОБЯЗАТЕЛЕН: администратор может указать только день и
  // месяц, и в поле это выглядит как «13 октября». В API такая запись приезжает с
  // годом-заглушкой 1900. На боевой базе так заполнено больше половины всех дат,
  // поэтому выбрасывать их нельзя — храним как 0000-MM-DD.
  // Выборка именинников идёт по substr(birth_date, 6, 5), то есть по месяцу и дню,
  // и от года не зависит вовсе; ноль в годе означает «возраст неизвестен».
  if (Y === 1900) return `0000-${mo}-${d}`;
  if (Y < 1900 || Y > new Date().getFullYear()) return '';
  return `${y}-${mo}-${d}`;
}

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
  no_calls: 'просил не звонить', coming: 'придёт',
  written: 'написали после первого визита',
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
    SELECT id, yclients_id, company_id, name, dnc_manual FROM clients
    WHERE yclients_id IS NOT NULL AND company_id IS NOT NULL
    ${full ? '' : `AND (comment_checked_at IS NULL
                       OR birth_date IS NULL
                       OR (comment_checked_at < datetime('now','-3 days')
                           AND last_visit >= datetime('now','-120 days')))`}
  `).all();
  commentSync = { running: true, done: 0, total: rows.length };
  const upd = db.prepare(`UPDATE clients SET comment=?, do_not_call=?, yc_spent=?, yc_balance=?,
    yc_discount=?, discount_pct=?, birth_date=?, comment_checked_at=? WHERE id=?`);
  let dnc = 0;
  try {
    for (const r of rows) {
      try {
        const card = await yc.fetchClientCard(r.company_id, r.yclients_id);
        const comment = String(card?.comment || '').trim();
        const derived = (DNC_RE.test(originalComment(comment)) || DNC_RE.test(r.name || '')) ? 1 : 0;
        const flag = r.dnc_manual != null ? r.dnc_manual : derived; // ручная отметка из дашборда важнее
        const ycDisc = Number(card?.discount) || 0;
        // только карточка и имя — см. комментарий у effectiveDiscount()
        const pct = Math.max(ycDisc, parseDiscount(r.name));
        upd.run(comment || null, flag, card?.spent ?? null, card?.balance ?? null,
          ycDisc, pct || null, normBirthDate(card?.birth_date), iso(Date.now()), r.id);
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

// «Не беспокоить» и персональную скидку админы пишут прямо в имя клиента, а имя
// обновляется каждым синком — поэтому оба признака пересчитываем по всей базе.
// Идемпотентно и дёшево (одна выборка + точечные UPDATE только на изменившихся).
function recomputeFlags() {
  const rows = db.prepare(`SELECT id, name, comment, dnc_manual, yc_discount,
    COALESCE(do_not_call,0) AS f, COALESCE(discount_pct,0) AS d FROM clients`).all();
  const updFlag = db.prepare('UPDATE clients SET do_not_call=? WHERE id=?');
  const updDisc = db.prepare('UPDATE clients SET discount_pct=? WHERE id=?');
  let dnc = 0, disc = 0;
  for (const r of rows) {
    const derived = (DNC_RE.test(r.name || '') || DNC_RE.test(originalComment(r.comment))) ? 1 : 0;
    const flag = r.dnc_manual != null ? r.dnc_manual : derived; // ручная отметка из дашборда важнее
    if (flag !== r.f) { updFlag.run(flag, r.id); dnc++; }
    const pct = effectiveDiscount(r);
    if (pct !== r.d) { updDisc.run(pct || null, r.id); disc++; }
  }
  return { clients: rows.length, dnc_changed: dnc, discount_changed: disc };
}

async function run(opts = {}) {
  const now = iso(Date.now());
  let totalC = 0, totalV = 0, totalG = 0;

  if (yc.isDemo()) {
    const raw = yc.demoData();
    const res = syncBranch(raw.clients, raw.records, { id: 0, name: 'Демо' }, now);
    totalC += res.clients; totalV += res.visits; totalG += res.goods;
  } else {
    await yc.ensureAuth(); // если токена нет, но есть логин/пароль в .env — получим токен
    const months = Number(opts.months) || Number(process.env.YCLIENTS_SYNC_MONTHS) || 12;
    // Окно синка обязательно захватывает БУДУЩЕЕ: /records фильтрует по дате визита, и без
    // этого предстоящие записи к нам не попадали вовсе. А без них движок задач считал
    // записанных клиентов незаписанными и звал их записываться повторно.
    const futureDays = Number(opts.futureDays) || Number(process.env.YCLIENTS_SYNC_FUTURE_DAYS) || 180;
    // Явное окно {from, to} — для догрузки истории кусками. Все записи филиала синк держит
    // в памяти одним массивом, и 7 лет разом (83 тыс. записей Баскова) кладут процесс на
    // VPS с 2 ГБ. Год за раз — это максимум 18 тыс. записей, влезает с запасом.
    const explicit = Boolean(opts.from || opts.to);
    const end = opts.to ? new Date(opts.to) : new Date();
    if (!opts.to) end.setDate(end.getDate() + futureDays);
    const start = opts.from ? new Date(opts.from) : new Date();
    if (!opts.from) start.setMonth(start.getMonth() - months);
    const fmt = (d) => d.toISOString().slice(0, 10);
    if (explicit) console.log(`[sync] окно задано явно: ${fmt(start)} → ${fmt(end)}`);

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
      totalC += res.clients; totalV += res.visits; totalG += res.goods;
      const cancelled = reconcileFuture(records, { id: comp.id, name }, iso(end));
      // товарных строк обработано (одна продажа, привязанная к нескольким записям
      // параллельных мастеров, приходит несколько раз — в базе схлопнётся по yc_id)
      console.log(`[sync] ${name}: клиентов ${res.clients}, визитов ${res.visits}, товарных строк ${res.goods}`
        + (explicit ? ` (окно ${fmt(start)} → ${fmt(end)})` : ` (окно ${months} мес. назад + ${futureDays} дн. вперёд)`)
        + (cancelled ? `, отменено записей: ${cancelled}` : ''));
      records.length = 0; // отпускаем память до следующего филиала: на историческом окне это сотни МБ
      try {
        const svcN = await syncServices({ id: comp.id, name }, now);
        console.log(`[sync] ${name}: услуг в прайсе ${svcN}`);
      } catch (e) { console.error(`[sync] ${name}: прайс-лист не загружен:`, e.message); }
      // покупки без визита — отдельным проходом по кассовым транзакциям того же окна
      if (!opts.skipStandaloneGoods) {
        try {
          const g = await syncStandalonePurchases({ id: comp.id, name }, fmt(start), fmt(end), now);
          totalG += g.saved;
          console.log(`[sync] ${name}: покупок без визита ${g.saved}`
            + (g.skipped ? ` (пропущено ${g.skipped})` : '') + `, транзакций просмотрено ${g.transactions}`);
        } catch (e) { console.error(`[sync] ${name}: покупки без визита не загружены:`, e.message); }
      }
    }
  }

  // «Не беспокоить» ловим и в имени клиента: в этом салоне админы пишут заметки прямо в имя
  // («писать в WA», «не звонить» и т.п.). Имя обновляется каждым синком — пересчитываем флаг.
  recomputeFlags();

  // Категории визитов: при первом синке прайс приезжает уже ПОСЛЕ визитов, а вся
  // историческая догрузка легла в базу до появления колонки — доставляем здесь.
  const catN = backfillVisitCategories();
  if (catN) console.log(`[sync] категории услуг проставлены визитам: ${catN}`);

  // Кто из обзвонённых записался в оговорённое окно — пересчитываем после каждого синка:
  // запись всегда появляется позже разговора, в момент отметки звонка её ещё нет.
  const autoN = recomputeAutoBooked();
  console.log(`[sync] звонков с записью в ${ATTRIBUTION_DAYS} дн.: ${autoN}`);

  const tasksN = rules.generate();

  // Комментарии тянем фоном ПОСЛЕ ответа: первый проход долгий (~350 мс на клиента),
  // а «не беспокоить»-задачи, созданные до его завершения, снимутся внутри syncComments()
  if (!yc.isDemo() && !opts.skipComments) {
    setImmediate(() => syncComments().catch(e => console.error('[comments]', e.message)));
  }

  return { mode: yc.isDemo() ? 'demo' : 'live', clients: totalC, visits: totalV, goods: totalG, tasks: tasksN, at: now };
}

module.exports = {
  run, syncUpcoming, computeFrequency, toTrips, recomputeClient, rebuildAggregates, importRecord,
  recomputeAutoBooked, ATTRIBUTION_DAYS,
  syncStandalonePurchases, purchasesFromRecord, backfillVisitCategories,
  syncComments, commentSyncStatus, recomputeFlags, parseDiscount, writeCallToYclients,
  CRM_MARK, originalComment, DNC_RE,
};
