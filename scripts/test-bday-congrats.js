'use strict';

// Локальная проверка правила «поздравить с ДР». Пишет во временную базу, прод не трогает.
// Запуск: node scripts/test-bday-congrats.js

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-bday-'));
process.env.DATA_DIR = dir;

const { db } = require('../src/db');
const people = require('../src/people');
const { generate, createBdayCongratsTasks, lastBirthdayOnOrBefore } = require('../src/rules');

const mskToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
const shift = (ymd, days) => {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const isoAt = (ymd, h = 12) => `${ymd}T${String(h).padStart(2, '0')}:00:00.000Z`;

const today = mskToday();
const bday = shift(today, -3); // ДР был 3 дня назад
const birth = `1990-${bday.slice(5)}`;

const insertClient = db.prepare(`
  INSERT INTO clients (yclients_id, company_id, branch, name, phone, birth_date, visits_count, updated_at)
  VALUES (?,?,?,?,?,?,?,?)
`);
const insertVisit = db.prepare(`
  INSERT INTO visits (yclients_record_id, client_id, company_id, branch, date, service, staff, cost, status, booked_at, kind)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)
`);

let yc = 1, rec = 1;
function addClient(name, phone, birthDate) {
  const id = insertClient.run(yc++, 1, 'Басков', name, phone, birthDate, 3, new Date().toISOString()).lastInsertRowid;
  return id;
}
function addVisit(clientId, { day, bookedDay, status = 'upcoming', kind = 'visit', service = 'Маникюр' }) {
  insertVisit.run(rec++, clientId, 1, 'Басков', isoAt(day), service, 'Мастер', 1000, status,
    isoAt(bookedDay || day, 10), kind);
}

const pass = [];
const fail = [];
function check(name, cond) {
  (cond ? pass : fail).push(name);
  console.log((cond ? 'OK  ' : 'FAIL') + ' ' + name);
}

// 1) хелпер даты рождения
check('lastBirthday: ДР 3 дня назад', lastBirthdayOnOrBefore(birth, today) === bday);
check('lastBirthday: 29 фев → 28 в невисокосный',
  lastBirthdayOnOrBefore('2000-02-29', '2025-03-01') === '2025-02-28');

// 2) основной кейс: не был в ДР, записался после → задача есть
const a = addClient('Анна Ок', '79001110001', birth);
addVisit(a, { day: shift(bday, 2), bookedDay: shift(bday, 2) });
const groups = people.groupByPerson(db.prepare('SELECT * FROM clients').all());
let n = createBdayCongratsTasks(groups, new Date().toISOString());
check('создалась задача после записи', n === 1);
const task = db.prepare(`SELECT * FROM tasks WHERE type='bday_congrats' AND client_id=?`).get(a);
check('тип и reason', task && /Поздравить с днём рождения/.test(task.reason));

// 3) повторный прогон не дублирует
n = createBdayCongratsTasks(groups, new Date().toISOString());
check('нет дубля на повторном прогоне', n === 0);

// 4) был в салоне в ДР → задачи нет
const b = addClient('Борис Был', '79001110002', birth);
addVisit(b, { day: bday, bookedDay: shift(bday, -5), status: 'completed' });
addVisit(b, { day: shift(bday, 1), bookedDay: shift(bday, 1) });
n = createBdayCongratsTasks(people.groupByPerson(db.prepare('SELECT * FROM clients').all()), new Date().toISOString());
check('был в ДР — задачи нет', !db.prepare(`SELECT 1 FROM tasks WHERE type='bday_congrats' AND client_id=?`).get(b));

// 5) заглушка «др» в журнале не считается записью на услугу и не блокирует
const c = addClient('Вика Заглушка', '79001110003', birth);
addVisit(c, { day: bday, bookedDay: shift(bday, -10), kind: 'birthday', service: '', status: 'upcoming' });
addVisit(c, { day: shift(bday, 1), bookedDay: shift(bday, 1) });
n = createBdayCongratsTasks(people.groupByPerson(db.prepare('SELECT * FROM clients').all()), new Date().toISOString());
check('заглушка ДР не мешает', !!db.prepare(`SELECT 1 FROM tasks WHERE type='bday_congrats' AND client_id=?`).get(c));

// 6) записался ДО дня рождения на день после — поводом не считается
const d = addClient('Даша Рано', '79001110004', birth);
addVisit(d, { day: shift(bday, 2), bookedDay: shift(bday, -10) });
n = createBdayCongratsTasks(people.groupByPerson(db.prepare('SELECT * FROM clients').all()), new Date().toISOString());
check('запись до ДР — задачи нет', !db.prepare(`SELECT 1 FROM tasks WHERE type='bday_congrats' AND client_id=?`).get(d));

// 7) generate({fill:false}) тоже создаёт (как new_client)
const e = addClient('Елена Синк', '79001110005', birth);
addVisit(e, { day: shift(bday, 1), bookedDay: shift(bday, 1) });
generate({ fill: false });
check('промежуточный generate создаёт', !!db.prepare(`SELECT 1 FROM tasks WHERE type='bday_congrats' AND client_id=?`).get(e));

console.log('\n' + pass.length + ' ok, ' + fail.length + ' fail');
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail.length ? 1 : 0);
