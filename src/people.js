'use strict';

// Один человек — несколько карточек YClients.
// В YClients клиент заводится ОТДЕЛЬНОЙ карточкой в каждом филиале: разный client_id,
// один и тот же телефон. Из-за этого визиты и деньги человека размазаны по двум строкам
// таблицы clients, и любая сумма «по карточке» занижена. Здесь общие помощники, чтобы
// и движок задач, и конструктор, и карточка клиента считали человека одинаково.

const normPhone = (p) => String(p || '').replace(/\D/g, '');

// Отсекаем мусорные номера-заглушки (79999999999, 00000000000 и т.п.), иначе десятки
// разных людей склеятся в одного.
const isRealPhone = (d) => d.length >= 10 && new Set(d.split('')).size > 2;

// Ключ человека: последние 10 цифр телефона, а без внятного телефона — сам по себе.
const personKey = (row) => {
  const d = normPhone(row.phone);
  return isRealPhone(d) ? 'p:' + d.slice(-10) : 'id:' + row.id;
};

// Группирует карточки по человеку. Возвращает массив групп, в каждой карточки отсортированы
// по «приоритетности»: больше визитов → свежее последний визит → меньший id.
function groupByPerson(rows) {
  const groups = new Map();
  for (const r of rows) {
    const k = personKey(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) => ((b.visits_count || 0) - (a.visits_count || 0))
      || (new Date(b.last_visit || 0) - new Date(a.last_visit || 0))
      || (a.id - b.id));
  }
  return [...groups.values()];
}

module.exports = { normPhone, isRealPhone, personKey, groupByPerson };
