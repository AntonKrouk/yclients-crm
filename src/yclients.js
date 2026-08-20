'use strict';

// Клиент YClients API v1/v2.
// Документация: https://developers.yclients.com/ru/
// Токены читаются ДИНАМИЧЕСКИ из process.env, чтобы вход через /auth активировал
// боевой режим без перезапуска сервера. Пока нет всех трёх параметров — ДЕМО-режим.

const fs = require('node:fs');
const path = require('node:path');

const BASE = 'https://api.yclients.com/api/v1';
const ENV_FILE = path.join(__dirname, '..', '.env');

const partnerToken = () => process.env.YCLIENTS_PARTNER_TOKEN || '';
const userToken = () => process.env.YCLIENTS_USER_TOKEN || '';
const loginCred = () => process.env.YCLIENTS_LOGIN || '';
const passwordCred = () => process.env.YCLIENTS_PASSWORD || '';

// Запасные короткие названия филиалов по company_id (чтобы в .env можно было указать
// только цифры, без кириллицы). Приоритет: имя из конфига > этот справочник > title из API > id.
const KNOWN_NAMES = { '387958': 'Басков', '898298': 'Мытнинская' };

// Мультифилиальность: YCLIENTS_COMPANY_ID может содержать несколько филиалов через запятую,
// каждый в виде `id` или `id:Название` (напр. "387958:Басков,898298:Мытнинская" или просто "387958,898298").
function companies() {
  return (process.env.YCLIENTS_COMPANY_ID || '')
    .split(',').map(s => s.trim()).filter(Boolean)
    .map(entry => {
      const idx = entry.indexOf(':');
      const id = (idx === -1 ? entry : entry.slice(0, idx)).trim();
      const name = (idx === -1 ? '' : entry.slice(idx + 1).trim()) || KNOWN_NAMES[id] || '';
      return { id, name };
    });
}
const companyId = () => companies()[0]?.id || '';

// Боевой режим возможен, если есть партнёрский токен, хотя бы один филиал и ЛИБО готовый
// user_token, ЛИБО логин+пароль в .env (тогда токен получим сами при старте).
const isDemo = () => !(partnerToken() && companyId() && (userToken() || (loginCred() && passwordCred())));

function headers() {
  const auth = userToken()
    ? `Bearer ${partnerToken()}, User ${userToken()}`
    : `Bearer ${partnerToken()}`;
  return {
    'Accept': 'application/vnd.yclients.v2+json',
    'Content-Type': 'application/json',
    'Authorization': auth,
  };
}

async function api(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok || (json && json.success === false)) {
    const msg = json?.meta?.message || text.slice(0, 300);
    throw new Error(`YClients ${method} ${pathname} → ${res.status}: ${msg}`);
  }
  return json && json.data !== undefined ? json.data : json;
}

// --- Авторизация: логин+пароль → user_token ---------------------------------

function persistEnv(key, value) {
  let text = '';
  try { text = fs.readFileSync(ENV_FILE, 'utf8'); } catch { /* создадим */ }
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(text)) text = text.replace(re, line);
  else text += (text.endsWith('\n') || text === '' ? '' : '\n') + line + '\n';
  try { fs.writeFileSync(ENV_FILE, text); } catch (e) { console.error('[env] не удалось записать .env:', e.message); }
}

// Обмен логина/пароля администратора YClients на user_token. Пароль НЕ сохраняется.
async function authenticate(login, password) {
  const res = await fetch(BASE + '/auth', {
    method: 'POST',
    headers: {
      'Accept': 'application/vnd.yclients.v2+json',
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${partnerToken()}`,
    },
    body: JSON.stringify({ login, password }),
  });
  const json = await res.json().catch(() => null);
  const token = json?.data?.user_token;
  if (!json?.success || !token) {
    throw new Error(json?.meta?.message || `Авторизация не удалась (HTTP ${res.status})`);
  }
  process.env.YCLIENTS_USER_TOKEN = token;
  persistEnv('YCLIENTS_USER_TOKEN', token);
  return { user_token: token, name: json.data.name, id: json.data.id };
}

// Автовход: если user_token ещё нет, но в .env есть логин/пароль — получаем токен сами.
// Вызывается при старте сервера и перед синхронизацией.
async function ensureAuth() {
  if (userToken()) return { ok: true, source: 'token' };
  if (partnerToken() && companyId() && loginCred() && passwordCred()) {
    const auth = await authenticate(loginCred(), passwordCred());
    console.log('[yclients] автовход выполнен для', auth.name || loginCred());
    return { ok: true, source: 'login' };
  }
  return { ok: false };
}

// --- Реальные вызовы данных ---------------------------------------------------

// Список филиалов, доступных пользователю (id + название) — для подстановки имён.
async function fetchMyCompanies() {
  const data = await api('/companies?my=1');
  const arr = Array.isArray(data) ? data : [data];
  return arr.map(c => ({ id: String(c.id), title: c.title || c.name || String(c.id) }));
}

async function fetchStaff(cid = companyId()) {
  return api(`/company/${cid}/staff/`);
}

// Пользователи филиала с ролями доступа (user_role_slug: administrator/manager/worker/owner/accountant).
// Это НАСТОЯЩИЙ список тех, кто работает в YClients — в отличие от staff, где админы заведены
// как «сотрудники» и часто скрыты/уволены.
async function fetchUsers(cid = companyId()) {
  return api(`/company/${cid}/users/`);
}

// Прайс-лист услуг филиала: title, price_min/max, category_id, active
async function fetchServices(cid = companyId()) {
  return api(`/company/${cid}/services/`);
}

// Категории услуг филиала (id → title), чтобы показывать раздел прайса
async function fetchServiceCategories(cid = companyId()) {
  return api(`/company/${cid}/service_categories/`);
}

async function fetchClients() {
  const all = [];
  let page = 1;
  const pageSize = 200;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const data = await api(`/company/${companyId()}/clients/search`, {
      method: 'POST',
      body: { page, page_size: pageSize, fields: ['id', 'name', 'phone', 'visits_count', 'last_visit_date', 'first_visit_date', 'spent'] },
    });
    const rows = Array.isArray(data) ? data : (data.data || []);
    all.push(...rows);
    if (rows.length < pageSize) break;
    page += 1;
    if (page > 100) break;
  }
  return all;
}

// Полная карточка клиента — ЕДИНСТВЕННОЕ место, где YClients отдаёт поле comment
// (bulk /clients/search и вложенный client в /records комментарий не возвращают — проверено).
async function fetchClientCard(cid, clientYcId) {
  return api(`/client/${cid}/${clientYcId}`);
}

// Обновить карточку клиента. Эхо-echoим значимые поля, чтобы PUT ничего не затёр,
// меняем только то, что передано в patch (сейчас — comment). Права проверены (PUT → 200).
async function updateClient(cid, clientYcId, patch = {}) {
  const card = await fetchClientCard(cid, clientYcId);
  if (!card) throw new Error('карточка клиента не найдена');
  const body = {
    name: card.name || '', surname: card.surname || '', patronymic: card.patronymic || '',
    phone: card.phone || '', email: card.email || '', card: card.card || '',
    birth_date: card.birth_date || '', comment: card.comment || '',
    sex_id: card.sex_id || 0, importance_id: card.importance_id || 0, discount: card.discount || 0,
    ...patch,
  };
  return api(`/client/${cid}/${clientYcId}`, { method: 'PUT', body });
}

// Записи (визиты) конкретного филиала за период с пагинацией по meta.total_count.
// В каждой записи YClients уже вложен объект client — отдельные запросы по клиентам не нужны.
async function fetchRecords(cid, startDate, endDate, onProgress) {
  const all = [];
  const pageSize = 200;
  let page = 1;
  let total = Infinity;
  // eslint-disable-next-line no-constant-condition
  while (all.length < total) {
    const res = await fetch(BASE + `/records/${cid}?start_date=${startDate}&end_date=${endDate}&count=${pageSize}&page=${page}`, { headers: headers() });
    const json = await res.json().catch(() => null);
    if (!res.ok || json?.success === false) {
      throw new Error(`YClients /records → ${res.status}: ${json?.meta?.message || ''}`);
    }
    const rows = Array.isArray(json.data) ? json.data : [];
    all.push(...rows);
    total = json.meta?.total_count ?? all.length;
    if (onProgress) onProgress(all.length, total);
    if (rows.length < pageSize) break;
    page += 1;
    if (page > 500) break; // предохранитель
  }
  return all;
}

// Финансовые транзакции филиала за период. Нужны ради покупок товаров БЕЗ записи
// (зашёл и купил на кассе): в /records такой продажи нет вовсе. Товарная транзакция —
// sold_item_type: 'goods_transaction'; названия товара в ней НЕТ, только document_id,
// состав документа добирается через fetchSaleDocument().
// Проверено на боевом: start_date/end_date работают (date_from/date_to игнорируются),
// meta пустая — total_count не приходит, поэтому идём страницами до неполной.
async function fetchTransactions(cid, startDate, endDate, onProgress) {
  const all = [];
  const pageSize = 200;
  let page = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await fetch(BASE + `/transactions/${cid}?start_date=${startDate}&end_date=${endDate}&count=${pageSize}&page=${page}`, { headers: headers() });
    const json = await res.json().catch(() => null);
    if (!res.ok || json?.success === false) {
      throw new Error(`YClients /transactions → ${res.status}: ${json?.meta?.message || ''}`);
    }
    const rows = Array.isArray(json.data) ? json.data : [];
    all.push(...rows);
    if (onProgress) onProgress(all.length);
    if (rows.length < pageSize) break;
    page += 1;
    if (page > 2000) break; // предохранитель: 7 лет истории — это сотни страниц
  }
  return all;
}

// Состав документа продажи: state.items[] с title/good_id/amount/cost_to_pay_total.
// Единственный способ узнать, ЧТО именно купили в продаже без записи.
async function fetchSaleDocument(cid, documentId) {
  return api(`/company/${cid}/sale/${documentId}`);
}

// --- Онлайн-запись: справочники, свободные слоты, создание записи -------------
// Цепочка (проверено на боевом): book_staff → book_services?staff_id → book_dates → book_times.
// Эти эндпоинты отдают ровно то, что видит виджет онлайн-записи: только реально свободное время
// с учётом графика мастера, длительности услуги и уже существующих записей.

const qsServices = (ids = []) => (ids || []).map(id => `service_ids[]=${encodeURIComponent(id)}`).join('&');

// Мастера, доступные для записи (bookable=true — можно записывать)
async function fetchBookStaff(cid) {
  return api(`/book_staff/${cid}`);
}

// Услуги, доступные к записи (если задан staff_id — только те, что делает этот мастер).
// Возвращает { services: [...], category: [...] }
async function fetchBookServices(cid, staffId) {
  return api(`/book_services/${cid}${staffId ? `?staff_id=${staffId}` : ''}`);
}

// Дни, в которые мастер работает и есть свободные окна
async function fetchBookDates(cid, staffId, serviceIds = []) {
  const q = [staffId ? `staff_id=${staffId}` : '', qsServices(serviceIds)].filter(Boolean).join('&');
  return api(`/book_dates/${cid}${q ? '?' + q : ''}`);
}

// Свободные слоты мастера на дату (с учётом длительности выбранных услуг)
async function fetchBookTimes(cid, staffId, date, serviceIds = []) {
  const q = qsServices(serviceIds);
  return api(`/book_times/${cid}/${staffId}/${date}${q ? '?' + q : ''}`);
}

// Создать запись в журнале филиала (админский эндпоинт — от лица салона, без кода подтверждения).
// services: [{id, cost?, seance_length?}], client: {id?, phone, name, email?}
async function createRecord(cid, payload) {
  return api(`/records/${cid}`, { method: 'POST', body: payload });
}

async function fetchRecord(cid, recordId) {
  return api(`/record/${cid}/${recordId}`);
}

async function deleteRecord(cid, recordId) {
  return api(`/record/${cid}/${recordId}`, { method: 'DELETE' });
}

// --- Демо-данные -------------------------------------------------------------

const DEMO_STAFF = ['Мария', 'Ольга', 'Игорь', 'Светлана'];
const DEMO_SERVICES = [
  { name: 'Мужская стрижка', cost: 2500, interval: 28 },
  { name: 'Стрижка бороды', cost: 1500, interval: 21 },
  { name: 'Окрашивание', cost: 4500, interval: 45 },
  { name: 'Женская стрижка', cost: 3500, interval: 40 },
  { name: 'Маникюр', cost: 2200, interval: 18 },
];
const DEMO_NAMES = ['Александр Петров', 'Елена Смирнова', 'Дмитрий Иванов', 'Ольга Кузнецова', 'Максим Соколов', 'Анна Попова', 'Сергей Волков', 'Мария Лебедева', 'Андрей Козлов', 'Наталья Новикова', 'Павел Морозов', 'Ирина Фёдорова', 'Роман Орлов', 'Татьяна Макарова', 'Виктор Зайцев', 'Юлия Никитина', 'Егор Соловьёв', 'Ксения Васильева', 'Никита Крылов', 'Дарья Богданова', 'Артём Гусев', 'Полина Титова', 'Денис Комаров', 'Вероника Осипова', 'Кирилл Марков'];

function daysAgo(n) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}

// Дни рождения демо-клиентов. Первые трое — «сегодня», ещё несколько на этой неделе,
// остальные размазаны по году: иначе вкладку «ДР» в демо-режиме нечем было бы проверить.
function demoBirthDate(i) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  if (i < 3) { /* сегодня */ }
  else if (i < 7) d.setDate(d.getDate() + (i - 2));
  else d.setDate(d.getDate() + (i * 13) % 360);
  const year = 1966 + (i * 7) % 34;
  return `${year}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function demoData() {
  const clients = [];
  const records = [];
  let recId = 1;

  DEMO_NAMES.forEach((name, i) => {
    const svc = DEMO_SERVICES[i % DEMO_SERVICES.length];
    const staff = DEMO_STAFF[i % DEMO_STAFF.length];
    const clientId = 1000 + i;
    const phone = '+7 9' + String(100000000 + i * 137).slice(0, 9);
    const visitsCount = 2 + (i % 6);
    const interval = svc.interval + (i % 7) - 3;
    const lastOffset = [interval + 12, interval - 2, interval * 2 + 5, interval + 40, 5, interval + 3][i % 6];

    let cursor = lastOffset + interval * (visitsCount - 1);
    for (let v = 0; v < visitsCount; v++) {
      const date = daysAgo(cursor);
      records.push({
        id: recId++,
        client_id: clientId,
        datetime: date.toISOString(),
        services: [{ title: svc.name, cost: svc.cost }],
        staff: { name: staff },
        attendance: 1,
      });
      cursor -= interval;
    }

    if (i % 5 === 0) {
      const future = daysAgo(-(1 + (i % 2)));
      records.push({
        id: recId++,
        client_id: clientId,
        datetime: future.toISOString(),
        services: [{ title: svc.name, cost: svc.cost }],
        staff: { name: staff },
        attendance: 0,
      });
    }
    if (i === 7) {
      records.push({
        id: recId++,
        client_id: clientId,
        datetime: daysAgo(4).toISOString(),
        services: [{ title: svc.name, cost: svc.cost }],
        staff: { name: staff },
        attendance: -1,
      });
    }

    clients.push({ id: clientId, name, phone, birth_date: demoBirthDate(i) });
  });

  return { clients, records };
}

module.exports = {
  isDemo,
  companyId,
  companies,
  authenticate,
  ensureAuth,
  fetchMyCompanies,
  fetchStaff,
  fetchUsers,
  fetchServices,
  fetchServiceCategories,
  fetchClients,
  fetchClientCard,
  updateClient,
  fetchRecords,
  fetchTransactions,
  fetchSaleDocument,
  fetchBookStaff,
  fetchBookServices,
  fetchBookDates,
  fetchBookTimes,
  createRecord,
  fetchRecord,
  deleteRecord,
  demoData,
};
