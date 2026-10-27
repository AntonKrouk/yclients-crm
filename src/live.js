'use strict';

// Мгновенные обновления. Два звена:
//  1) YClients → сервер: вебхук сообщает, что в журнале что-то поменялось (новая запись, отмена,
//     закрытый визит). Раньше мы узнавали об этом только плановым синком раз в 30 минут.
//  2) Сервер → открытые экраны: «толчок» по Server-Sent Events. Раньше экран сам переспрашивал
//     сервер раз в 45 секунд, «Салон» — только по кнопке.
//
// Вебхуку на слово не верим: из него берём только «какой филиал» и «какая запись», а саму запись
// перечитываем из YClients по API. Поддельный запрос максимум заставит нас лишний раз сходить
// в YClients — поэтому адрес обходится без секрета, а поток подделок режется лимитом.

const { db } = require('./db');
const yc = require('./yclients');
const sync = require('./sync');
const rules = require('./rules');
const salon = require('./salon');

// --- Открытые экраны --------------------------------------------------------------------
const screens = new Set();
const HEARTBEAT_MS = 25e3;   // nginx закрывает молчащее соединение через 60 с — шлём комментарий-пинг

function subscribe(req, res) {
  res.set({
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive',
    // без этого nginx копит ответ в буфере, и толчки доходят до экрана пачкой раз в минуту
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 5000\n\n');   // оборвалась связь — браузер переподключится сам через 5 с
  const screen = { res };
  screens.add(screen);
  req.on('close', () => screens.delete(screen));
}
setInterval(() => { for (const s of screens) s.res.write(': ping\n\n'); }, HEARTBEAT_MS).unref();

// type: 'crm' — изменение через CRM (звонок, задача, список), 'yc' — журнал YClients,
// 'tasks' — движок пересобрал задачи. Данных клиентов в толчке нет: экран сам перечитает то,
// что ему положено видеть, со своими правами.
function emit(type, data = {}) {
  const msg = `event: change\ndata: ${JSON.stringify({ type, ...data, at: Date.now() })}\n\n`;
  for (const s of screens) s.res.write(msg);
}

// --- Вебхук YClients ----------------------------------------------------------------------
// Формат тела у YClients — { company_id, resource: 'record', resource_id, status: 'create' |
// 'update' | 'delete', data }; на случай пачки или другой обёртки разбираем осторожно.
function eventsOf(body) {
  const list = Array.isArray(body) ? body
    : body && Array.isArray(body.data) && !body.resource ? body.data
    : [body];
  return list.filter(e => e && typeof e === 'object').map(e => ({
    company_id: Number(e.company_id ?? e.companyId ?? e.data?.company_id) || null,
    resource: String(e.resource ?? e.type ?? '').toLowerCase(),
    resource_id: Number(e.resource_id ?? e.resourceId ?? e.data?.id) || null,
    status: String(e.status ?? e.event ?? '').toLowerCase(),
  }));
}

const RATE_MAX = 600;                  // событий в минуту — настоящий салон столько не делает
let rateFrom = 0, rateN = 0, rateWarned = false;
const stats = { last_at: null, total: 0, first_logged: false };
const queue = new Map();               // id записи → { cid, branch }
let draining = false;

function handleWebhook(body, { key } = {}) {
  // Необязательный ключ: если YC_WEBHOOK_KEY задан, без него запросы не принимаем
  const need = process.env.YC_WEBHOOK_KEY || '';
  if (need && key !== need) return { ok: false, status: 403 };

  const t = Date.now();
  if (t - rateFrom > 60e3) { rateFrom = t; rateN = 0; rateWarned = false; }
  const events = eventsOf(body);
  rateN += events.length;
  if (rateN > RATE_MAX) {
    if (!rateWarned) { console.warn(`[webhook] больше ${RATE_MAX} событий за минуту — лишние пропускаю`); rateWarned = true; }
    return { ok: true, skipped: 'rate' };
  }
  // Один раз за запуск пишем, как выглядит тело: формат YClients может отличаться от ожидаемого.
  // Только ключи и тип события — без данных клиентов.
  if (!stats.first_logged) {
    stats.first_logged = true;
    console.log('[webhook] первое событие: ключи', Object.keys(body || {}).join(','),
      '→', JSON.stringify(events.map(e => [e.resource, e.status, e.company_id])).slice(0, 200));
  }

  const known = new Map(yc.companies().map(c => [Number(c.id), c.name || String(c.id)]));
  const touched = new Set();
  for (const e of events) {
    if (!known.has(e.company_id)) continue;           // чужой филиал или мусор
    stats.total++; stats.last_at = new Date(t).toISOString();
    salon.invalidate(e.company_id);                    // «Сегодня» и окна перечитают журнал
    touched.add(e.company_id);
    if (/record/.test(e.resource) && e.resource_id && queue.size < 500) {
      queue.set(e.resource_id, { cid: e.company_id, branch: known.get(e.company_id) });
    }
  }
  // Толкаем сразу: живые экраны («Сегодня», окна) берут журнал из YClients и обновятся уже сейчас
  for (const cid of touched) emit('yc', { company_id: cid });
  if (queue.size) drain();
  return { ok: true, accepted: touched.size };
}

// Записи — в нашу базу (по одной, через API): от них зависят задачи, «Обзор» и сводка «Салона».
async function drain() {
  if (draining) return;
  draining = true;
  const touched = new Set();
  try {
    while (queue.size) {
      const [id, job] = queue.entries().next().value;
      queue.delete(id);
      touched.add(job.cid);
      try {
        await sync.importRecord(job.cid, job.branch, id);
      } catch (e) {
        // Записи в YClients больше нет — значит, удалили. Подделка сюда не пройдёт:
        // отмену ставим только по ответу самого YClients, а не по слову вебхука.
        if (/→ 404/.test(e.message)) db.prepare("UPDATE visits SET status='cancelled' WHERE yclients_record_id = ?").run(id);
        else console.error(`[webhook] запись ${id} не перечитана:`, e.message);
      }
    }
  } finally { draining = false; }
  for (const cid of touched) emit('yc', { company_id: cid, stage: 'db' });
  scheduleMaintenance();
}

// Записался сам — задача на звонок ему больше не нужна. Та же уборка, что у синка раз в 30 минут,
// только сразу; пачку событий собираем в один проход.
let maintTimer = null;
function scheduleMaintenance() {
  clearTimeout(maintTimer);
  maintTimer = setTimeout(() => {
    try {
      rules.generate({ fill: false });
      sync.recomputeAutoBooked();
      emit('tasks');
    } catch (e) { console.error('[webhook] уборка задач не прошла:', e.message); }
  }, 15e3);
  maintTimer.unref();
}

const webhookInfo = () => ({ last_at: stats.last_at, total: stats.total });

module.exports = { subscribe, emit, handleWebhook, webhookInfo, eventsOf };
