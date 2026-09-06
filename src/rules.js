'use strict';

const { db, MANUAL_LISTS } = require('./db');
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

// Пауза после звонка. Без неё обработанный клиент возвращался в список на СЛЕДУЮЩЕМ ЖЕ
// прогоне генерации (кнопка «Обновить», крон каждые 30 мин): задача уходит в статус done,
// а причина — неявка или просрочка записи — никуда не девается, и человек снова первый
// в очереди. Админы видели, как разобранный список тут же наполняется теми же людьми.
// Теперь звонок «закрывает» клиента на срок ниже — и по ВСЕМ его карточкам (Басков +
// Мытнинская), чтобы второй филиал не звонил следом.
const CALL_COOLDOWN_DAYS = { no_show: 14, rebook: 14, reactivation: 60 };
const REFUSAL_COOLDOWN_DAYS = 90; // «Отказ» — разговор состоялся, повторять его скоро незачем
const NO_CALLS_COOLDOWN_DAYS = 60; // «Просил не звонить» — пауза, но не навсегда
const DEFAULT_COOLDOWN_DAYS = 14;

// Сколько дней после первого визита ещё берём человека в фоллоу-ап. Пишем на СЛЕДУЮЩИЙ
// день, но окно шире суток — чтобы не потерять тех, у кого утренний синк в свой день
// не отработал (сеть, перезапуск, выходной сервера).
const NEW_CLIENT_MAX_DAYS = 7;

// Задачи, добавленные администратором вручную (кнопка «+ в задачи» в «Клиентах» и
// «Конструкторе»), живут по своим правилам: не занимают дневной лимит и не снимаются
// автоматической уборкой. Человека выбрали осознанно — карточка висит, пока по ней не позвонят.
const NOT_MANUAL   = "COALESCE(source,'auto') <> 'manual'";

// Ровно те же правила — у фоллоу-апа новому клиенту: он не часть дневной нормы звонков и
// не снимается автоматикой (записался сам, попал в список обзвона, ушёл в VIP — неважно,
// написать ему всё равно надо). Карточка висит, пока админ не отметит, что написал.
// Всё, что НЕ подпадает под эти два случая, движок считает своим и волен убирать.
const ENGINE_OWNED   = "COALESCE(source,'auto') <> 'manual' AND type <> 'new_client'";
const ENGINE_OWNED_T = "COALESCE(t.source,'auto') <> 'manual' AND t.type <> 'new_client'";

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

// opts.fill = false — режим обслуживания: снять отработанное и неактуальное, но НЕ добирать
// новых кандидатов. Набор задач формируется РАЗ В ДЕНЬ утренним синком: иначе список весь
// день держался бы ровно на десяти, и админ, разобрав его, тут же получал бы новую партию.
function generate(opts = {}) {
  const fill = opts.fill !== false;
  const nowIso = new Date().toISOString();

  // «Подтвердить визит» больше не создаём (админы подтверждают записи сами) — снимаем висящие
  db.prepare(`UPDATE tasks SET status='dismissed', closed_at=? WHERE type='confirm_visit' AND status IN ('open','snoozed')`)
    .run(nowIso);

  // Клиенты с пометкой «не беспокоить» в комментарии YClients — снимаем их открытые задачи
  db.prepare(`UPDATE tasks SET status='dismissed', closed_at=?
              WHERE status IN ('open','snoozed') AND ${NOT_MANUAL}
                AND client_id IN (SELECT id FROM clients WHERE COALESCE(do_not_call,0)=1)`)
    .run(nowIso);

  // Отложенные «перезвонить», чей срок ПРОШЁЛ, возвращаем в открытые ДО подсчёта слотов.
  // Отложенные на сегодня не трогаем: дашборд и так показывает их в списке задач
  // отдельной красной карточкой («перезвонить в 18:00»).
  db.prepare(`UPDATE tasks SET status='open'
              WHERE status='snoozed' AND date(due_date) < date('now','localtime')`).run();

  // Клиентов из ручных списков (VIP, «Депозит», «Алиса») ведут персонально — в автоматический
  // обзвон они не попадают. Исключаем и вторую карточку того же человека (в соседнем филиале),
  // иначе он вернулся бы оттуда. В выборках конструктора такие клиенты, наоборот, видны:
  // ручной обзвон по ним админ решает сам, а вот задачу движок ставить не должен.
  const manualIds = new Set();
  for (const table of Object.values(MANUAL_LISTS)) {
    for (const r of db.prepare(`SELECT client_id FROM ${table}`).all()) manualIds.add(r.client_id);
  }

  // Клиенты, стоящие в очереди списка-кампании обзвона. Звонок по ним уже спланирован и
  // лежит во вкладке «Обзвон»: автоматическая задача на того же человека — это второй
  // звонок по тому же поводу, один админ звонил бы по списку, другой по задачам.
  // В отличие от VIP это НЕ навсегда: считаем только активные списки и строки, по которым
  // ещё не отзвонились. Отработали строку или список ушёл в архив — человек возвращается
  // в обычный оборот, уже под обычной паузой после звонка (cooldownLeft ниже).
  const queuedIds = new Set(db.prepare(`
    SELECT m.client_id FROM list_members m JOIN lists l ON l.id = m.list_id
    WHERE l.status = 'active' AND m.status IN ('pending','snoozed')
  `).all().map(r => r.client_id));

  const clients = db.prepare(`
    SELECT id, name, phone, branch, first_visit, last_visit, avg_interval_days, predicted_next,
           visits_count, favorite_staff
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
  // Последний звонок по каждой карточке. Сюда пишутся и задачи, и списки обзвона
  // (у списков task_id = NULL) — для паузы это одинаково «мы уже говорили с человеком».
  const lastCall = new Map();
  for (const r of db.prepare(`
    SELECT a.client_id, a.created_at, a.result FROM task_actions a
    WHERE a.created_at = (SELECT MAX(b.created_at) FROM task_actions b WHERE b.client_id = a.client_id)
  `).all()) {
    const prev = lastCall.get(r.client_id);
    if (!prev || r.created_at > prev.at) lastCall.set(r.client_id, { at: r.created_at, result: r.result });
  }

  const suppressed = new Set();      // id неприоритетных дублей — задачи не ставим
  const personBooked = new Set();    // id приоритетного, если человек записан в каком-то филиале
  const personCall = new Map();      // id карточки → последний звонок ЧЕЛОВЕКУ (по всем филиалам)
  const manualPerson = new Set();    // все карточки человека, попавшего хотя бы в один ручной список
  const queuedPerson = new Set();    // все карточки человека, ждущего звонка в активном списке обзвона
  const groups = people.groupByPerson(clients);
  for (const arr of groups) {
    let call = null;
    for (const c of arr) {
      const own = lastCall.get(c.id);
      if (own && (!call || own.at > call.at)) call = own;
    }
    if (call) for (const c of arr) personCall.set(c.id, call);
    if (arr.some(c => manualIds.has(c.id))) for (const c of arr) manualPerson.add(c.id);
    if (arr.some(c => queuedIds.has(c.id))) for (const c of arr) queuedPerson.add(c.id);

    if (arr.length < 2) continue;
    for (let i = 1; i < arr.length; i++) suppressed.add(arr[i].id);
    if (arr.some(c => upMap.has(c.id))) personBooked.add(arr[0].id);
  }

  // Сколько дней паузы после звонка ещё не вышло (0 = можно звать снова).
  // Визит после звонка обнуляет паузу: человек в салоне побывал, дальше работаем как обычно.
  const cooldownLeft = (client, type) => {
    const call = personCall.get(client.id);
    if (!call) return 0;
    if (client.last_visit && new Date(client.last_visit) > new Date(call.at)) return 0;
    const need = call.result === 'refused' ? REFUSAL_COOLDOWN_DAYS
      : call.result === 'no_calls' ? NO_CALLS_COOLDOWN_DAYS   // «просил не звонить» — пауза
      : (CALL_COOLDOWN_DAYS[type] || DEFAULT_COOLDOWN_DAYS);
    return Math.max(0, need - daysBetween(call.at.slice(0, 10), today()));
  };

  const dismissFor = (ids) => {
    const CH = 400;
    let n = 0;
    for (let i = 0; i < ids.length; i += CH) {
      const part = ids.slice(i, i + CH);
      n += db.prepare(`UPDATE tasks SET status='dismissed', closed_at=?
                       WHERE status IN ('open','snoozed') AND ${ENGINE_OWNED}
                         AND client_id IN (${part.map(() => '?').join(',')})`)
        .run(nowIso, ...part).changes;
    }
    return n;
  };

  // Снимаем ранее созданные задачи по неприоритетным дублям (чтобы не висели после включения дедупа)
  if (suppressed.size) dismissFor([...suppressed]);

  // Клиента добавили в ручной список — его задачи снимаем сразу, не дожидаясь звонка
  if (manualPerson.size) {
    const n = dismissFor([...manualPerson]);
    if (n) console.log(`[rules] снято задач по клиентам из ручных списков: ${n}`);
  }

  // Клиента поставили в очередь обзвона — задачи по нему снимаем: звонок теперь ведётся
  // по списку. Маршруты создания списка делают то же самое сразу, здесь подстраховка на
  // случай, когда строка появилась мимо них (перенос базы, ручная правка, старые списки).
  if (queuedPerson.size) {
    const n = dismissFor([...queuedPerson]);
    if (n) console.log(`[rules] снято задач по клиентам из списков обзвона: ${n}`);
  }

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

  // Клиенты, которых админ уже добавил в задачи вручную: движок их не дублирует —
  // иначе на одного человека висели бы две карточки, ручная и автоматическая.
  const manualOpen = new Set(db.prepare(
    `SELECT client_id FROM tasks WHERE status IN ('open','snoozed') AND COALESCE(source,'auto') = 'manual'`
  ).all().map(r => r.client_id));

  const now = today();
  const candidates = [];

  for (const c of clients) {
    if (suppressed.has(c.id)) continue;                 // дубль в неприоритетном филиале
    if (manualOpen.has(c.id)) continue;                 // админ уже добавил его в задачи руками
    if (manualPerson.has(c.id)) continue;               // VIP / «Депозит» / «Алиса» ведут вручную
    if (queuedPerson.has(c.id)) continue;               // уже ждёт звонка в списке обзвона
    if (upMap.get(c.id) || personBooked.has(c.id)) continue; // записан в этом или другом филиале

    const frequent = c.avg_interval_days != null && c.avg_interval_days <= FREQUENT_DAYS ? 1 : 0;
    const base = { clientId: c.id, branch: c.branch || '', frequent, visits: c.visits_count || 0 };

    // 1) Свежая неявка без последующей записи → перезаписать (старые неявки не трогаем — это шум)
    const ns = noShowMap.get(c.id);
    if (ns && daysBetween(ns, now) <= NO_SHOW_RECENT_DAYS) {
      // continue в любом случае: если по неявке пауза — не подсовываем этого же человека
      // под другим предлогом (реактивация/пора записать), это тот же звонок.
      if (!cooldownLeft(c, 'no_show')) {
        candidates.push({ ...base, type: 'no_show', priority: 1,
          reason: `Не пришёл ${new Date(ns).toLocaleDateString('ru-RU')}. Позвонить, перезаписать.` });
      }
      continue;
    }

    if (!c.last_visit || !c.avg_interval_days) continue;

    const sinceLast = daysBetween(c.last_visit, now);
    const overdue = c.predicted_next ? daysBetween(c.predicted_next, now) : null;

    // 2) Уходящий клиент (пропал недавно, но не совсем потерян) → реактивация
    if (sinceLast > c.avg_interval_days * CHURN_MULTIPLIER
        && sinceLast <= CHURN_MAX_DAYS
        && c.visits_count >= REACTIVATION_MIN_VISITS) {
      if (!cooldownLeft(c, 'reactivation')) {
        candidates.push({ ...base, type: 'reactivation', priority: 2,
          reason: `Не был ${sinceLast} дн. при норме ~${Math.round(c.avg_interval_days)} дн. Реактивация: узнать, всё ли ок, вернуть.` });
      }
      continue;
    }

    // 3) Пора записаться (прошёл прогноз next + grace, но ещё не «ушёл»)
    if (overdue !== null && overdue >= REBOOK_GRACE_DAYS && overdue <= REBOOK_MAX_OVERDUE
        && !cooldownLeft(c, 'rebook')) {
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

  // Уборка последствий: задачи, СОЗДАННЫЕ ПОСЛЕ звонка, — это и есть вернувшиеся клиенты.
  // Снимаем их, пока пауза не вышла. Задачу, по которой звонок и был сделан (создана раньше
  // звонка), не трогаем, «перезвонить/не ответил» (snoozed) — тоже: там пауза задана админом.
  const clientById = new Map(clients.map(c => [c.id, c]));
  const stale = db.prepare(`SELECT id, client_id, type, created_at FROM tasks WHERE status='open' AND ${ENGINE_OWNED}`)
    .all()
    .filter(t => {
      const call = personCall.get(t.client_id);
      const c = clientById.get(t.client_id);
      return call && c && t.created_at > call.at && cooldownLeft(c, t.type) > 0;
    });
  if (stale.length) {
    const upd = db.prepare(`UPDATE tasks SET status='dismissed', closed_at=? WHERE id=?`);
    for (const t of stale) upd.run(nowIso, t.id);
    console.log(`[rules] снято вернувшихся задач по недавно обзвоненным: ${stale.length}`);
  }

  // Фоллоу-апы новым клиентам ставим ВСЕГДА, даже в промежуточных прогонах: они не занимают
  // дневной лимит, а задержка тут дороже — человека надо застать по свежим впечатлениям.
  const newbies = createNewClientTasks(groups, nowIso);

  // Промежуточные прогоны (синк будущего каждые 30 мин, кнопка «Обновить») на этом
  // заканчиваются: они убирают отработанное, но новых людей в обзвон не добавляют. Дневной
  // набор задач формирует утренний полный синк — он и вызывает generate() без опций.
  if (!fill) return newbies;

  // Свободные слоты по филиалам: цель — DAILY_OPEN_TARGET открытых задач на филиал
  const openBy = new Map(db.prepare(`
    SELECT COALESCE(c.branch,'') AS b, COUNT(*) AS n
    FROM tasks t JOIN clients c ON c.id = t.client_id
    WHERE t.status = 'open' AND ${ENGINE_OWNED_T} GROUP BY COALESCE(c.branch,'')
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

  return created + newbies;
}

// --- Новые клиенты: фоллоу-ап на следующий день после первого визита ----------
// Человек впервые побывал в салоне — назавтра администратор пишет ему сообщение:
// как всё прошло, всё ли понравилось, приглашение прийти снова. Это не звонок и не
// часть дневной нормы обзвона, поэтому задача создаётся вне слотов и вне пауз после
// звонков, а снять её может только сам админ, отметив «Написал».
//
// «Впервые» считаем по ПЕРВОМУ ЗАВЕРШЁННОМУ визиту человека, а не карточки: в YClients
// один человек заведён отдельной карточкой в каждом филиале, и визит на Мытнинской после
// давнего визита на Баскове — не первый. Поэтому берём группу карточек (см. people.js)
// и самую раннюю дату по ней.
//
// Оговорка: если ВСЯ история клиента старше загруженного окна визитов, он выглядит новым.
// База держит несколько лет, так что случай редкий, а цена ошибки — лишнее дружелюбное
// сообщение постоянному клиенту.
// Точка отсчёта раздела: день, когда он впервые отработал на сервере. Всем, кто побывал
// в салоне впервые ДО этой даты, админы фоллоу-ап уже написали руками — задним числом
// поднимать их не надо, иначе на выкате в списке разом окажется недельная пачка людей.
// Дата фиксируется в meta один раз и дальше не меняется (при необходимости её можно
// поправить руками: UPDATE meta SET value='YYYY-MM-DD' WHERE key='new_client_since').
function newClientSince() {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'new_client_since'").get();
  if (row && row.value) return row.value;
  const d = today();
  db.prepare("INSERT INTO meta(key,value) VALUES('new_client_since',?)").run(d);
  console.log(`[rules] раздел New включён с ${d} — первые визиты раньше этой даты не берём`);
  return d;
}

function createNewClientTasks(groups, nowIso) {
  // Один фоллоу-ап на человека за всю жизнь — проверяем задачи ЛЮБОГО статуса, иначе
  // отработанная (done) карточка вернулась бы следующим же прогоном.
  const everHad = new Set(
    db.prepare(`SELECT DISTINCT client_id FROM tasks WHERE type = 'new_client'`).all().map(r => r.client_id)
  );
  const now = today();
  const since = newClientSince();
  let created = 0;

  for (const arr of groups) {
    if (arr.some(c => everHad.has(c.id))) continue;

    // карточка того филиала, где человек побывал в первый раз — туда и ставим задачу
    const visited = arr.filter(c => c.first_visit);
    if (!visited.length) continue;
    const card = visited.reduce((a, b) => (a.first_visit <= b.first_visit ? a : b));

    const day = card.first_visit.slice(0, 10);
    if (day < since) continue;                            // был у нас до запуска раздела — ему уже написали
    const age = daysBetween(day, now);
    if (age < 1 || age > NEW_CLIENT_MAX_DAYS) continue;   // сегодняшних ещё рано, старых уже поздно

    const when = new Date(card.first_visit).toLocaleDateString('ru-RU');
    const staff = card.favorite_staff ? `, мастер ${card.favorite_staff}` : '';
    insertTask.run(card.id, 'new_client', now, 1,
      `Первый визит ${when}${staff}. Написать фоллоу-ап: как всё прошло, пригласить снова.`, nowIso);
    created++;
  }
  if (created) console.log(`[rules] фоллоу-апов новым клиентам создано: ${created}`);
  return created;
}

// Фиксируем точку отсчёта сразу при старте сервера, а не при первом прогоне генерации:
// иначе выкат вечером, а первый синк утром — и те, кто пришёл в день выката, пропали бы.
newClientSince();

module.exports = { generate };
