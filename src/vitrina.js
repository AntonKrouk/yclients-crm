'use strict';

// Витрина для клиентов (portal/) и её настройка из CRM (вкладка «Витрина»).
//
// Откуда что берётся:
//   • мастера, их услуги, категории и цены — из YClients, тем же запросом, что и виджет
//     онлайн-записи (book_staff / book_services, проверено на боевом). В YClients ничего
//     не пишем;
//   • поверх — правки админов в portal_staff: скрыть мастера, поправить имя, специализацию,
//     направление, текст «о мастере», порядок, своё фото. Пустое поле = как в YClients;
//   • портфолио — portal_works + файлы в DATA_DIR/portfolio/<филиал>/<мастер>/;
//   • отзывы — portal_reviews (их пишет витрина, проверяют админы в CRM).
// Один модуль на два процесса: CRM и витрина работают с одной базой и одной папкой фото.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, DATA_DIR } = require('./db');
const yc = require('./yclients');

const WORKS_DIR = path.join(DATA_DIR, 'portfolio');

db.exec(`
  CREATE TABLE IF NOT EXISTS portal_staff (
    company_id     INTEGER NOT NULL,
    staff_id       INTEGER NOT NULL,
    visible        INTEGER DEFAULT 1,
    name           TEXT,          -- NULL/'' = имя из YClients
    specialization TEXT,
    direction      TEXT,          -- NULL/'' = определить по должности и специализации
    bio            TEXT,
    photo          TEXT,          -- файл в папке мастера; NULL = аватар из YClients
    sort           INTEGER,
    updated_at     TEXT,
    PRIMARY KEY (company_id, staff_id)
  );

  CREATE TABLE IF NOT EXISTS portal_works (
    id          INTEGER PRIMARY KEY,
    company_id  INTEGER NOT NULL,
    staff_id    INTEGER NOT NULL,
    file        TEXT NOT NULL,
    caption     TEXT,
    sort        INTEGER DEFAULT 0,
    created_at  TEXT
  );
  CREATE INDEX IF NOT EXISTS portal_works_staff ON portal_works(company_id, staff_id, sort);

  -- Отзывы клиентов о мастерах. На витрине — только status='published'.
  CREATE TABLE IF NOT EXISTS portal_reviews (
    id          INTEGER PRIMARY KEY,
    company_id  INTEGER,
    staff_id    INTEGER,
    staff_name  TEXT,
    rating      INTEGER,
    text        TEXT,
    author      TEXT,
    phone10     TEXT,
    verified    INTEGER DEFAULT 0,        -- по телефону нашёлся визит к мастеру (если телефон оставили)
    status      TEXT DEFAULT 'pending',   -- pending | published | hidden
    can_publish INTEGER DEFAULT 0,        -- клиент отдельно разрешил публикацию (ст. 10.1 152-ФЗ)
    ip          TEXT,
    created_at  TEXT
  );
  CREATE INDEX IF NOT EXISTS portal_reviews_staff ON portal_reviews(company_id, staff_id, status);
`);
// Редакция документов о ПДн, с которой согласился автор отзыва (portal/legal.js, LEGAL_VERSION)
if (!db.prepare('PRAGMA table_info(portal_reviews)').all().some(c => c.name === 'consent_ver')) {
  db.exec('ALTER TABLE portal_reviews ADD COLUMN consent_ver TEXT');
}

// Направления витрины. Порядок = порядок проверки и показа: «Косметолог, массаж лица»
// должен попасть в косметологию, поэтому она выше массажа. Тот же список — в portal.js.
const DIRECTIONS = [
  ['Волосы', /стилист|парикмахер|колорист|барбер|волос|hair/i],
  ['Ногтевой сервис', /маникюр|педикюр|ногт|nail/i],
  ['Брови и ресницы', /бров|ресниц|лэш|lash/i],
  ['Косметология', /космет|эстетист|дерматолог/i],
  ['Массаж', /массаж|spa|спа-/i],
  ['Макияж', /визаж|макияж|make-?up/i],
];
const autoDirection = (position, specialization) =>
  (DIRECTIONS.find(([, re]) => re.test(`${position || ''} ${specialization || ''}`)) || [''])[0];

// --- данные YClients ------------------------------------------------------------

// Мастера и прайс меняются редко — 10 минут кэша, чтобы не долбить YClients на каждое
// открытие витрины. Без токенов (локально) — демо-набор витрины.
const cache = new Map();
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < 600e3) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}
const demo = () => require('../portal/demo');

async function ycStaff(cid) {
  if (yc.isDemo()) {
    return demo().handle('GET', '/p/api/staff', { salon: cid }).map(s => ({ ...s, works: undefined }));
  }
  const list = await cached(`staff:${cid}`, () => yc.fetchBookStaff(cid));
  return (Array.isArray(list) ? list : [])
    .filter(s => s.bookable && !s.fired && !s.hidden)
    .map(s => ({
      id: s.id, name: s.name || '', specialization: s.specialization || '',
      position: s.position?.title || '', avatar: s.avatar_big || s.avatar || '',
      // описание сотрудника в YClients приходит HTML-ом — на витрину только текст
      bio: String(s.information || '').replace(/<br\s*\/?>|<\/p>/gi, '\n').replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim(),
    }));
}

async function ycServices(cid, staffId) {
  if (yc.isDemo()) return demo().handle('GET', '/p/api/services', { salon: cid, staff: staffId || '' });
  const data = await cached(`svc:${cid}:${staffId || ''}`, () => yc.fetchBookServices(cid, staffId || ''));
  const cats = {};
  for (const c of (data?.category || [])) cats[c.id] = c.title || '';
  return (data?.services || []).map(s => ({
    id: s.id, title: s.title, category: cats[s.category_id] || 'Услуги',
    price_min: s.price_min || 0, price_max: s.price_max || 0,
    duration: Math.round((s.seance_length || 0) / 60),
  }));
}

// --- один человек в нескольких филиалах -------------------------------------------
//
// В YClients у каждого филиала свой список сотрудников: Коновалова на Баскове и на
// Мытнинской — две карточки с разными id. Для клиента это один мастер, поэтому профиль
// (имя, специализация, направление, «о мастере», фото), портфолио и отзывы у таких
// карточек ОБЩИЕ. «Показывать» и порядок — у каждого филиала свои (мастер может почти не
// работать на второй точке). Склеиваем по имени из YClients: регистр, «ё», лишние пробелы
// и порядок слов не важны. Два сотрудника с одним именем в одном филиале — не склеиваем.
// Пишем на «главную» карточку — первую по порядку филиалов в YCLIENTS_COMPANY_ID; читаем
// с главной, а если там пусто — с остальных, чтобы загруженное раньше на вторую карточку
// не потерялось.

const clean = (v) => (v == null ? '' : String(v).trim());

function branchList() {
  if (yc.isDemo()) return demo().SALONS.map(s => ({ id: Number(s.id), name: s.name }));
  return yc.companies().map(c => ({ id: Number(c.id), name: c.name || String(c.id) }));
}
const personKey = (name) => clean(name).toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean).sort().join(' ');

// `${cid}:${sid}` -> все карточки этого человека [{cid, sid}], главная первой
async function personMap() {
  const branches = branchList();
  const lists = await Promise.all(branches.map(b => ycStaff(b.id).catch(() => [])));
  const groups = new Map();
  const dupes = new Set();
  branches.forEach((b, i) => {
    const seen = new Set();
    for (const s of lists[i]) {
      const k = personKey(s.name);
      if (!k) continue;
      if (seen.has(k)) { dupes.add(k); continue; }
      seen.add(k);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push({ cid: b.id, sid: Number(s.id) });
    }
  });
  const map = new Map();
  for (const [k, cards] of groups) {
    if (dupes.has(k)) continue;
    for (const c of cards) map.set(`${c.cid}:${c.sid}`, cards);
  }
  return map;
}
const cardsIn = (map, cid, sid) => map.get(`${Number(cid)}:${Number(sid)}`) || [{ cid: Number(cid), sid: Number(sid) }];
const cardsOf = async (cid, sid) => cardsIn(await personMap(), cid, sid);

// --- правки админов -------------------------------------------------------------

const PROFILE = ['name', 'specialization', 'direction', 'bio'];
const getOverride = db.prepare('SELECT * FROM portal_staff WHERE company_id = ? AND staff_id = ?');
const pendingStmt = db.prepare(`SELECT staff_id, COUNT(*) n FROM portal_reviews
  WHERE company_id = ? AND status = 'pending' GROUP BY staff_id`);

const fileUrl = (cid, sid, file) => `/p/works/${cid}/${sid}/${encodeURIComponent(file)}`;
const cardsSql = (cards) => ({
  sql: '(' + cards.map(() => '(company_id = ? AND staff_id = ?)').join(' OR ') + ')',
  args: cards.flatMap(c => [c.cid, c.sid]),
});

// Общий профиль человека: поле с главной карточки, пусто — с остальных
function profileOf(cards) {
  const rows = cards.map(c => getOverride.get(c.cid, c.sid)).filter(Boolean);
  const p = {};
  for (const f of PROFILE) p[f] = clean(rows.find(r => clean(r[f]))?.[f]);
  const ph = rows.find(r => r.photo);
  p.photo = ph ? fileUrl(ph.company_id, ph.staff_id, ph.photo) : '';
  return p;
}
function worksOf(cards) {
  const w = cardsSql(cards);
  return db.prepare(`SELECT id, company_id, staff_id, file, caption FROM portal_works WHERE ${w.sql} ORDER BY sort, id`)
    .all(...w.args).map(x => ({ id: x.id, src: fileUrl(x.company_id, x.staff_id, x.file), caption: x.caption || '' }));
}
function ratingOf(cards) {
  const w = cardsSql(cards);
  const r = db.prepare(`SELECT ROUND(AVG(rating), 1) AS rating, COUNT(*) AS n FROM portal_reviews
    WHERE ${w.sql} AND status = 'published'`).get(...w.args);
  return { rating: r?.n ? r.rating : null, n: r?.n || 0 };
}
// Опубликованные отзывы о человеке — со всех его карточек, для витрины
async function publicReviews(cid, sid) {
  const w = cardsSql(await cardsOf(cid, sid));
  return db.prepare(`SELECT author, rating, text, substr(created_at, 1, 10) AS date FROM portal_reviews
    WHERE ${w.sql} AND status = 'published' ORDER BY created_at DESC LIMIT 30`).all(...w.args);
}

// Мастер = данные YClients + правки админа. Возвращает и то и другое, чтобы CRM могла
// показать «в YClients так, у нас так». also — другие филиалы, где работает этот же человек.
function merge(cid, s, cards) {
  const own = getOverride.get(cid, s.id);
  const prof = profileOf(cards);
  const names = new Map(branchList().map(b => [b.id, b.name]));
  const name = prof.name || s.name;
  const specialization = prof.specialization || s.specialization;
  return {
    id: s.id, name, specialization,
    direction: prof.direction || autoDirection(s.position, specialization) || s.position || 'Другие мастера',
    bio: prof.bio || s.bio || '',
    avatar: prof.photo || s.avatar,
    visible: own ? Boolean(own.visible) : true,
    sort: own?.sort ?? null,
    also: cards.filter(c => c.cid !== Number(cid)).map(c => ({
      id: c.cid, name: names.get(c.cid) || String(c.cid), visible: Boolean(getOverride.get(c.cid, c.sid)?.visible ?? 1),
    })),
    yc: { name: s.name, specialization: s.specialization, position: s.position, avatar: s.avatar, bio: s.bio || '' },
    custom: { name: prof.name, specialization: prof.specialization, direction: prof.direction,
      bio: prof.bio, photo: Boolean(prof.photo) },
    tone: s.tone, // только в демо: оттенок вместо фото
  };
}
const bySort = (a, b) => ((a.sort ?? 1e9) - (b.sort ?? 1e9)) || a.name.localeCompare(b.name, 'ru');

// Для витрины: только видимые, с портфолио и оценкой по опубликованным отзывам
async function publicStaff(cid) {
  const [list, map] = [await ycStaff(cid), await personMap()];
  // в демо работ и отзывов в базе нет — показываем примерные из demo.js
  const demoWorks = yc.isDemo() ? new Map(demo().STAFF[cid]?.map(s => [s.id, s.works]) || []) : null;
  const raw = new Map(list.map(s => [s.id, s]));
  return list.map(s => ({ m: merge(cid, s, cardsIn(map, cid, s.id)), cards: cardsIn(map, cid, s.id) }))
    .filter(x => x.m.visible)
    .sort((a, b) => bySort(a.m, b.m))
    .map(({ m, cards }) => {
      const works = worksOf(cards).map(w => ({ src: w.src, caption: w.caption }));
      const r = ratingOf(cards);
      return {
        id: m.id, name: m.name, specialization: m.specialization, direction: m.direction, bio: m.bio,
        avatar: m.avatar, tone: m.tone,
        also: m.also.filter(b => b.visible).map(b => b.name),
        works: works.length || !demoWorks ? works : (demoWorks.get(m.id) || []),
        rating: r.rating || (demoWorks && raw.get(m.id)?.rating) || null,
        reviews: r.n || (demoWorks && raw.get(m.id)?.reviews) || 0,
      };
    });
}

// Для CRM: все мастера филиала, включая скрытых, со счётчиками.
// «На проверке» — отзывы, оставленные в этом филиале: их и проверяет его админ.
async function adminStaff(cid) {
  const [list, map] = [await ycStaff(cid), await personMap()];
  const pending = new Map(pendingStmt.all(cid).map(r => [Number(r.staff_id), r.n]));
  return list.map(s => {
    const cards = cardsIn(map, cid, s.id);
    const m = merge(cid, s, cards);
    const r = ratingOf(cards);
    return { ...m, works: worksOf(cards).length, rating: r.rating, reviews: r.n, pending: pending.get(m.id) || 0 };
  }).sort(bySort);
}

async function adminMaster(cid, sid) {
  const m = (await adminStaff(cid)).find(x => x.id === Number(sid));
  if (!m) return null;
  m.workList = worksOf(await cardsOf(cid, sid));
  m.services = await ycServices(cid, m.id).catch(() => []);
  return m;
}

const upsertOwn = db.prepare(`INSERT INTO portal_staff(company_id, staff_id, visible, sort, updated_at) VALUES(?,?,?,?,?)
  ON CONFLICT(company_id, staff_id) DO UPDATE SET visible=excluded.visible, sort=excluded.sort, updated_at=excluded.updated_at`);
const upsertProfile = db.prepare(`INSERT INTO portal_staff(company_id, staff_id, name, specialization, direction, bio, updated_at)
  VALUES(?,?,?,?,?,?,?)
  ON CONFLICT(company_id, staff_id) DO UPDATE SET name=excluded.name, specialization=excluded.specialization,
    direction=excluded.direction, bio=excluded.bio, updated_at=excluded.updated_at`);
const clearProfile = db.prepare(`UPDATE portal_staff SET name = NULL, specialization = NULL, direction = NULL, bio = NULL
  WHERE company_id = ? AND staff_id = ?`);

// visible/sort — в карточку этого филиала; имя, специализация, направление, «о мастере» —
// в главную карточку человека (со вторых стираем, чтобы старое не всплыло из-под пустого)
async function saveMaster(cid, sid, p) {
  const cards = await cardsOf(cid, sid);
  const prof = profileOf(cards);
  const pick = (k, max) => (p[k] === undefined ? (prof[k] || null) : (clean(p[k]).slice(0, max) || null));
  const direction = pick('direction', 40);
  if (direction && !DIRECTIONS.some(([d]) => d === direction)) throw new Error('Неизвестное направление');
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    if (p.visible !== undefined || p.sort !== undefined) {
      const cur = getOverride.get(cid, sid) || {};
      upsertOwn.run(cid, sid,
        p.visible === undefined ? (cur.visible ?? 1) : (p.visible ? 1 : 0),
        p.sort === undefined ? (cur.sort ?? null) : (Number.isFinite(Number(p.sort)) && p.sort !== null ? Number(p.sort) : null),
        now);
    }
    if (PROFILE.some(f => p[f] !== undefined)) {
      const [home, ...rest] = cards;
      upsertProfile.run(home.cid, home.sid, pick('name', 60), pick('specialization', 120), direction, pick('bio', 1200), now);
      for (const c of rest) clearProfile.run(c.cid, c.sid);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// --- файлы ----------------------------------------------------------------------

// Картинку уже ужали в браузере (до 1600 px, JPEG), здесь — только проверка, что это
// действительно картинка, и запись на диск под случайным именем.
function imageExt(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'png';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}
function saveFile(cid, sid, buf) {
  const ext = imageExt(buf);
  if (!ext) throw new Error('Это не похоже на фотографию: нужен JPEG, PNG или WebP');
  const dir = path.join(WORKS_DIR, String(Number(cid)), String(Number(sid)));
  fs.mkdirSync(dir, { recursive: true });
  const file = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(dir, file), buf);
  return file;
}
function removeFile(cid, sid, file) {
  if (!file || file.includes('/') || file.includes('..')) return;
  try { fs.unlinkSync(path.join(WORKS_DIR, String(Number(cid)), String(Number(sid)), file)); } catch { /* уже нет */ }
}

// Фото — на главную карточку; старые фото со всех карточек человека убираем
async function setPhoto(cid, sid, buf) {
  const cards = await cardsOf(cid, sid);
  const home = cards[0];
  const file = buf ? saveFile(home.cid, home.sid, buf) : null;
  const now = new Date().toISOString();
  db.prepare('INSERT OR IGNORE INTO portal_staff(company_id, staff_id, updated_at) VALUES(?,?,?)').run(home.cid, home.sid, now);
  const setStmt = db.prepare('UPDATE portal_staff SET photo = ?, updated_at = ? WHERE company_id = ? AND staff_id = ?');
  for (const c of cards) {
    const old = getOverride.get(c.cid, c.sid)?.photo;
    setStmt.run(c === home ? file : null, now, c.cid, c.sid);
    if (old) removeFile(c.cid, c.sid, old);
  }
}

// Работы — на главную карточку, в конец общего списка человека
async function addWork(cid, sid, buf, caption) {
  const cards = await cardsOf(cid, sid);
  const home = cards[0];
  const file = saveFile(home.cid, home.sid, buf);
  const w = cardsSql(cards);
  const next = db.prepare(`SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM portal_works WHERE ${w.sql}`).get(...w.args).s;
  return db.prepare('INSERT INTO portal_works(company_id, staff_id, file, caption, sort, created_at) VALUES(?,?,?,?,?,?)')
    .run(home.cid, home.sid, file, clean(caption).slice(0, 120) || null, next, new Date().toISOString()).lastInsertRowid;
}
const workById = db.prepare('SELECT * FROM portal_works WHERE id = ?');
async function updateWork(id, { caption, move }) {
  const w = workById.get(id);
  if (!w) throw new Error('Работа не найдена');
  if (caption !== undefined) db.prepare('UPDATE portal_works SET caption = ? WHERE id = ?').run(clean(caption).slice(0, 120) || null, id);
  if (move === -1 || move === 1) {
    // меняемся местами с соседом по общему списку человека; порядок 1..n пересобираем
    const list = worksOf(await cardsOf(w.company_id, w.staff_id)).map(x => x.id);
    const i = list.indexOf(Number(id)), j = i + move;
    if (j >= 0 && j < list.length) {
      [list[i], list[j]] = [list[j], list[i]];
      const upd = db.prepare('UPDATE portal_works SET sort = ? WHERE id = ?');
      list.forEach((wid, k) => upd.run(k + 1, wid));
    }
  }
}
function deleteWork(id) {
  const w = workById.get(id);
  if (!w) return;
  db.prepare('DELETE FROM portal_works WHERE id = ?').run(id);
  removeFile(w.company_id, w.staff_id, w.file);
}

// --- отзывы для проверки ----------------------------------------------------------

function reviewsForAdmin(cid, status) {
  const where = status === 'all' ? '' : 'AND status = ?';
  const args = status === 'all' ? [cid] : [cid, status || 'pending'];
  return db.prepare(`SELECT id, staff_id, staff_name, rating, text, author, phone10, verified, status, can_publish, created_at
    FROM portal_reviews WHERE company_id = ? ${where} ORDER BY created_at DESC LIMIT 200`).all(...args);
}
function setReviewStatus(id, status) {
  const r = db.prepare('SELECT can_publish FROM portal_reviews WHERE id = ?').get(id);
  if (!r) throw new Error('Отзыв не найден');
  if (!['published', 'hidden', 'pending'].includes(status)) throw new Error('Неизвестный статус');
  // публиковать без отдельного согласия клиента нельзя (распространение ПДн, ст. 10.1)
  if (status === 'published' && !r.can_publish) throw new Error('Клиент не разрешил публикацию: отзыв можно только прочитать');
  db.prepare('UPDATE portal_reviews SET status = ? WHERE id = ?').run(status, id);
}

// Сроки хранения из политики (/privacy): телефон и IP — 12 месяцев, неопубликованный
// отзыв — 3 года. Опубликованный живёт, пока клиент не отзовёт согласие (снимают вручную).
// Зовёт витрина при старте и раз в сутки.
function purgeReviews() {
  const day = 86400e3, now = Date.now();
  const year = new Date(now - 365 * day).toISOString();
  const three = new Date(now - 3 * 365 * day).toISOString();
  const a = db.prepare(`UPDATE portal_reviews SET phone10 = NULL, ip = NULL
    WHERE created_at < ? AND (phone10 IS NOT NULL OR ip IS NOT NULL)`).run(year).changes;
  const b = db.prepare(`DELETE FROM portal_reviews WHERE created_at < ? AND status != 'published'`).run(three).changes;
  return { cleared: a, deleted: b };
}

module.exports = {
  WORKS_DIR, purgeReviews, DIRECTIONS: DIRECTIONS.map(d => d[0]),
  ycStaff, ycServices, publicStaff, publicReviews, adminStaff, adminMaster,
  saveMaster, setPhoto, addWork, updateWork, deleteWork,
  reviewsForAdmin, setReviewStatus,
};
