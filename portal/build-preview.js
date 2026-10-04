'use strict';

// Собирает одностраничное превью витрины: тот же HTML, стили и код, но вместо сервера —
// demo.js прямо в браузере. Нужен, чтобы показать интерфейс без запуска сервера
// (открыть с телефона, переслать). Запуск: node portal/build-preview.js <файл.html>
const fs = require('node:fs');
const path = require('node:path');

const dir = __dirname;
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const html = read('public/index.html');
const body = html.slice(html.indexOf('<!--app-->') + 10, html.indexOf('<!--/app-->'));
const out = process.argv[2] || path.join(dir, 'preview.html');

fs.writeFileSync(out, [
  '<title>Privé7 Мастера</title>',
  `<style>\n${read('public/portal.css')}</style>`,
  body,
  `<script>\n${read('demo.js')}</script>`,
  '<script>window.PORTAL_API = async (m, p, q, b) => PortalDemo.handle(m, p, q, b);</script>',
  `<script>\n${read('public/portal.js')}</script>`,
].join('\n'));
console.log('превью:', out);
