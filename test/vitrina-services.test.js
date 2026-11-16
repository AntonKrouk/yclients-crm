'use strict';

const { test, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitrina-services-'));
process.env.DATA_DIR = dir;
const yc = require('../src/yclients');
const vitrina = require('../src/vitrina');
const { db } = require('../src/db');

mock.method(yc, 'isDemo', () => false);
mock.method(yc, 'ensureAuth', async () => ({ ok: true }));
const link = { id: '17', price: 10000, seance_length: 7200 };
const services = [
  { id: 1, title: 'Окрашивание ресниц', category_id: 10, active: 1,
    price_min: 3300, price_max: 3300, staff: [{ id: 17, seance_length: 1800 }] },
  { id: '2', title: 'Наращивание ресниц', category_id: '20', active: 0,
    price_min: 9000, price_max: 12000, staff: [link] },
  { id: 3, title: 'Снятие наращенных ресниц', category_id: 20, active: 0,
    price_min: 2000, price_max: 2500, duration: 1200, staff: [{ id: 17 }] },
  { id: 4, title: 'Услуга другого мастера', category_id: 20, staff: [{ id: 99 }] },
  ...['+3500 раннее/позднее открытие', '+5000 позднее открытие', 'Выезд стилиста в пределах СПБ']
    .map((title, i) => ({ id: 5 + i, title, staff: [link] })),
  { id: 8, title: 'Услуга без мастеров', staff: [] },
];
mock.method(yc, 'fetchServices', async () => services);
mock.method(yc, 'fetchServiceCategories', async () => [
  { id: 10, title: 'Брови и ресницы' }, { id: '20', title: 'Наращивание ресниц' },
]);
const book = mock.method(yc, 'fetchBookServices', async () => ({
  category: [{ id: 10, title: 'Брови и ресницы' }], services: [services[0]],
}));

after(() => {
  mock.restoreAll();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('master shows assigned offline services and their full categories, price and duration', async () => {
  const rows = await vitrina.ycServices(387958, '17');
  assert.deepEqual(rows, [
    { id: 1, title: 'Окрашивание ресниц', category: 'Брови и ресницы', price_min: 3300, price_max: 3300, duration: 30 },
    { id: '2', title: 'Наращивание ресниц', category: 'Наращивание ресниц', price_min: 10000, price_max: 10000, duration: 120 },
    { id: 3, title: 'Снятие наращенных ресниц', category: 'Наращивание ресниц', price_min: 2000, price_max: 2500, duration: 20 },
  ]);
  assert.equal(book.mock.callCount(), 0, 'master services must work independently of online booking');
});

test('master service cache stays within the branch', async () => {
  const fetchAll = mock.method(yc, 'fetchServices', async cid => cid === 898298 ? [] : services);
  assert.deepEqual(await vitrina.ycServices(898298, 17), []);
  assert.equal((await vitrina.ycServices(387958, 17)).length, 3);
  assert.equal(fetchAll.mock.callCount(), 1);
  fetchAll.mock.restore();
});

test('zero individual price and missing categories remain valid', async () => {
  const fetchAll = mock.method(yc, 'fetchServices', async () => [
    { id: 9, title: 'Коррекция', category_id: 999, price_min: 1000, price_max: 2000,
      staff: [{ id: 17, price: 0, seance_length: 900 }] },
  ]);
  assert.deepEqual(await vitrina.ycServices(1, 17), [
    { id: 9, title: 'Коррекция', category: 'Услуги', price_min: 0, price_max: 0, duration: 15 },
  ]);
  fetchAll.mock.restore();
});

test('general price list still uses the online catalog', async () => {
  const rows = await vitrina.ycServices(387958);
  assert.deepEqual(rows.map(s => s.id), [1]);
  assert.equal(rows[0].category, 'Брови и ресницы');
  assert.equal(book.mock.callCount(), 1);
});
