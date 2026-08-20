'use strict';

// Генерация текстов сообщений клиентам (вкладка «Скрипты») через YandexGPT.
//
// Почему Яндекс, а не Anthropic: России нет в списке поддерживаемых Anthropic стран
// и российские карты в их биллинге не проходят. Yandex Cloud оплачивается обычной
// картой, даёт закрывающие документы, а задача «написать короткое сообщение по-русски»
// для любой современной модели тривиальна.
//
// Провайдер спрятан за одной функцией generateScript(): если однажды появится ключ
// другого провайдера, менять придётся только внутренности этого файла.

const API_URL = 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';
const TIMEOUT_MS = 30000;

const apiKey = () => (process.env.YC_API_KEY || '').trim();
const folderId = () => (process.env.YC_FOLDER_ID || '').trim();
// Модель: Pro по умолчанию — тексты для клиентов пишутся редко, а качество формулировок
// заметно выше, чем у lite. Переопределяется YC_MODEL (напр. 'yandexgpt-lite/latest').
const model = () => (process.env.YC_MODEL || 'yandexgpt/latest').trim();

// Без ключа вкладка «Скрипты» продолжает работать как хранилище — просто без ИИ-блока.
const enabled = () => Boolean(apiKey() && folderId());

// Салон и правила письма. Держим здесь, а не в промпте с фронта: админ описывает
// ЗАДАЧУ («позвать на окрашивание в ноябре»), а тон и формат — забота приложения.
const SYSTEM_PROMPT = [
  'Ты — администратор премиального салона красоты Privé7 в Санкт-Петербурге.',
  'Пишешь короткие сообщения клиентам в мессенджер: WhatsApp, Telegram, SMS.',
  '',
  'Правила:',
  // Формулировка важна: «на "вы" со строчной буквы» модель понимала как указание
  // писать строчными ВЕСЬ текст и выдавала сообщение без единой заглавной.
  '— Обращайся к клиенту на «вы»; само местоимение — со строчной буквы («ждём вас»).',
  '— Текст оформляй обычными предложениями: первое слово и имена собственные с заглавной.',
  '— Тон тёплый и человеческий, без официоза.',
  '— Коротко: 2–4 предложения. Длинные письма в мессенджере не читают.',
  '— Никакого канцелярита и рекламных штампов: «уникальное предложение», «спешите»,',
  '  «мы рады сообщить», «в кратчайшие сроки» — запрещены.',
  '— Без КАПСА, без цепочек восклицательных знаков, максимум один эмодзи и только если',
  '  он уместен по смыслу.',
  '— Не выдумывай цены, скидки, акции и даты, если их не назвали в задаче.',
  '',
  'Подстановки. Если по смыслу нужно имя клиента, мастера, услугу, дату или филиал —',
  'ставь метки {имя}, {мастер}, {услуга}, {дата}, {филиал}. Приложение подставит',
  'настоящие значения. Метки подставляются В ИМЕНИТЕЛЬНОМ ПАДЕЖЕ, поэтому строй фразу',
  'так, чтобы склонение не потребовалось: не «у {мастер}», а «мастер {мастер} ждёт вас».',
  'Имя клиента — всегда {имя}, никогда не выдумывай конкретное имя.',
  'Метки пиши ТОЧНО в этом виде и не склоняй их: {услуга}, а не {услугу}; {филиал},',
  'а не {филиале}. Склонённую метку приложение не распознает, и клиент получит',
  'сообщение с фигурными скобками в тексте.',
  '',
  'В ответ выдавай ТОЛЬКО готовый текст сообщения. Без заголовков, без пояснений,',
  'без кавычек вокруг текста и без вариантов на выбор.',
].join('\n');

// Ошибки YandexGPT приходят по-разному (иногда {error:{message}}, иногда {message}),
// а админу нужно человеческое объяснение — иначе он увидит «сервер ответил 401»
// и пойдёт с этим к Антону.
function explain(status, json) {
  const raw = json?.error?.message || json?.message || '';
  if (status === 401) return 'YandexGPT не принял ключ. Проверьте YC_API_KEY в .env';
  if (status === 403) return 'Нет доступа к YandexGPT: у сервисного аккаунта должна быть роль ai.languageModels.user, а у ключа — область yc.ai.languageModels.execute';
  if (status === 404) return 'YandexGPT не нашёл модель или каталог. Проверьте YC_FOLDER_ID в .env';
  if (status === 429) return 'YandexGPT сейчас ограничивает запросы — попробуйте через минуту';
  if (status >= 500) return 'YandexGPT временно недоступен — попробуйте позже';
  return raw ? `YandexGPT: ${raw}` : `YandexGPT ответил ${status}`;
}

// Сгенерировать текст шаблона по задаче администратора.
// task — что нужно («напомнить про окрашивание тем, кто не был полгода»)
// hint — необязательное название шаблона: помогает модели попасть в тему
async function generateScript(task, hint = '') {
  if (!enabled()) throw new Error('ИИ не подключён: в .env нет YC_API_KEY или YC_FOLDER_ID');
  const text = String(task || '').trim();
  if (!text) throw new Error('Опишите, какое сообщение нужно');

  const body = {
    modelUri: `gpt://${folderId()}/${model()}`,
    completionOptions: { stream: false, temperature: 0.6, maxTokens: 600 },
    messages: [
      { role: 'system', text: SYSTEM_PROMPT },
      { role: 'user', text: hint ? `Название шаблона: ${hint}\nЗадача: ${text}` : text },
    ],
  };

  // Без таймаута зависший запрос держал бы кнопку «Сгенерировать» бесконечно
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res, json;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Api-Key ${apiKey()}`,
        'x-folder-id': folderId(),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    json = await res.json().catch(() => null);
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('YandexGPT не ответил за 30 секунд — попробуйте ещё раз');
    throw new Error('Не удалось связаться с YandexGPT: ' + e.message);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new Error(explain(res.status, json));

  const out = json?.result?.alternatives?.[0]?.message?.text;
  if (!out || !out.trim()) throw new Error('YandexGPT вернул пустой ответ — переформулируйте задачу');

  // Модель нет-нет да обернёт текст в кавычки, хотя её просили этого не делать
  const clean = out.trim().replace(/^[«"](.*)[»"]$/s, '$1').trim();
  return { text: clean, usage: json?.result?.usage || null, model: model() };
}

module.exports = { enabled, generateScript };
