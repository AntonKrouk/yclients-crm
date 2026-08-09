'use strict';

const { db } = require('./db');
const people = require('./people');

const DAY = 86400000;
const today = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / DAY);

// Настройки логики (можно вынести в env позже)
const DAILY_OPEN_TARGET = 10;     // держим не больше N открытых задач на филиал: невыполненные висят, новые догружаются до N
const FREQUENT_DAYS = 31;         // «частый» клиент = ходит не реже раза в месяц, ему приоритет в очереди
const REBOOK_GRACE_DAYS = 3;      // «пора записаться» = прошёл прогноз + N дней
const REBOOK_MAX_OVERDUE = 60;    // если просрочка больше — это уже реактивация, не рутинный дозвон
const CHURN_MULTIPLIER = 2;       // «уходящий» = не был дольше 2× средней периодичности
const NO_SHOW_RECENT_DAYS = 30;   // неявку зовём перезаписывать только если она свежая
const CHURN_MAX_DAYS = 180;       // не был дольше — считаем потерянным, задачу не создаём (не заваливаем список)
const REACTIVATION_MIN_VISITS = 2; // реактивируем только тех, кто ходил не разово

// Не создаём дубль: если по клиенту уже есть открытая/отложенная задача такого типа
const hasOpen = db.prepare(
  `SELECT 1 FROM tasks WHERE client_id = ? AND type = ? AND status IN ('open','snoozed') LIMIT 1`
);
const insertTask = db.prepare(`
  INSERT INTO tasks (client_id, type, due_date, priority, status, reason, created_at)
  VALUES (?,?,?,?,'open',?, ?)
`);

// Порядок обхода типов при заполнении дневных слотов. Слоты раздаются ЧЕРЕДОВАНИЕМ:
// по одному кандидату каждого типа по кругу, пока лимит не исчерпан. Иначе список админа
// забивали бы неявки (их всегда хватает), а «пора записать» и реактивация не доходили бы
// до звонка вовсе. Порядок внутри круга = приоритет: свежая неявка важнее рутинной записи.
const TYPE_ORDER = ['no_show', 'rebook', 'reactivation'];

function generate() {
  const nowIso = new Date().toISOString();

  // «Подтвердить визит» больше не создаём (админы подтверждают записи сами) — снимаем висящие
  db.prepare(`UPDATE tasks SET status='dismissed', closed_at=? WHERE type='confirm_visit' AND status IN ('open','snoozed')`)
    .run(nowIso);

  // Клиенты с пометкой «не беспокоить» в комментарии YClients — снимаем их открытые задачи
  db.prepare(`UPDATE tasks SET status='dismissed', closed_at=?
              WHERE status IN ('open','snoozed')
                AND client_id IN (SELECT id FROM clients WHERE COALESCE(do_not_call,0)=1)`)
    .run(nowIso);

  // Отложенные «перезвонить завтра», чей срок настал, возвращаем в открытые ДО подсчёта слотов
  db.prepare(`UPDATE tasks SET status='open' WHERE status='snoozed' AND due_date <= date('now')`).run();

  const clients = db.prepare(`
    SELECT id, name, phone, branch, last_visit, avg_interval_days, predicted_next, visits_count
    FROM clients WHERE COALESCE(do_not_call,0) = 0
  `).all();

  const upcomingByClient = db.prepare(`
    SELECT client_id, MIN(date) AS next_date
    FROM visits WHERE status = 'upcoming' AND date >= datetime('now')
    GROUP BY client_id
  `).all();
  const upMap = new Map(upcomingByClient.map(r => [r.client_id, r.next_date]));

  // --- Дедуп по филиалам: один человек ходит в оба филиала как ДВЕ карточки (разный
  // yclients_id, один телефон). Приоритетный филиал = где больше визитов; задачу ставим
  // только там, дубль в другом филиале подавляем. «Записан» считаем по ЛЮБОМУ филиалу.
  // Группировка общая с конструктором и карточкой клиента — см. src/people.js.
  const suppressed = new Set();      // id неприоритетных дублей — задачи не ставим
  const personBooked = new Set();    // id приоритетного, если человек записан в каком-то филиале
  for (const arr of people.groupByPerson(clients)) {
    if (arr.length < 2) continue;
    for (let i = 1; i < arr.length; i++) suppressed.add(arr[i].id);
    if (arr.some(c => upMap.has(c.id))) personBooked.add(arr[0].id);
  }

  const dismissFor = (ids) => {
    const CH = 400;
    let n = 0;
    for (let i = 0; i < ids.length; i += CH) {
      const part = ids.slice(i, i + CH);
      n += db.prepare(`UPDATE tasks SET status='dismissed', closed_at=?
                       WHERE status IN ('open','snoozed') AND client_id IN (${part.map(() => '?').join(',')})`)
        .run(nowIso, ...part).changes;
    }
    return n;
  };

  // Снимаем ранее созданные задачи по неприоритетным дублям (чтобы не висели после включения дедупа)
  if (suppressed.size) dismissFor([...suppressed]);

  // Клиент записался (сам, через админа или из дашборда) — снимаем висящие задачи «позвонить
  // и записать». Создание новых мы и так пропускаем ниже, но уже открытые надо закрыть, иначе
  // админ звонит человеку, который сидит в журнале на следующей неделе.
  const booked = [...new Set([...upMap.keys(), ...personBooked])];
  if (booked.length) {
    const n = dismissFor(booked);
    if (n) console.log(`[rules] снято задач по уже записавшимся клиентам: ${n}`);
  }

  const lastNoShow = db.prepare(`
    SELECT client_id, MAX(date) AS d FROM visits WHERE status = 'no_show' GROUP BY client_id
  `).all();
  const noShowMap = new Map(lastNoShow.map(r => [r.client_id, r.d]));

  const now = today();
  const candidates = [];

  for (const c of clients) {
    if (suppressed.has(c.id)) continue;                 // дубль в неприоритетном филиале
    if (upMap.get(c.id) || personBooked.has(c.id)) continue; // записан в этом или другом филиале

    const frequent = c.avg_interval_days != null && c.avg_interval_days <= FREQUENT_DAYS ? 1 : 0;
    const base = { clientId: c.id, branch: c.branch || '', frequent, visits: c.visits_count || 0 };

    // 1) Свежая неявка без последующей записи → перезаписать (старые неявки не трогаем — это шум)
    const ns = noShowMap.get(c.id);
    if (ns && daysBetween(ns, now) <= NO_SHOW_RECENT_DAYS) {
      candidates.push({ ...base, type: 'no_show', priority: 1,
        reason: `Не пришёл ${new Date(ns).toLocaleDateString('ru-RU')}. Позвонить, перезаписать.` });
      continue;
    }

    if (!c.last_visit || !c.avg_interval_days) continue;

    const sinceLast = daysBetween(c.last_visit, now);
    const overdue = c.predicted_next ? daysBetween(c.predicted_next, now) : null;

    // 2) Уходящий клиент (пропал недавно, но не совсем потерян) → реактивация
    if (sinceLast > c.avg_interval_days * CHURN_MULTIPLIER
        && sinceLast <= CHURN_MAX_DAYS
        && c.visits_count >= REACTIVATION_MIN_VISITS) {
      candidates.push({ ...base, type: 'reactivation', priority: 2,
        reason: `Не был ${sinceLast} дн. при норме ~${Math.round(c.avg_interval_days)} дн. Реактивация: узнать, всё ли ок, вернуть.` });
      continue;
    }

    // 3) Пора записаться (прошёл прогноз next + grace, но ещё не «ушёл»)
    if (overdue !== null && overdue >= REBOOK_GRACE_DAYS && overdue <= REBOOK_MAX_OVERDUE) {
      candidates.push({ ...base, type: 'rebook', priority: 2,
        reason: `Обычно ходит раз в ~${Math.round(c.avg_interval_days)} дн., пора уже ${overdue} дн. назад. Позвонить, записать.` });
    }
  }

  // Очереди кандидатов: филиал → тип. Внутри типа порядок прежний — сперва «частые»
  // (ходят раз в месяц и чаще), затем по числу визитов.
  const byBranch = new Map();
  for (const cand of candidates) {
    if (!byBranch.has(cand.branch)) byBranch.set(cand.branch, new Map(TYPE_ORDER.map(t => [t, []])));
    byBranch.get(cand.branch).get(cand.type).push(cand);
  }

  // Свободные слоты по филиалам: цель — DAILY_OPEN_TARGET открытых задач на филиал
  const openBy = new Map(db.prepare(`
    SELECT COALESCE(c.branch,'') AS b, COUNT(*) AS n
    FROM tasks t JOIN clients c ON c.id = t.client_id
    WHERE t.status = 'open' GROUP BY COALESCE(c.branch,'')
  `).all().map(r => [r.b, r.n]));

  let created = 0;
  for (const [branch, queues] of byBranch) {
    for (const q of queues.values()) {
      q.sort((a, b) => (b.frequent - a.frequent) || (b.visits - a.visits));
    }
    let open = openBy.get(branch) || 0;
    // Круг за кругом берём по одному кандидату каждого типа. Пустой тип пропускаем —
    // его слоты достаются остальным, так что лимит заполняется всегда, если есть кого звать.
    while (open < DAILY_OPEN_TARGET) {
      let tookAny = false;
      for (const type of TYPE_ORDER) {
        if (open >= DAILY_OPEN_TARGET) break;
        const q = queues.get(type);
        while (q.length) {
          const cand = q.shift();
          if (hasOpen.get(cand.clientId, cand.type)) continue; // задача такого типа уже висит
          insertTask.run(cand.clientId, cand.type, today(), cand.priority, cand.reason, nowIso);
          open++; created++; tookAny = true;
          break;
        }
      }
      if (!tookAny) break; // кандидаты кончились раньше, чем слоты
    }
    openBy.set(branch, open);
  }

  return created;
}

module.exports = { generate };
