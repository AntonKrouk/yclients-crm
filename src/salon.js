'use strict';

// Раздел «Салон» — дашборд владельца: сводка по записям, выручке и мастерам, а также свободные
// окна мастеров на неделю и клиенты, которых под них можно позвать. Контракт и определения
// метрик — в docs/salon-dashboard.md; весь расчёт здесь, server.js держит только тонкие маршруты.

const { db, MANUAL_LISTS } = require('./db');
const yc = require('./yclients');
const people = require('./people');
const sync = require('./sync');

const MSK = 3 * 3600e3;            // Москва — круглый год UTC+3
const DAY_MS = 86400000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_GAP = 60;                // окно короче часа в салоне никому не продать
const WINDOWS_TTL = 10 * 60e3;     // кэш окон: данные живые, но дёргать YClients на каждый клик незачем
const SCHEDULE_TTL = 10 * 60e3;    // сегодняшние и будущие смены перечитываем не чаще
const CLIENTS_PER_MASTER = 10;

const err = (message, status = 400) => Object.assign(new Error(message), { status });

// --- Даты -------------------------------------------------------------------------
// Копии помощников из server.js (там они объявлены внутри файла и наружу не выходят):
// салон живёт по Москве, а даты в базе лежат ISO-строкой в UTC.
const mskToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
const mskDayOf = (iso) => new Date(new Date(iso).getTime() + MSK).toISOString().slice(0, 10);
const shiftDay = (day, delta) => {
  const d = new Date(day + 'T12:00:00Z');   // полдень UTC не перескакивает через сутки
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
};
const mskMidnight = (day, plusDays = 0) => {
  const d = new Date(day + 'T00:00:00+03:00');
  d.setUTCDate(d.getUTCDate() + plusDays);
  return d.toISOString();
};
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / DAY_MS);
const listDays = (from, to) => Array.from({ length: daysBetween(from, to) + 1 }, (_, i) => shiftDay(from, i));

// Имя мастера в YClients пишут по-разному («Цопанова  Алина» с двойным пробелом) —
// для сравнения: нижний регистр, пробелы схлопнуты.
const normName = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const round1 = (x) => Math.round(x * 10) / 10;
const pct1 = (a, b) => (b ? round1((a / b) * 100) : 0);

// --- Направления ------------------------------------------------------------------
// Порядок проверки важен: «Массаж лица» должен стать массажем, а не косметологией, «Уход по
// лицу» — косметологией, а не волосами. Словарь составлен по реальным категориям прайса
// (смотри документ: список сверен с базой 27.10.2026). Слова из документа дополнены тем, что
// там не предусмотрено: перманент (брови/губы) → «Брови и ресницы», депиляция и обёртывания
// → «Массаж и тело», подология и «уход для рук/ног» → «Ногти», брендовые линии
// аппаратной косметологии (Hydrafacial, Geneo, QMS и др.) → «Косметология».
const DIRECTIONS = [
  ['Макияж', /макияж|визаж/],
  ['Брови и ресницы', /бров|ресниц|ламин|перманент/],
  ['Ногти', /маникюр|педикюр|покрыт|ногт|снятие|подолог|для рук/],
  ['Волосы', /стриж|уклад|окраш|тониров|(^|[^а-яё])тон([^а-яё]|$)|волос|кератин|причес|колор|блонд|декапир|парикмахер|инкарами|стилист/],
  ['Массаж и тело', /массаж|эндосфер|об[её]ртыван|бандаж|прессотерап|дренаж|депиляц|целлюлит|детокс|(^|[^а-яё])тел(о|а|е|у)([^а-яё]|$)|spa|(^|[^а-яё])спа([^а-яё]|$)/],
  ['Косметология', /космет|лиц|чистк|пилинг|уход за кож|уход на косметике|аппарат|dermadrop|geneo|hydrafacial|инъекц|микроток|heleo|asce|экзосмал|idenel|quick glow|водородн|faith|margy|qms|marini|clinical/],
];
const GENERIC_CATEGORIES = new Set(['все услуги']);   // «+3500 раннее открытие» — не направление

function matchDirection(text) {
  const t = String(text || '').toLowerCase();
  if (!t || GENERIC_CATEGORIES.has(t.trim())) return null;
  for (const [name, re] of DIRECTIONS) if (re.test(t)) return name;
  return null;
}
// Категории визита лежат через ', ' (первая — основная). Берём первую узнаваемую; если ни одна
// не подошла (категории нет вовсе — у части старых записей, или это «Выезды»), смотрим на
// сами названия услуг.
function directionOf(categories, serviceText) {
  for (const c of String(categories || '').split(', ')) {
    const d = matchDirection(c);
    if (d) return d;
  }
  return matchDirection(serviceText) || 'Прочее';
}

// --- Мастера и смены ----------------------------------------------------------------

const getMeta = (key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value || null;
const setMeta = (key, value) => db.prepare(
  'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);

const upsertStaff = db.prepare(`
  INSERT INTO staff (company_id, staff_id, name, specialization, bookable, fired, hidden, updated_at)
  VALUES (?,?,?,?,?,?,?,?)
  ON CONFLICT(company_id, staff_id) DO UPDATE SET
    name=excluded.name, specialization=excluded.specialization, bookable=excluded.bookable,
    fired=excluded.fired, hidden=excluded.hidden, updated_at=excluded.updated_at
`);

// Справочник одного филиала → таблица staff. Возвращает нормализованный список.
function saveStaff(cid, list) {
  const now = new Date().toISOString();
  const out = [];
  db.exec('BEGIN');
  try {
    for (const s of (Array.isArray(list) ? list : [])) {
      if (!s || !s.id) continue;
      const row = {
        staff_id: Number(s.id), name: cleanName(s.name), specialization: cleanName(s.specialization),
        // is_bookable — «можно записывать»: именно он отсекает служебного «АДМИНИСТРАТОРА»
        bookable: (s.is_bookable ?? s.bookable) ? 1 : 0,
        fired: s.fired ? 1 : 0, hidden: s.hidden ? 1 : 0,
      };
      upsertStaff.run(Number(cid), row.staff_id, row.name, row.specialization, row.bookable, row.fired, row.hidden, now);
      out.push(row);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return out;
}

const compName = (comp) => comp.name || String(comp.id);

// Справочник мастеров по всем филиалам. Лениво: не чаще раза в сутки (force — ночной синк).
async function refreshStaff({ force = false } = {}) {
  if (yc.isDemo()) return { skipped: 'demo' };
  const last = getMeta('staff_refreshed_at');
  if (!force && last && Date.now() - Date.parse(last) < DAY_MS) return { skipped: 'fresh' };
  await yc.ensureAuth();
  let staff = 0;
  const errors = [];
  for (const comp of yc.companies()) {
    try { staff += saveStaff(comp.id, await yc.fetchStaff(comp.id)).length; }
    catch (e) { errors.push(`${compName(comp)}: ${e.message}`); }
  }
  if (!errors.length) setMeta('staff_refreshed_at', new Date().toISOString());
  else console.error('[salon] справочник мастеров обновлён не полностью:', errors.join('; '));
  return { staff, errors };
}

const hhmm = (s) => {
  const m = String(s ?? '').match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const fmtMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// Слоты смены → пары минут от полуночи. Конец «00:00» читаем как конец суток.
function slotRanges(slots) {
  const out = [];
  for (const s of (Array.isArray(slots) ? slots : [])) {
    const a = hhmm(s.from);
    let b = hhmm(s.to);
    if (a == null || b == null) continue;
    if (b <= a) b = 1440;
    out.push({ from: a, to: Math.min(b, 1440) });
  }
  return out.sort((x, y) => x.from - y.from);
}
const sumRanges = (r) => r.reduce((s, x) => s + (x.to - x.from), 0);

// Записывает расписание филиала за [start..end]. Ответ API содержит только рабочие дни, а нам
// нужно помнить и выходные (иначе прошлые дни перезапрашивались бы вечно): каждому известному
// мастеру на каждый день ставим строку, у выходных work_min = 0. Строка staff_id = 0 — отметка
// «этот день филиалу уже грузили», она нужна на случай дня, когда не работал никто.
const upsertDay = db.prepare(`
  INSERT INTO staff_days (company_id, staff_id, date, work_min, slots, updated_at) VALUES (?,?,?,?,?,?)
  ON CONFLICT(company_id, staff_id, date) DO UPDATE SET
    work_min=excluded.work_min, slots=excluded.slots, updated_at=excluded.updated_at
`);
function saveSchedule(cid, start, end, rows) {
  const now = new Date().toISOString();
  const byKey = new Map();    // 'staff_id|date' → слоты
  const ids = new Set(db.prepare('SELECT staff_id FROM staff WHERE company_id = ?').all(Number(cid)).map(r => r.staff_id));
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (!r || !r.staff_id || !DAY_RE.test(String(r.date || ''))) continue;
    byKey.set(`${r.staff_id}|${r.date}`, r.slots || []);
    ids.add(Number(r.staff_id));
  }
  const days = listDays(start, end);
  db.exec('BEGIN');
  try {
    for (const day of days) {
      upsertDay.run(Number(cid), 0, day, 0, '[]', now);
      for (const id of ids) {
        const slots = byKey.get(`${id}|${day}`) || [];
        upsertDay.run(Number(cid), id, day, sumRanges(slotRanges(slots)), JSON.stringify(slots), now);
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return days.length;
}

// Смены за период. Прошлые дни не меняются — один раз докачали и хватит; сегодняшние и будущие
// живые (мастера меняются, правят график) — не чаще раза в 10 минут. Запросы — кусками до 31 дня.
async function ensureSchedule(from, to) {
  if (yc.isDemo()) return { requests: 0, days: 0, skipped: 'demo' };
  if (!DAY_RE.test(from) || !DAY_RE.test(to) || from > to) throw err('Некорректный период смен');
  await yc.ensureAuth();
  const today = mskToday();
  let requests = 0, saved = 0;
  const all = listDays(from, to);
  for (const comp of yc.companies()) {
    const cid = Number(comp.id);
    const stamp = new Map(db.prepare(`SELECT date, MAX(updated_at) AS u FROM staff_days
      WHERE company_id = ? AND date BETWEEN ? AND ? GROUP BY date`).all(cid, from, to).map(r => [r.date, r.u]));
    const need = all.filter(d => {
      const u = stamp.get(d);
      if (!u) return true;
      // прошлый день окончателен, только если записан ПОСЛЕ его конца: загруженное днём,
      // когда он был «сегодня», могло потом поменяться
      if (d < today) return u < mskMidnight(d, 1);
      return Date.now() - Date.parse(u) > SCHEDULE_TTL;
    });
    for (let i = 0; i < need.length;) {
      const start = need[i], limit = shiftDay(start, 30);
      let j = i;
      while (j < need.length && need[j] <= limit) j++;
      const end = need[j - 1];
      saved += saveSchedule(cid, start, end, await yc.fetchStaffSchedule(cid, start, end));
      requests++;
      i = j;
    }
  }
  return { requests, days: saved };
}

// --- Сводка -------------------------------------------------------------------------

async function summary({ from, to, branch } = {}) {
  const today = mskToday();
  let f = DAY_RE.test(from || '') ? from : today.slice(0, 8) + '01';
  let t = DAY_RE.test(to || '') ? to : today;
  if (f > t) [f, t] = [t, f];
  const days = daysBetween(f, t) + 1;
  if (days > 1100) throw err('Период слишком длинный (не больше трёх лет)');
  const prevTo = shiftDay(f, -1), prevFrom = shiftDay(prevTo, -(days - 1));
  branch = String(branch || '').trim();

  // Смены для загрузки мастеров. Сбой YClients не должен ронять сводку: без смен просто
  // не будет процента загрузки.
  // Берём не глубже ~13 месяцев назад и не дальше месяца вперёд: ни то ни другое сводке не нужно.
  const schFrom = f < shiftDay(today, -400) ? shiftDay(today, -400) : f;
  const schTo = t > shiftDay(today, 30) ? shiftDay(today, 30) : t;
  try {
    await refreshStaff();
    if (schFrom <= schTo) await ensureSchedule(schFrom, schTo);
  } catch (e) { console.error('[salon] смены не обновлены:', e.message); }

  const bw = branch ? 'AND branch = ?' : '';
  const bArgs = branch ? [branch] : [];
  // Строки с kind IS NULL (приехали до появления колонки) тоже берём — это записи, не ДР
  const rows = db.prepare(`SELECT client_id, date, service, staff, staff_id, cost, status, kind, service_category,
      duration_min, company_id, branch
    FROM visits WHERE date >= ? AND date < ? AND COALESCE(kind,'') <> 'birthday' ${bw}`)
    .all(mskMidnight(prevFrom), mskMidnight(t, 1), ...bArgs);
  const nowIso = new Date().toISOString();
  const cur = [], prev = [];
  for (const r of rows) {
    r.day = mskDayOf(r.date);
    r.cost = Number(r.cost) || 0;
    (r.day >= f ? cur : prev).push(r);
  }
  const unclosedOf = (r) => r.status === 'upcoming' && r.kind === 'visit' && r.date < nowIso;

  // Плитки: общий счёт по списку записей
  const stats = (list) => {
    const s = { records: list.length, completed: 0, no_show: 0, cancelled: 0, revenue: 0 };
    const trips = new Set();
    for (const r of list) {
      if (r.status === 'completed') { s.completed++; s.revenue += r.cost; trips.add(r.client_id + '|' + r.day); }
      else if (r.status === 'no_show') s.no_show++;
      else if (r.status === 'cancelled') s.cancelled++;
    }
    s.trips = trips.size;
    return s;
  };
  const c = stats(cur), p = stats(prev);
  const avgCheck = (s) => (s.trips ? Math.round(s.revenue / s.trips) : 0);
  const lost = c.no_show + c.cancelled;

  const goodsRow = db.prepare(`SELECT COALESCE(SUM(cost),0) AS s FROM purchases
    WHERE date >= ? AND date < ? ${bw}`).get(mskMidnight(f), mskMidnight(t, 1), ...bArgs);

  const tiles = {
    records: { value: c.records, prev: p.records },
    completed: { value: c.completed, prev: p.completed, pct: pct1(c.completed, c.records) },
    lost: { value: lost, prev: p.no_show + p.cancelled, pct: pct1(lost, c.records), no_show: c.no_show, cancelled: c.cancelled },
    unclosed: { value: cur.filter(unclosedOf).length },
    revenue: { value: Math.round(c.revenue), prev: Math.round(p.revenue), avg_check: avgCheck(c), avg_check_prev: avgCheck(p),
      trips: c.trips, goods: Math.round(goodsRow.s) },
  };

  // Ряд по дням: каждый день периода, нули тоже
  const perDay = new Map(listDays(f, t).map(d => [d, { day: d, records: 0, completed: 0, lost: 0, revenue: 0 }]));
  for (const r of cur) {
    const d = perDay.get(r.day);
    d.records++;
    if (r.status === 'completed') { d.completed++; d.revenue += r.cost; }
    else if (r.status === 'no_show' || r.status === 'cancelled') d.lost++;
  }
  const series = [...perDay.values()].map(d => ({ ...d, revenue: Math.round(d.revenue) }));

  // --- Мастера: имя + филиал (мастер в двух салонах — две строки, как в YClients)
  // «Повторные»: у клиента уже был закрытый визит к тому же мастеру в более ранний ДЕНЬ.
  // Две услуги одного похода (разные записи одного дня) повтором не считаем.
  const firstWith = new Map();   // 'client|мастер' → самый ранний закрытый визит за всю историю
  for (const r of db.prepare(`SELECT client_id, staff, MIN(date) AS d FROM visits
      WHERE status = 'completed' AND COALESCE(staff,'') <> '' GROUP BY client_id, staff`).all()) {
    const k = r.client_id + '|' + normName(r.staff);
    if (!firstWith.has(k) || r.d < firstWith.get(k)) firstWith.set(k, r.d);
  }
  const staffIdsByName = new Map();     // 'company|имя' → id из справочника
  for (const s of db.prepare('SELECT company_id, staff_id, name FROM staff').all()) {
    const k = s.company_id + '|' + normName(s.name);
    if (!staffIdsByName.has(k)) staffIdsByName.set(k, []);
    staffIdsByName.get(k).push(s.staff_id);
  }
  const workByStaff = new Map();        // 'company|id' → минут смен за период
  let scheduleRows = 0, scheduleUpdated = null;
  for (const w of db.prepare(`SELECT company_id, staff_id, SUM(work_min) AS m, COUNT(*) AS n, MAX(updated_at) AS u
      FROM staff_days WHERE date BETWEEN ? AND ? AND staff_id <> 0 ${branch ? 'AND company_id IN (SELECT DISTINCT company_id FROM visits WHERE branch = ?)' : ''}
      GROUP BY company_id, staff_id`).all(f, t, ...bArgs)) {
    workByStaff.set(w.company_id + '|' + w.staff_id, w.m || 0);
    scheduleRows += w.n;
    if (!scheduleUpdated || w.u > scheduleUpdated) scheduleUpdated = w.u;
  }

  const groups = new Map();
  for (const r of cur) {
    const name = cleanName(r.staff);
    if (!name) continue;
    const key = r.company_id + '|' + normName(name);
    if (!groups.has(key)) groups.set(key, { staff: name, branch: r.branch, company_id: r.company_id, rows: [], ids: new Set() });
    const g = groups.get(key);
    g.rows.push(r);
    if (r.staff_id) g.ids.add(r.staff_id);
  }
  const totalRevenue = c.revenue;
  const masters = [];
  for (const [key, g] of groups) {
    const done = g.rows.filter(r => r.status === 'completed');
    const revenue = done.reduce((s, r) => s + r.cost, 0);
    const trips = new Set(done.map(r => r.client_id + '|' + r.day)).size;
    const repeat = done.filter(r => {
      const first = firstWith.get(r.client_id + '|' + normName(r.staff));
      return first && mskDayOf(first) < r.day;
    }).length;
    // загрузка: минуты закрытых + неявок + незакрытых записей / минуты смен по расписанию
    const loadRows = g.rows.filter(r => r.status === 'completed' || r.status === 'no_show' || unclosedOf(r));
    const known = loadRows.filter(r => r.duration_min > 0);
    for (const id of staffIdsByName.get(key) || []) g.ids.add(id);   // старые визиты без staff_id — по имени
    let workMin = 0, hasSchedule = false;
    for (const id of g.ids) {
      const w = workByStaff.get(g.company_id + '|' + id);
      if (w != null) { hasSchedule = true; workMin += w; }
    }
    const busyMin = known.reduce((s, r) => s + r.duration_min, 0);
    // «длительности почти не известны» — меньше 80% записей: иначе загрузка занижена
    const durationsOk = loadRows.length > 0 && known.length / loadRows.length >= 0.8;
    masters.push({
      // records — закрытые визиты: из них же выручка и чек, иначе «записей» и «выручка» не сходились бы
      staff: g.staff, branch: g.branch, records: done.length,
      revenue: Math.round(revenue), share: pct1(revenue, totalRevenue),
      avg_check: trips ? Math.round(revenue / trips) : null,
      repeat_pct: done.length ? Math.round((repeat / done.length) * 100) : null,
      load_pct: hasSchedule && workMin > 0 && durationsOk ? Math.round((busyMin / workMin) * 100) : null,
      work_hours: hasSchedule ? round1(workMin / 60) : null,
      busy_hours: durationsOk ? round1(busyMin / 60) : null,
    });
  }
  masters.sort((a, b) => b.revenue - a.revenue || b.records - a.records);

  // --- Направления: по закрытым записям (категория первая узнаваемая, см. directionOf)
  const dirs = new Map();
  for (const r of cur) {
    if (r.status !== 'completed') continue;
    const name = directionOf(r.service_category, r.service);
    if (!dirs.has(name)) dirs.set(name, { name, revenue: 0, records: 0 });
    const d = dirs.get(name);
    d.revenue += r.cost; d.records++;
  }
  const directions = [...dirs.values()].sort((a, b) => b.revenue - a.revenue)
    .map(d => ({ name: d.name, revenue: Math.round(d.revenue), records: d.records, share: pct1(d.revenue, totalRevenue) }));

  // --- Услуги: топ-15 по выручке, только записи из ОДНОЙ услуги (иначе выручку не поделить).
  // Названия склеены через ', ', а в самом названии запятая тоже бывает — поэтому «одна услуга»
  // это либо текст без ', ', либо точное название из прайса.
  const titles = new Set(db.prepare("SELECT title FROM services WHERE title <> ''").all().map(s => normName(s.title)));
  const svc = new Map();
  for (const r of cur) {
    if (r.status !== 'completed') continue;
    const text = cleanName(r.service);
    if (!text || (text.includes(', ') && !titles.has(normName(text)))) continue;
    if (!svc.has(text)) svc.set(text, { service: text, records: 0, revenue: 0, knownN: 0, knownMin: 0, knownRev: 0 });
    const s = svc.get(text);
    s.records++; s.revenue += r.cost;
    if (r.duration_min > 0) { s.knownN++; s.knownMin += r.duration_min; s.knownRev += r.cost; }
  }
  const services = [...svc.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 15).map(s => ({
    service: s.service, records: s.records, revenue: Math.round(s.revenue), avg_price: Math.round(s.revenue / s.records),
    avg_min: s.knownN ? Math.round(s.knownMin / s.knownN) : null,
    // доход в час — только по записям с известной длительностью, чтобы цена и время были из одной выборки
    per_hour: s.knownMin ? Math.round((s.knownRev / s.knownMin) * 60) : null,
  }));

  // --- Источники: насколько свежи и полны данные под цифрами
  const live = cur.filter(r => r.status !== 'cancelled');
  const syncedAt = getMeta('last_sync_at')
    // метки синка раньше не было: ближайшее по смыслу — когда в последний раз обновляли клиентов
    || db.prepare('SELECT MAX(updated_at) AS u FROM clients').get().u || null;
  const sources = {
    yclients_synced_at: syncedAt,
    schedule_updated_at: scheduleUpdated,
    durations_known_pct: live.length ? Math.round((live.filter(r => r.duration_min > 0).length / live.length) * 100) : null,
  };

  return {
    period: { from: f, to: t, days, prev_from: prevFrom, prev_to: prevTo },
    tiles, series, masters, directions, services, sources,
  };
}

// --- Свободные окна -----------------------------------------------------------------

// Свободные отрезки внутри смены. Чистая функция — без сети и базы, поэтому проверяется на примерах.
//  slots  — смены дня: [{from:'10:00', to:'22:00'}] (допустимы и минуты числом);
//  busy   — занятость: [{from, to}] в минутах от полуночи (пересекающиеся записи сливаются);
//  minGap — окно короче не считаем (по умолчанию час);
//  notBefore — минута, раньше которой окном быть уже не может (сегодня: «сейчас + 30 мин»).
function computeGaps(slots, busy, { minGap = MIN_GAP, notBefore = null } = {}) {
  const num = (x) => (typeof x === 'number' ? x : hhmm(x));
  const occupied = (busy || [])
    .map(b => ({ from: num(b.from), to: num(b.to) }))
    .filter(b => b.from != null && b.to != null && b.to > b.from)
    .sort((a, b) => a.from - b.from);
  const out = [];
  const push = (a, b) => { if (b - a >= minGap) out.push({ from: fmtMin(a), to: fmtMin(b), min: b - a }); };
  const shifts = (slots || [])
    .map(s => ({ from: num(s.from), to: num(s.to) }))
    .filter(s => s.from != null && s.to != null)
    .map(s => (s.to <= s.from ? { from: s.from, to: 1440 } : s))
    .sort((a, b) => a.from - b.from);
  for (const s of shifts) {
    let cur = notBefore != null ? Math.max(s.from, notBefore) : s.from;
    const end = s.to;
    if (cur >= end) continue;
    for (const b of occupied) {
      if (b.to <= cur) continue;
      if (b.from >= end) break;
      if (b.from > cur) push(cur, b.from);
      cur = Math.max(cur, b.to);
      if (cur >= end) break;
    }
    if (cur < end) push(cur, end);
  }
  return out;
}

// --- Живые данные YClients: мастера, смены и записи на неделю ----------------------------
// Из них считаются и свободные окна, и режим «Сегодня». У каждой части свой срок годности:
// мастера меняются редко, смены — изредка, записи — постоянно. Вебхук YClients (invalidate)
// делает записи филиала устаревшими сразу, не дожидаясь срока.
const STAFF_TTL = 60 * 60e3;
const liveCache = new Map();      // 'cid|часть' → { at, d0, data }
const liveInflight = new Map();   // 'cid|часть|d0' → { started, p }
const dirtyAt = new Map();        // cid → когда пришёл последний вебхук по филиалу

function liveGet(cid, part, d0, maxAge, load) {
  const key = cid + '|' + part, fkey = key + '|' + d0;
  const dirty = part === 'recs' ? (dirtyAt.get(cid) || 0) : 0;
  const hit = liveCache.get(key);
  // at — момент НАЧАЛА загрузки: изменение, о котором вебхук сообщил позже, в этих данных может не быть
  if (hit && hit.d0 === d0 && hit.at >= dirty && Date.now() - hit.at < maxAge) return Promise.resolve(hit);
  const fly = liveInflight.get(fkey);
  if (fly && fly.started >= dirty) return fly.p;   // параллельные запросы — один поход в YClients
  const started = Date.now();
  const p = load().then(data => {
    const entry = { at: started, d0, data };
    const cur = liveCache.get(key);
    if (!cur || cur.at <= started) liveCache.set(key, entry);
    return entry;
  }).finally(() => { if (liveInflight.get(fkey)?.p === p) liveInflight.delete(fkey); });
  liveInflight.set(fkey, { started, p });
  return p;
}

// Вебхук YClients: в журнале филиала что-то поменялось — следующий запрос пойдёт за записями заново
function invalidate(cid) { dirtyAt.set(Number(cid), Date.now()); }

// Запись журнала → то, что нужно окнам и «Сегодня»; null — запись времени не занимает
// (удалена, ДР-напоминание, нет мастера или времени). Минуты — московские, от полуночи.
//  end — конец самой записи, to — вместе с техническим перерывом: перерыв мастеру тоже занят.
function slimRecord(r) {
  if (!r || r.deleted || sync.isBirthdayRecord(r)) return null;
  const staffId = Number(r.staff_id || (r.staff && r.staff.id));
  const t = Date.parse(r.datetime || r.date || '');
  if (!staffId || Number.isNaN(t)) return null;
  const m = new Date(t + MSK);
  const from = m.getUTCHours() * 60 + m.getUTCMinutes();
  const len = Math.round((Number(r.seance_length ?? r.length) || 0) / 60);   // секунды → минуты
  const brk = Math.round((Number(r.technical_break_duration) || 0) / 60);
  const services = Array.isArray(r.services) ? r.services : [];
  const c = r.client && r.client.id ? r.client : null;
  return {
    id: r.id, staff_id: staffId, day: m.toISOString().slice(0, 10),
    from, end: Math.min(1440, from + len), to: Math.min(1440, from + len + brk),
    attendance: Number(r.attendance) || 0,   // 1 пришёл, -1 не пришёл, 0/2 ждём
    client: c ? { yc_id: c.id, name: cleanName(c.display_name || [c.name, c.surname].filter(Boolean).join(' ')) || 'Без имени' } : null,
    service: services.map(s => s.title || s.name).filter(Boolean).join(', '),
    cost: services.reduce((s, x) => s + (Number(x.cost) || 0), 0),
    note: c ? '' : cleanName(r.comment).slice(0, 80),   // у блокировки («обучение») смысл — в комментарии
  };
}

// Филиал целиком: справочник, смены и ВСЕ записи журнала на неделю (в том числе без клиента —
// блокировки «обучение», «под запись»; их около пятой части, без них окна врали бы).
async function companyLive(comp, days, recordsMaxAge) {
  const cid = Number(comp.id), d0 = days[0], d6 = days[days.length - 1];
  const [staff, sched, recs] = await Promise.all([
    liveGet(cid, 'staff', '', STAFF_TTL, async () => saveStaff(cid, await yc.fetchStaff(cid))),
    liveGet(cid, 'sched', d0, SCHEDULE_TTL, async () => {
      const rows = await yc.fetchStaffSchedule(cid, d0, d6);
      saveSchedule(cid, d0, d6, rows);        // заодно освежаем кэш смен для сводки
      return rows || [];
    }),
    liveGet(cid, 'recs', d0, recordsMaxAge, async () =>
      (await yc.fetchRecords(cid, d0, d6)).map(slimRecord).filter(Boolean)),
  ]);
  const slotsOf = new Map();               // 'staff|день' → слоты смены
  for (const r of sched.data) if (r && r.staff_id) slotsOf.set(`${r.staff_id}|${r.date}`, r.slots || []);
  const recsOf = new Map();                // 'staff|день' → записи
  for (const r of recs.data) {
    const k = `${r.staff_id}|${r.day}`;
    if (!recsOf.has(k)) recsOf.set(k, []);
    recsOf.get(k).push(r);
  }
  return { cid, branch: compName(comp), staff: staff.data, slotsOf, recsOf, recs: recs.data, at: recs.at };
}

const nowMskMin = () => { const m = new Date(Date.now() + MSK); return m.getUTCHours() * 60 + m.getUTCMinutes(); };
const ceil5 = (m) => Math.ceil(m / 5) * 5;   // к сетке журнала YClients
const weekFrom = (day) => Array.from({ length: 7 }, (_, i) => shiftDay(day, i));
function pickCompanies(branch) {
  branch = String(branch || '').trim();
  const comps = yc.companies().filter(c => !branch || compName(c) === branch);
  if (!comps.length) throw err(`Неизвестный филиал: ${branch}`);
  return comps;
}

// Свободные окна мастеров филиала на неделю
function companyWindows(live, days) {
  const today = mskToday();
  // сегодня окном не считаем всё, что раньше «сейчас + 30 мин»
  const notBeforeToday = ceil5(nowMskMin() + 30);
  const masters = [];
  for (const s of live.staff) {
    if (!s.bookable || s.fired) continue;
    const perDay = days.map(day => {
      const slots = live.slotsOf.get(`${s.staff_id}|${day}`) || [];
      const busy = (live.recsOf.get(`${s.staff_id}|${day}`) || []).map(r => ({ from: r.from, to: r.to }));
      const gaps = computeGaps(slots, busy, { minGap: MIN_GAP, notBefore: day === today ? notBeforeToday : null });
      return { day, work_min: sumRanges(slotRanges(slots)), free_min: gaps.reduce((a, g) => a + g.min, 0), gaps };
    });
    if (!perDay.some(d => d.work_min > 0)) continue;        // только мастера хотя бы с одной сменой
    masters.push({
      staff_id: s.staff_id, company_id: live.cid, branch: live.branch, staff: s.name, specialization: s.specialization,
      days: perDay, free_min_total: perDay.reduce((a, d) => a + d.free_min, 0),
    });
  }
  return masters;
}

// Люди, которых нельзя звать под окна, и люди с задачей/звонком — по ЧЕЛОВЕКУ (телефон), а не
// по карточке: в соседнем филиале у него другая карточка. Правила — как в rules.js.
function personSets() {
  const keyOf = (r) => people.personKey({ id: r.id, phone: r.phone });
  const manualIds = [];
  for (const table of Object.values(MANUAL_LISTS)) {
    for (const r of db.prepare(`SELECT client_id FROM ${table}`).all()) manualIds.push(r.client_id);
  }
  const blocked = new Set(db.prepare(
    'SELECT id, phone FROM clients WHERE COALESCE(do_not_call,0) = 1 OR COALESCE(free_client,0) = 1').all().map(keyOf));
  if (manualIds.length) {
    const sel = db.prepare('SELECT id, phone FROM clients WHERE id = ?');
    for (const id of manualIds) { const c = sel.get(id); if (c) blocked.add(keyOf(c)); }
  }
  const nowIso = new Date().toISOString();
  // будущая запись; ДР-напоминание в журнале записью на услугу не считается
  const booked = new Set(db.prepare(`SELECT DISTINCT c.id, c.phone FROM visits v JOIN clients c ON c.id = v.client_id
    WHERE v.status = 'upcoming' AND v.date >= ? AND COALESCE(v.kind,'') <> 'birthday'`).all(nowIso).map(keyOf));
  // звонили за последние 14 дней (любой звонок: и по задаче, и по списку; «написали» — не звонок)
  const called = new Set(db.prepare(`SELECT DISTINCT c.id, c.phone FROM task_actions a JOIN clients c ON c.id = a.client_id
    WHERE a.created_at >= ? AND COALESCE(a.result,'') <> 'written'`)
    .all(new Date(Date.now() - 14 * DAY_MS).toISOString()).map(keyOf));
  const inTasks = new Set(db.prepare(`SELECT DISTINCT c.id, c.phone FROM tasks t JOIN clients c ON c.id = t.client_id
    WHERE t.status IN ('open','snoozed')`).all().map(keyOf));
  return { keyOf, blocked, booked, called, inTasks };
}

// Клиенты под окна: у кого этот мастер любимый и подошёл срок. Возвращает Map 'company|мастер' → клиенты.
function candidatesFor(companyIds, today) {
  if (!companyIds.length) return new Map();
  const { keyOf, blocked, booked, called, inTasks } = personSets();
  const rows = db.prepare(`SELECT id, name, phone, company_id, favorite_staff, last_visit, predicted_next,
      visits_count, spent FROM clients
    WHERE company_id IN (${companyIds.map(() => '?').join(',')})
      AND COALESCE(do_not_call,0) = 0 AND COALESCE(free_client,0) = 0
      AND visits_count >= 2 AND avg_interval_days IS NOT NULL AND COALESCE(favorite_staff,'') <> ''
      AND predicted_next >= ? AND predicted_next < ?`)
    .all(...companyIds, mskMidnight(shiftDay(today, -30)), mskMidnight(shiftDay(today, 8)));
  // человек с карточками в двух филиалах звался бы дважды: оставляем карточку с большим числом визитов
  const best = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (blocked.has(k) || booked.has(k) || called.has(k)) continue;
    const have = best.get(k);
    if (!have || r.visits_count > have.visits_count) best.set(k, r);
  }
  const out = new Map();
  for (const r of best.values()) {
    const k = r.company_id + '|' + normName(r.favorite_staff);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push({
      id: r.id, name: r.name, phone: r.phone, last_visit: r.last_visit, predicted_next: r.predicted_next,
      // отрицательное — срок ещё впереди (до +7 дней)
      overdue_days: daysBetween(mskDayOf(r.predicted_next), today),
      visits_count: r.visits_count, avg_check: r.visits_count ? Math.round((r.spent || 0) / r.visits_count) : 0,
      in_tasks: inTasks.has(keyOf(r)),
    });
  }
  for (const list of out.values()) list.sort((a, b) => b.overdue_days - a.overdue_days || b.visits_count - a.visits_count);
  return out;
}

// Живые данные по выбранным филиалам; сбой одного филиала не прячет другой — он уходит в warnings
async function livesOf(branch, recordsMaxAge, what) {
  if (yc.isDemo()) throw err(`Демо-режим: ${what} считается по живому журналу YClients, а ключи не заданы`);
  const comps = pickCompanies(branch);
  await yc.ensureAuth();
  const today = mskToday(), days = weekFrom(today);
  const lives = [], warnings = [];
  for (const comp of comps) {
    try { lives.push(await companyLive(comp, days, recordsMaxAge)); }
    catch (e) { console.error(`[salon] ${what}, ${compName(comp)}:`, e.message); warnings.push(`${compName(comp)}: ${e.message}`); }
  }
  if (!lives.length) throw err(`YClients не отдал журнал — ${warnings.join('; ')}`, 502);
  return { today, days, lives, warnings };
}

// Окнам хватает записей десятиминутной свежести: неделя вперёд меняется не поминутно,
// а о каждой новой записи вебхук и так сбросит кэш.
async function windows({ branch, refresh } = {}) {
  const { today, days, lives, warnings } = await livesOf(branch, refresh ? 0 : WINDOWS_TTL, 'свободные окна');
  const parts = lives.map(l => ({ at: l.at, masters: companyWindows(l, days) }));

  const cands = candidatesFor(parts.flatMap(p => p.masters.map(m => m.company_id)).filter((v, i, a) => a.indexOf(v) === i), today);
  const masters = [];
  for (const m of parts.flatMap(p => p.masters)) {
    // клиентов зовём только под мастера, у которого окна вообще есть
    const clients = m.free_min_total > 0 ? (cands.get(m.company_id + '|' + normName(m.staff)) || []).slice(0, CLIENTS_PER_MASTER) : [];
    masters.push({ ...m, clients });
  }
  masters.sort((a, b) => b.free_min_total - a.free_min_total);

  return {
    updated_at: new Date(Math.min(...parts.map(p => p.at))).toISOString(),
    days, min_gap: MIN_GAP, masters,
    totals: {
      free_min: masters.reduce((a, m) => a + m.free_min_total, 0),
      gaps: masters.reduce((a, m) => a + m.days.reduce((b, d) => b + d.gaps.length, 0), 0),
      clients: masters.reduce((a, m) => a + m.clients.length, 0),
    },
    ...(warnings.length ? { warnings } : {}),
  };
}

// --- Сегодня: день салона вживую ------------------------------------------------------
// Записи дня из журнала YClients (не из нашей базы — она догоняет синком раз в 30 минут):
// кто пришёл, кто сейчас у мастера, кто впереди, кто не пришёл; выручка закрытая и ожидаемая;
// лента дня каждого мастера. Записи берутся не старше минуты, а вебхук сбрасывает их сразу.
const TODAY_TTL = 60e3;

async function today({ branch, refresh } = {}) {
  const { today: day, lives, warnings } = await livesOf(branch, refresh ? 0 : TODAY_TTL, 'день салона');
  const now = nowMskMin();
  // now — идёт прямо сейчас (по времени: «пришёл» админы часто ставят, когда клиент сел в кресло),
  // done — визит закончился и закрыт, late — время прошло, а визит не закрыли, waiting — впереди.
  // Неявка — только по отметке «не пришёл». Деньги считаются по отметке, а не по времени (ниже).
  const stateOf = (r) => r.attendance === -1 ? 'no_show'
    : r.from <= now && now < r.end ? 'now'
    : r.attendance === 1 ? 'done' : r.end <= now ? 'late' : 'waiting';

  // Карточки клиентов в нашей базе — чтобы по клику на запись открывать карточку
  const ycIds = [...new Set(lives.flatMap(l => l.recs).filter(r => r.day === day && r.client).map(r => r.client.yc_id))];
  const localOf = new Map();
  if (ycIds.length) {
    for (const c of db.prepare(`SELECT id, yclients_id FROM clients WHERE yclients_id IN (${ycIds.map(() => '?').join(',')})`)
      .all(...ycIds)) localOf.set(c.yclients_id, c.id);
  }

  const t = { records: 0, done: 0, now: 0, waiting: 0, late: 0, no_show: 0, revenue_done: 0, revenue_expected: 0 };
  const doneClients = new Set();
  const masters = [];
  let lo = 1440, hi = 0;
  for (const live of lives) {
    // Плитки — по всем записям с клиентом, у какого бы мастера они ни стояли
    for (const r of live.recs) {
      if (r.day !== day || !r.client) continue;
      t.records++; t[stateOf(r)]++;
      // выручка — по отметке «пришёл» (визит закрыт в YClients), а не по времени записи
      if (r.attendance === 1) { t.revenue_done += r.cost; doneClients.add(r.client.yc_id); }
      else if (r.attendance !== -1) t.revenue_expected += r.cost;
    }
    for (const s of live.staff) {
      if (!s.bookable || s.fired) continue;
      const slots = live.slotsOf.get(`${s.staff_id}|${day}`) || [];
      const recs = (live.recsOf.get(`${s.staff_id}|${day}`) || []).slice().sort((a, b) => a.from - b.from);
      const work = slotRanges(slots);
      if (!work.length && !recs.some(r => r.client)) continue;   // не работает и записей нет
      const visits = recs.filter(r => r.client && r.attendance !== -1);
      const workMin = sumRanges(work);
      const busyMin = visits.reduce((a, r) => a + (r.end - r.from), 0);
      const gaps = computeGaps(slots, recs.map(r => ({ from: r.from, to: r.to })), { minGap: MIN_GAP, notBefore: ceil5(now) });
      const cur = visits.find(r => stateOf(r) === 'now');
      const next = visits.find(r => r.from > now);
      for (const w of work) { lo = Math.min(lo, w.from); hi = Math.max(hi, w.to); }
      for (const r of recs) { lo = Math.min(lo, r.from); hi = Math.max(hi, r.end); }
      masters.push({
        staff_id: s.staff_id, company_id: live.cid, branch: live.branch, staff: s.name, specialization: s.specialization,
        work: work.map(w => ({ from: fmtMin(w.from), to: fmtMin(w.to) })), work_min: workMin, busy_min: busyMin,
        load_pct: workMin ? Math.round((busyMin / workMin) * 100) : null,
        free_left_min: gaps.reduce((a, g) => a + g.min, 0), next_gap: gaps[0] || null,
        now: cur ? { client: cur.client.name, service: cur.service, to: fmtMin(cur.end) } : null,
        next: next ? { from: fmtMin(next.from), client: next.client.name, service: next.service } : null,
        items: recs.map(r => ({
          from: fmtMin(r.from), to: fmtMin(r.end),
          kind: r.client ? 'visit' : 'block', state: r.client ? stateOf(r) : null,
          client: r.client ? r.client.name : null, client_id: r.client ? (localOf.get(r.client.yc_id) || null) : null,
          service: r.service || null, cost: r.client ? Math.round(r.cost) : null, note: r.client ? null : (r.note || null),
        })),
      });
    }
  }
  // Сначала мастера, у кого прямо сейчас клиент, затем самые загруженные — простаивающие видны внизу
  masters.sort((a, b) => (b.now ? 1 : 0) - (a.now ? 1 : 0) || (b.load_pct ?? -1) - (a.load_pct ?? -1));
  if (lo >= hi) { lo = 9 * 60; hi = 22 * 60; }

  return {
    day, now: fmtMin(now),
    updated_at: new Date(Math.min(...lives.map(l => l.at))).toISOString(),
    range: { from: fmtMin(Math.floor(lo / 60) * 60), to: fmtMin(Math.min(1440, Math.ceil(hi / 60) * 60)) },
    tiles: {
      ...t, revenue_done: Math.round(t.revenue_done), revenue_expected: Math.round(t.revenue_expected),
      avg_check: doneClients.size ? Math.round(t.revenue_done / doneClients.size) : 0,
    },
    masters,
    ...(warnings.length ? { warnings } : {}),
  };
}

// --- Ручные задачи ------------------------------------------------------------------

// Вставка ручной задачи — общая для кнопок «+ в задачи» (/api/tasks/manual) и «В обзвон» из
// окон мастера. Лежит здесь, а не в server.js, чтобы не замыкать импорты в кольцо.
// Такая задача не занимает дневной лимит и не снимается уборкой движка.
function addManualTask(clientId, { reason, addedBy }) {
  const client = db.prepare('SELECT id, name, branch FROM clients WHERE id = ?').get(Number(clientId));
  if (!client) return { notFound: true };
  // Уже висит задача по этому человеку — второй карточки не заводим, иначе админ
  // звонил бы дважды по одному поводу.
  const open = db.prepare(`SELECT id, type, status, COALESCE(source,'auto') AS source
                           FROM tasks WHERE client_id = ? AND status IN ('open','snoozed')
                           ORDER BY id DESC LIMIT 1`).get(client.id);
  if (open) return { already: true, task_id: open.id, source: open.source, type: open.type, name: client.name };
  const r = db.prepare(`INSERT INTO tasks (client_id, type, due_date, priority, status, reason, created_at, source, added_by)
                        VALUES (?, 'manual', date('now','localtime'), 1, 'open', ?, ?, 'manual', ?)`)
    .run(client.id, reason, new Date().toISOString(), addedBy || null);
  return { added: true, task_id: Number(r.lastInsertRowid), name: client.name };
}

const WEEKDAY = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const TIME_RE = /^\d{1,2}:\d{2}$/;

// «В обзвон» из окна мастера: ручная задача с причиной «Окно у … Предложить запись.»
function createWindowTask({ client_id, staff, day, from, to } = {}) {
  staff = cleanName(staff);
  if (!staff) throw err('Не указан мастер');
  if (!DAY_RE.test(String(day || ''))) throw err('Некорректный день');
  if (!TIME_RE.test(String(from || '')) || !TIME_RE.test(String(to || ''))) throw err('Некорректное время окна');
  const [, mm, dd] = day.split('-');
  const wd = WEEKDAY[new Date(day + 'T12:00:00Z').getUTCDay()];
  const reason = `Окно у ${staff}: ${wd} ${dd}.${mm} ${from}–${to}. Предложить запись.`;
  const res = addManualTask(client_id, { reason, addedBy: 'Управляющая' });
  if (res.notFound) throw err('Клиент не найден', 404);
  return { ok: true, ...(res.already ? { already: true } : { added: true }), task_id: res.task_id, name: res.name };
}

module.exports = {
  summary, windows, today, invalidate, computeGaps, createWindowTask, addManualTask,
  refreshStaff, ensureSchedule, directionOf,
};
