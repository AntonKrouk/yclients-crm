'use strict';

// Клиентский портал Prive: мастера, работы, услуги с ценами, онлайн-запись в YClients.
// ОТДЕЛЬНЫЙ процесс от CRM (свой порт, свой systemd-юнит): здесь только публичные
// маршруты, админских нет физически, поэтому ошибка в портале не открывает базу CRM.
// План и решения — docs/portal-mvp.md.
//
// Этап 0 — без регистрации: клиент оставляет имя и телефон прямо в форме записи.
// Правило, на котором всё держится: портал НИЧЕГО не отдаёт о клиенте. Ни имени из
// YClients, ни «есть ли вы в базе», ни прошлых визитов — только «запись создана».

require('../src/env');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const yc = require('../src/yclients');
const { db, DATA_DIR } = require('../src/db');
const people = require('../src/people');
const sync = require('../src/sync');
const telegram = require('../src/telegram');
const demo = require('./demo');

const PORT = Number(process.env.PORTAL_PORT) || 3021;
const PUBLIC_DIR = path.join(__dirname, 'public');
const WORKS_DIR = path.join(DATA_DIR, 'portfolio');
const MAX_FUTURE_PER_PHONE = 3;

const app = express();
app.set('trust proxy', 'loopback'); // за nginx: реальный IP клиента — из X-Forwarded-For
app.use(express.json({ limit: '20kb' }));

// Онлайн-записи портала: для лимитов и чтобы админ видел источник
db.exec(`
  CREATE TABLE IF NOT EXISTS portal_bookings (
    id          INTEGER PRIMARY KEY,
    company_id  INTEGER,
    record_id   INTEGER,
    phone10     TEXT,
    datetime    TEXT,
    ip          TEXT,
    created_at  TEXT
  );
  CREATE INDEX IF NOT EXISTS portal_bookings_phone ON portal_bookings(phone10, datetime);
`);

// --- помощники ---------------------------------------------------------------

const salons = () => (yc.isDemo() ? demo.SALONS : yc.companies().map(c => ({ id: Number(c.id), name: c.name || c.id })));
const salonById = (id) => salons().find(s => String(s.id) === String(id));
const ids = (v) => String(v || '').split(',').map(s => s.trim()).filter(s => /^\d+$/.test(s));

// Справочники мастеров и услуг меняются редко — держим 10 минут, чтобы не долбить YClients
// на каждое открытие страницы. Свободное время не кэшируем: оно должно быть живым.
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}

// Простой счётчик в памяти: без регистрации это главная защита от спама.
// С IP считаем все попытки, с номера — только состоявшиеся записи: если окно заняли и
// клиент выбрал другое время, это не должно съедать его лимит.
const hits = new Map();
function recent(key, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  hits.set(key, arr);
  return arr;
}
const hit = (key) => recent(key, 86400e3).push(Date.now());

// Портфолио на этапе 0 — папка на диске: data/portfolio/<филиал>/<id мастера>/*.jpg,
// подписи (по желанию) — captions.json вида {"1.jpg": "Нюд с укреплением"}.
// Загрузка из CRM — следующий шаг.
function worksOf(cid, staffId) {
  const dir = path.join(WORKS_DIR, String(cid), String(staffId));
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /\.(jpe?g|png|webp)$/i.test(f)).sort(); } catch { return []; }
  let captions = {};
  try { captions = JSON.parse(fs.readFileSync(path.join(dir, 'captions.json'), 'utf8')); } catch { /* без подписей */ }
  return files.map(f => ({ src: `/p/works/${cid}/${staffId}/${encodeURIComponent(f)}`, caption: captions[f] || '' }));
}

const fail = (res, code, error) => res.status(code).json({ error });
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
  console.error('[portal]', req.path, e.message);
  fail(res, 502, 'Сервис записи временно недоступен. Попробуйте через минуту или позвоните в салон.');
});

// --- маршруты ----------------------------------------------------------------

app.get('/p/api/salons', (req, res) => res.json(salons()));

app.get('/p/api/staff', wrap(async (req, res) => {
  const salon = salonById(req.query.salon);
  if (!salon) return fail(res, 400, 'Выберите салон');
  if (yc.isDemo()) return res.json(demo.handle('GET', req.path, req.query));
  const svc = ids(req.query.services);
  const list = await cached(`staff:${salon.id}:${svc}`, 600e3, () => yc.fetchBookStaff(salon.id, svc));
  res.json((Array.isArray(list) ? list : [])
    .filter(s => s.bookable && !s.fired && !s.hidden)
    .map(s => ({
      id: s.id, name: s.name, specialization: s.specialization || '',
      // должность из YClients — по ней страница раскладывает мастеров по направлениям
      position: s.position?.title || '',
      avatar: s.avatar_big || s.avatar || '',
      rating: Number(s.rating) || null, reviews: Number(s.comments_count || s.votes_count) || 0,
      works: worksOf(salon.id, s.id),
    })));
}));

app.get('/p/api/services', wrap(async (req, res) => {
  const salon = salonById(req.query.salon);
  if (!salon) return fail(res, 400, 'Выберите салон');
  if (yc.isDemo()) return res.json(demo.handle('GET', req.path, req.query));
  const staff = ids(req.query.staff)[0] || '';
  const data = await cached(`svc:${salon.id}:${staff}`, 600e3, () => yc.fetchBookServices(salon.id, staff));
  const cats = {};
  for (const c of (data?.category || [])) cats[c.id] = c.title || '';
  res.json((data?.services || []).map(s => ({
    id: s.id, title: s.title, category: cats[s.category_id] || 'Услуги',
    price_min: s.price_min || 0, price_max: s.price_max || 0,
    duration: Math.round((s.seance_length || 0) / 60),
  })));
}));

app.get('/p/api/dates', wrap(async (req, res) => {
  const salon = salonById(req.query.salon);
  const staff = ids(req.query.staff)[0];
  if (!salon || !staff) return fail(res, 400, 'Выберите мастера');
  if (yc.isDemo()) return res.json(demo.handle('GET', req.path, req.query));
  const d = await yc.fetchBookDates(salon.id, staff, ids(req.query.services));
  res.json({ dates: d?.booking_dates || [] });
}));

app.get('/p/api/times', wrap(async (req, res) => {
  const salon = salonById(req.query.salon);
  const staff = ids(req.query.staff)[0];
  const date = String(req.query.date || '');
  if (!salon || !staff || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(res, 400, 'Выберите мастера и дату');
  if (yc.isDemo()) return res.json(demo.handle('GET', req.path, req.query));
  const list = await yc.fetchBookTimes(salon.id, staff, date, ids(req.query.services));
  res.json((Array.isArray(list) ? list : []).map(t => ({ time: t.time, datetime: t.datetime })));
}));

// Карточка клиента в этом салоне по телефону — только для передачи id в YClients.
// Наружу из неё не уходит ничего.
const cardStmt = db.prepare(`SELECT yclients_id, name FROM clients
  WHERE company_id = ? AND yclients_id IS NOT NULL
    AND substr(replace(replace(replace(replace(replace(phone,' ',''),'-',''),'(',''),')',''),'+',''), -10) = ?
  ORDER BY visits_count DESC LIMIT 1`);
const futureStmt = db.prepare(`SELECT COUNT(*) n FROM portal_bookings WHERE phone10 = ? AND datetime > ?`);
const logStmt = db.prepare(`INSERT INTO portal_bookings(company_id, record_id, phone10, datetime, ip, created_at)
  VALUES(?,?,?,?,?,?)`);

app.post('/p/api/book', wrap(async (req, res) => {
  const b = req.body || {};
  // Ловушка для ботов: невидимое поле, человек его не заполняет
  if (b.website) return res.json({ ok: true });

  const salon = salonById(b.salon);
  const staffId = ids(b.staff_id)[0];
  const serviceIds = (Array.isArray(b.service_ids) ? b.service_ids : []).map(String).filter(s => /^\d+$/.test(s)).slice(0, 5);
  const name = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const digits = people.normPhone(b.phone);
  const phone = digits.length === 11 && /^[78]/.test(digits) ? '7' + digits.slice(1) : (digits.length === 10 ? '7' + digits : '');
  const comment = String(b.comment || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const datetime = String(b.datetime || '');

  if (!salon || !staffId || !serviceIds.length || !datetime) return fail(res, 400, 'Выберите мастера, услугу и время');
  if (name.length < 2) return fail(res, 400, 'Напишите, как к вам обращаться');
  if (!phone || !/^79/.test(phone) || !people.isRealPhone(phone)) return fail(res, 400, 'Проверьте номер: нужен мобильный, +7 9XX XXX-XX-XX');
  if (!b.consent) return fail(res, 400, 'Нужно согласие на обработку персональных данных');
  const when = new Date(datetime);
  if (!(when > new Date())) return fail(res, 400, 'Это время уже прошло, выберите другое');

  const phone10 = phone.slice(-10);
  const ip = req.ip || '';
  hit('ip:' + ip);
  if (recent('ip:' + ip, 3600e3).length > 10 || recent('ph:' + phone10, 86400e3).length >= 3) {
    return fail(res, 429, 'Слишком много записей подряд. Позвоните, пожалуйста, в салон.');
  }
  if (futureStmt.get(phone10, new Date().toISOString()).n >= MAX_FUTURE_PER_PHONE) {
    return fail(res, 429, `Онлайн можно держать до ${MAX_FUTURE_PER_PHONE} будущих записей. Позвоните в салон, и администратор поможет.`);
  }

  if (yc.isDemo()) { hit('ph:' + phone10); return res.json(demo.handle('POST', '/p/api/book', {}, b)); }

  // Имя: если человек уже есть в этом салоне — передаём его id и ТЕКУЩЕЕ имя из YClients,
  // чтобы запись не переписала карточку. Новому клиенту YClients заведёт карточку с тем
  // именем, которое он ввёл сам.
  const card = cardStmt.get(salon.id, phone10);
  let rec;
  try {
    const r = await yc.createRecord(salon.id, {
      staff_id: Number(staffId),
      services: serviceIds.map(id => ({ id: Number(id) })),
      client: card ? { id: card.yclients_id, phone, name: card.name || name } : { phone, name },
      datetime,
      save_if_busy: false,
      send_sms: false,
      comment: ['Онлайн-запись (сайт)', card ? `Клиент представился: ${name}` : '', comment && `Комментарий: ${comment}`]
        .filter(Boolean).join('. '),
      api_id: '',
    });
    rec = Array.isArray(r) ? r[0] : r;
    if (!rec?.id) throw new Error('YClients не вернул номер записи');
  } catch (e) {
    console.error('[portal/book]', e.message);
    // Чаще всего окно заняли, пока клиент заполнял форму
    return fail(res, 409, 'Не получилось записать на это время: его могли только что занять. Выберите другое или позвоните в салон.');
  }

  hit('ph:' + phone10);
  logStmt.run(salon.id, rec.id, phone10, when.toISOString(), ip, new Date().toISOString());
  cache.clear();

  // Подтянуть запись в CRM сразу, не дожидаясь синка, и сообщить админам
  setImmediate(async () => {
    try { await sync.importRecord(salon.id, salon.name, rec.id); } catch (e) { console.error('[portal/import]', e.message); }
    const svc = (rec.services || []).map(s => s.title).filter(Boolean).join(', ');
    const at = when.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
    telegram.notifyAdmins(`<b>Онлайн-запись</b> · ${salon.name}\n${at}, ${svc}${rec.staff?.name ? ' — ' + rec.staff.name : ''}\n` +
      `${card ? 'Клиент есть в базе' : 'Новый клиент'}, тел. +${phone}`).catch(e => console.error('[portal/tg]', e.message));
  });

  res.json({
    ok: true, salon: salon.name, staff: rec.staff?.name || '',
    services: (rec.services || []).map(s => s.title).filter(Boolean).join(', '),
    datetime: rec.datetime || datetime,
  });
}));

app.get('/p/api/health', (req, res) => res.json({ ok: true, demo: yc.isDemo() }));

app.use('/p/works', express.static(WORKS_DIR, { maxAge: '7d', fallthrough: false }));
app.use(express.static(PUBLIC_DIR, { maxAge: '1h' }));

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[portal] http://localhost:${PORT} ${yc.isDemo() ? '(демо-данные)' : '(YClients LIVE)'}`);
  });
}

module.exports = app;
