'use strict';

// Уведомления администраторам в Telegram.
// Настройка: BotFather → токен в TELEGRAM_BOT_TOKEN; chat_id админов через запятую в TELEGRAM_ADMIN_CHATS.
// Чтобы узнать chat_id: админ пишет боту /start, затем открой
// https://api.telegram.org/bot<TOKEN>/getUpdates — там будет chat.id.
// Если токен не задан — модуль молча ничего не делает (не мешает работе дашборда).

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHATS = (process.env.TELEGRAM_ADMIN_CHATS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const PUBLIC_URL = process.env.PUBLIC_URL || '';

const enabled = () => Boolean(TOKEN && CHATS.length);

async function send(chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text().catch(() => '')}`);
}

// Сводка по количеству задач на сегодня
async function notifyDailySummary(counts) {
  if (!enabled()) return { sent: 0, skipped: 'not_configured' };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!total) return { sent: 0, skipped: 'no_tasks' };
  const lines = [
    `<b>Задачи на сегодня: ${total}</b>`,
    counts.confirm_visit ? `🔔 Подтвердить визит: ${counts.confirm_visit}` : '',
    counts.rebook ? `🔄 Пора записать: ${counts.rebook}` : '',
    counts.no_show ? `❌ Перезаписать (не пришёл): ${counts.no_show}` : '',
    counts.reactivation ? `💤 Реактивация: ${counts.reactivation}` : '',
    PUBLIC_URL ? `\n👉 ${PUBLIC_URL}` : '',
  ].filter(Boolean);
  const text = lines.join('\n');
  let sent = 0;
  for (const chat of CHATS) {
    try { await send(chat, text); sent++; } catch (e) { console.error('[telegram]', e.message); }
  }
  return { sent };
}

module.exports = { enabled, notifyDailySummary };
