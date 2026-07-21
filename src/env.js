'use strict';

// Минимальный загрузчик .env без зависимостей. Подключать ПЕРВОЙ строкой точек входа.
const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, '..', '.env');
try {
  const text = fs.readFileSync(file, 'utf8');
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
} catch { /* .env отсутствует — работаем на переменных окружения / демо-режиме */ }
