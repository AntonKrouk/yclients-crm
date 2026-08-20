'use strict';

// Результативность обзвона: вернулись ли клиенты после звонка и сколько принесли.
//
// Главная ловушка такой оценки — считать «пришёл после звонка» как «пришёл благодаря
// звонку». Часть клиентов вернулась бы и сама. Поэтому здесь ДВЕ группы:
//   ПОЗВОНИЛИ  — движок поставил задачу, админ позвонил и отметил результат;
//   НЕ ЗВОНИЛИ — движок поставил задачу, но до клиента не дошли.
// Обе группы отобраны одним и тем же движком по одним и тем же правилам, то есть
// сопоставимы. Разница в доле вернувшихся — и есть вклад программы.
//
// Запуск на сервере:  node tools/effect.js [дней_назад] [окно_возврата]
// По умолчанию: смотрим на 90 дней назад, возврат засчитываем в течение 30 дней.

require('../src/env');
const { db } = require('../src/db');

const BACK = Number(process.argv[2]) || 90;   // за какой период берём задачи и звонки
const WINDOW = Number(process.argv[3]) || 30; // сколько дней даём клиенту на возврат

const rub = (n) => Math.round(n || 0).toLocaleString('ru-RU') + ' ₽';
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0) + '%';

// Визит после момента t0, но не позже t0 + WINDOW дней. Считаем только состоявшиеся:
// запись, на которую не пришли, деньгами не является.
const visitAfter = db.prepare(`
  SELECT COUNT(*) n, COALESCE(SUM(cost), 0) sum
  FROM visits
  WHERE client_id = ? AND status = 'completed'
    AND date > ? AND date <= datetime(?, '+${WINDOW} days')`);

function measure(rows, label) {
  let returned = 0, revenue = 0;
  for (const r of rows) {
    const v = visitAfter.get(r.client_id, r.t0, r.t0);
    if (v.n > 0) { returned++; revenue += v.sum; }
  }
  return { label, people: rows.length, returned, revenue };
}

function line(g) {
  if (!g.people) return `${g.label.padEnd(22)} — нет данных`;
  return `${g.label.padEnd(22)} ${String(g.people).padStart(5)} чел. → вернулись ${String(g.returned).padStart(5)} (${pct(g.returned, g.people).padStart(4)}), выручка ${rub(g.revenue)}`;
}

console.log(`\nПериод: последние ${BACK} дн. Возврат засчитывается в течение ${WINDOW} дн. после звонка.\n`);

// --- Группа «позвонили»: берём ПЕРВЫЙ звонок клиенту за период ---
const called = db.prepare(`
  SELECT client_id, MIN(created_at) t0
  FROM task_actions
  WHERE created_at >= datetime('now', '-${BACK} days')
  GROUP BY client_id`).all();

// --- Группа «не звонили»: задача была, отметки звонка не появилось ---
const uncalled = db.prepare(`
  SELECT client_id, MIN(created_at) t0
  FROM tasks
  WHERE created_at >= datetime('now', '-${BACK} days')
    AND client_id NOT IN (SELECT DISTINCT client_id FROM task_actions)
  GROUP BY client_id`).all();

const A = measure(called, 'Позвонили');
const B = measure(uncalled, 'Не звонили (контроль)');

console.log('=== ГЛАВНОЕ ===');
console.log(line(A));
console.log(line(B));

if (A.people && B.people) {
  const lift = (A.returned / A.people) - (B.returned / B.people);
  const extra = Math.round(A.people * lift);
  console.log(`\nРазница в возврате: ${(lift * 100).toFixed(1)} п.п.`);
  if (lift > 0) {
    const perHead = A.returned ? A.revenue / A.returned : 0;
    console.log(`То есть обзвон вернул примерно ${extra} чел. сверх тех, кто пришёл бы сам,`);
    console.log(`и принёс порядка ${rub(extra * perHead)} за период.`);
  } else {
    console.log('Обзвон пока не даёт прироста возврата — вернувшихся не больше, чем в контроле.');
  }
}

// --- Разбивка по результату звонка: что на самом деле работает ---
console.log('\n=== ПО РЕЗУЛЬТАТУ ЗВОНКА ===');
const RES = { booked: 'Записал', coming: 'Придёт', callback: 'Перезвонить',
  no_answer: 'Не ответил', refused: 'Отказ', no_calls: 'Просил не звонить', done: 'Обработан' };
for (const [key, name] of Object.entries(RES)) {
  const rows = db.prepare(`
    SELECT client_id, MIN(created_at) t0 FROM task_actions
    WHERE result = ? AND created_at >= datetime('now', '-${BACK} days')
    GROUP BY client_id`).all(key);
  if (rows.length) console.log(line(measure(rows, name)));
}

// --- По типу задачи: за кем возвращаться выгоднее ---
console.log('\n=== ПО ТИПУ ЗАДАЧИ ===');
const TYPES = { rebook: 'Пора записать', reactivation: 'Реактивация',
  no_show: 'Не пришёл', confirm_visit: 'Подтвердить визит', manual: 'Добавлен вручную' };
for (const [key, name] of Object.entries(TYPES)) {
  const rows = db.prepare(`
    SELECT ta.client_id, MIN(ta.created_at) t0
    FROM task_actions ta JOIN tasks t ON t.id = ta.task_id
    WHERE t.type = ? AND ta.created_at >= datetime('now', '-${BACK} days')
    GROUP BY ta.client_id`).all(key);
  if (rows.length) console.log(line(measure(rows, name)));
}

// --- По администраторам ---
console.log('\n=== ПО АДМИНИСТРАТОРАМ ===');
const admins = db.prepare(`
  SELECT COALESCE(admin, '(не указан)') a, COUNT(*) n
  FROM task_actions WHERE created_at >= datetime('now', '-${BACK} days')
  GROUP BY a ORDER BY n DESC`).all();
for (const { a } of admins) {
  const rows = db.prepare(`
    SELECT client_id, MIN(created_at) t0 FROM task_actions
    WHERE COALESCE(admin,'(не указан)') = ? AND created_at >= datetime('now', '-${BACK} days')
    GROUP BY client_id`).all(a);
  console.log(line(measure(rows, a)));
}

console.log(`
Оговорки, без которых цифры врут:
— Считаем по карточкам YClients. У человека с карточками в двух филиалах визит
  засчитается только по той карточке, которой звонили.
— Группы сопоставимы, но не рандомизированы: админы могли звонить сначала тем,
  кто и так вернее вернётся. Это завышает эффект обзвона.
— «Выручка» — суммы визитов за окно, без вычета себестоимости.
`);
