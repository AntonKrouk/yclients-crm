'use strict';

// Витрина Prive для клиентов: мастера по направлениям, их работы, цены, отзывы и оценки.
// ОТДЕЛЬНЫЙ процесс от CRM (свой порт, свой systemd-юнит): здесь только публичные
// маршруты, админских нет физически, поэтому ошибка в портале не открывает базу CRM.
// План и решения — docs/portal-mvp.md.
//
// Решение 04.10.2026: записи на сайте НЕТ и в YClients портал ничего не пишет.
// Клиент звонит в салон (телефоны — data/portal-salons.json). Мастеров и прайс портал
// только ЧИТАЕТ из YClients, чтобы цены не вести в двух местах.
// Правило: портал ничего не отдаёт о клиентах — ни имён, ни «есть ли вы в базе».

require('../src/env');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const yc = require('../src/yclients');
const { db, DATA_DIR } = require('../src/db');
const vitrina = require('../src/vitrina');
const people = require('../src/people');
const telegram = require('../src/telegram');
const demo = require('./demo');

const PORT = Number(process.env.PORTAL_PORT) || 3021;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SALONS_FILE = path.join(DATA_DIR, 'portal-salons.json');

const app = express();
app.set('trust proxy', 'loopback'); // за nginx: реальный IP клиента — из X-Forwarded-For
app.use(express.json({ limit: '20kb' }));

// Таблицы витрины (мастера, работы, отзывы) заводит src/vitrina.js — он общий с CRM.

// --- помощники ---------------------------------------------------------------

// Телефон, адрес и часы работы филиалов — data/portal-salons.json, правится без выката:
// {"387958": {"phone": "+7 (812) 000-00-00", "address": "…", "hours": "Ежедневно 10:00–22:00"}}
function salonInfo() {
  try { return JSON.parse(fs.readFileSync(SALONS_FILE, 'utf8')); } catch { return {}; }
}
function salons() {
  if (yc.isDemo()) return demo.SALONS;
  const info = salonInfo();
  return yc.companies().map(c => ({
    id: Number(c.id), name: c.name || c.id,
    phone: info[c.id]?.phone || '', address: info[c.id]?.address || '', hours: info[c.id]?.hours || '',
  }));
}
const salonById = (id) => salons().find(s => String(s.id) === String(id));
const ids = (v) => String(v || '').split(',').map(s => s.trim()).filter(s => /^\d+$/.test(s));

// Простой счётчик в памяти: без регистрации это главная защита от спама в отзывах.
const hits = new Map();
function recent(key, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  hits.set(key, arr);
  return arr;
}
const hit = (key) => recent(key, 86400e3).push(Date.now());

const fail = (res, code, error) => res.status(code).json({ error });
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
  console.error('[portal]', req.path, e.message);
  fail(res, 502, 'Не получилось загрузить данные. Попробуйте через минуту или позвоните в салон.');
});

// --- маршруты ----------------------------------------------------------------

app.get('/p/api/salons', (req, res) => res.json(salons()));

// Мастера = YClients + правки админов из CRM (скрытые не попадают), портфолио, оценка
// по нашим опубликованным отзывам — всё собирает src/vitrina.js.
app.get('/p/api/staff', wrap(async (req, res) => {
  const salon = salonById(req.query.salon);
  if (!salon) return fail(res, 400, 'Выберите салон');
  res.json(await vitrina.publicStaff(salon.id));
}));

app.get('/p/api/services', wrap(async (req, res) => {
  const salon = salonById(req.query.salon);
  if (!salon) return fail(res, 400, 'Выберите салон');
  res.json(await vitrina.ycServices(salon.id, ids(req.query.staff)[0] || ''));
}));

// --- отзывы ------------------------------------------------------------------

app.get('/p/api/reviews', (req, res) => {
  const salon = salonById(req.query.salon);
  const staff = ids(req.query.staff)[0];
  if (!salon || !staff) return fail(res, 400, 'Выберите мастера');
  const rows = db.prepare(`SELECT author, rating, text, substr(created_at, 1, 10) AS date FROM portal_reviews
    WHERE company_id = ? AND staff_id = ? AND status = 'published' ORDER BY created_at DESC LIMIT 30`)
    .all(salon.id, Number(staff));
  // в демо к настоящим (опубликованным из CRM) добавляем примерные
  res.json(yc.isDemo() ? rows.concat(demo.handle('GET', req.path, req.query)) : rows);
});

// Был ли у этого телефона завершённый визит к мастеру за последние полгода (только если
// телефон оставили — он в отзыве необязательный). Ответ клиенту
// от этого НЕ зависит (иначе по чужому номеру можно узнать, ходит ли человек в салон) —
// флаг видит только тот, кто проверяет отзыв.
const visitedStmt = db.prepare(`SELECT 1 FROM visits v JOIN clients c ON c.id = v.client_id
  WHERE c.company_id = ? AND v.staff = ? AND v.status = 'completed' AND v.date >= ?
    AND substr(replace(replace(replace(replace(replace(c.phone,' ',''),'-',''),'(',''),')',''),'+',''), -10) = ?
  LIMIT 1`);
const reviewStmt = db.prepare(`INSERT INTO portal_reviews(company_id, staff_id, staff_name, rating, text, author,
  phone10, verified, can_publish, ip, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
const STARS = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
// Telegram разбирает HTML — имя мастера из YClients экранируем на всякий случай
const h = (v) => String(v ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

app.post('/p/api/review', wrap(async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.json({ ok: true });
  const salon = salonById(b.salon);
  const staffId = ids(b.staff_id)[0];
  const rating = Number(b.rating);
  const text = String(b.text || '').replace(/[ \t]+/g, ' ').trim().slice(0, 1000);
  const author = String(b.author || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const digits = people.normPhone(b.phone);
  const phone10 = digits.length >= 10 ? digits.slice(-10) : '';

  if (!salon || !staffId) return fail(res, 400, 'Не выбран мастер');
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return fail(res, 400, 'Поставьте оценку от одной до пяти звёзд');
  if (author.length < 2) return fail(res, 400, 'Напишите, как подписать отзыв');
  if (digits && (!/^9/.test(phone10) || !people.isRealPhone(phone10))) {
    return fail(res, 400, 'Проверьте номер: нужен мобильный, +7 9XX XXX-XX-XX. Или оставьте поле пустым.');
  }
  if (!b.consent) return fail(res, 400, 'Нужно согласие на обработку персональных данных');

  const ip = req.ip || '';
  hit('rip:' + ip);
  if (recent('rip:' + ip, 3600e3).length > 5 || (phone10 && recent('rph:' + phone10, 86400e3).length >= 2)) {
    return fail(res, 429, 'Вы уже оставили отзыв сегодня. Спасибо!');
  }
  if (phone10) hit('rph:' + phone10);

  const staffName = (await vitrina.ycStaff(salon.id)).find(s => String(s.id) === String(staffId))?.name || '';
  const since = new Date(Date.now() - 183 * 86400e3).toISOString();
  const verified = staffName && phone10 ? Boolean(visitedStmt.get(salon.id, staffName, since, phone10)) : false;

  const info = reviewStmt.run(salon.id, Number(staffId), staffName, rating, text, author, phone10, verified ? 1 : 0,
    b.publish ? 1 : 0, ip, new Date().toISOString());

  // Админам — сразу. Низкая оценка — отдельным текстом: клиенту надо позвонить сегодня,
  // пока он не унёс недовольство на Яндекс Карты. Ни телефона, ни подписи, ни текста
  // в Telegram не шлём (иностранный сервис, а в тексте клиент может написать что угодно о себе):
  // всё это — в CRM, в разделе отзывов (следующий шаг), номер отзыва ниже.
  const head = rating <= 3
    ? `<b>⚠️ Низкая оценка ${STARS(rating)}</b> · ${salon.name}\n${phone10 ? 'Клиент оставил телефон — позвоните сегодня' : 'Телефон не оставлен'}`
    : `<b>Новый отзыв ${STARS(rating)}</b> · ${salon.name}, ${b.publish ? 'ждёт проверки' : 'только для салона, без публикации'}`;
  const visit = !phone10 ? '' : verified ? 'Визит к мастеру подтверждён\n' : 'Визит к мастеру по этому номеру не найден\n';
  telegram.notifyAdmins(`${head}\nМастер: ${h(staffName || staffId)}\n${visit}Отзыв №${info.lastInsertRowid}`)
    .catch(e => console.error('[portal/tg]', e.message));

  res.json({ ok: true, low: rating <= 3 });
}));

app.get('/p/api/health', (req, res) => res.json({ ok: true, demo: yc.isDemo() }));

app.use('/p/works', express.static(vitrina.WORKS_DIR, { maxAge: '7d', fallthrough: false }));
app.use(express.static(PUBLIC_DIR, { maxAge: '1h' }));

if (require.main === module) {
  // Только localhost: снаружи витрина доступна через nginx (HTTPS), а не голым портом 3021.
  app.listen(PORT, process.env.PORTAL_HOST || '127.0.0.1', () => {
    console.log(`[portal] http://localhost:${PORT} ${yc.isDemo() ? '(демо-данные)' : '(мастера и цены из YClients)'}`);
  });
}

module.exports = app;
