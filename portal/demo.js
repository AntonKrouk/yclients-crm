'use strict';

// Демо-данные клиентского портала. Один файл на два мира: сервер отдаёт их, пока нет
// токенов YClients (локальная разработка), а превью-страница подключает его прямо в
// браузер вместо сервера. Поэтому здесь нет ни require, ни fetch — только данные и
// функция handle(), повторяющая ответы настоящих маршрутов /p/api/*.
// Имена, цены и работы — примерные, к реальным мастерам салона отношения не имеют.

(function (root) {
  const SALONS = [
    { id: 387958, name: 'Басков' },
    { id: 898298, name: 'Мытнинская' },
  ];

  const SERVICES = [
    { id: 101, category: 'Маникюр', title: 'Маникюр с покрытием гель-лак', price_min: 3200, price_max: 3800, duration: 90 },
    { id: 102, category: 'Маникюр', title: 'Маникюр без покрытия', price_min: 2200, price_max: 2200, duration: 60 },
    { id: 103, category: 'Маникюр', title: 'Укрепление ногтей гелем', price_min: 800, price_max: 800, duration: 20 },
    { id: 104, category: 'Маникюр', title: 'Дизайн, за ноготь', price_min: 150, price_max: 400, duration: 10 },
    { id: 201, category: 'Педикюр', title: 'Педикюр с покрытием гель-лак', price_min: 4200, price_max: 4600, duration: 90 },
    { id: 202, category: 'Педикюр', title: 'Педикюр smart', price_min: 3400, price_max: 3400, duration: 60 },
    { id: 301, category: 'Брови и ресницы', title: 'Коррекция и окрашивание бровей', price_min: 2500, price_max: 2500, duration: 45 },
    { id: 302, category: 'Брови и ресницы', title: 'Ламинирование ресниц', price_min: 3500, price_max: 3500, duration: 60 },
    { id: 303, category: 'Брови и ресницы', title: 'Наращивание ресниц 2D', price_min: 4500, price_max: 5000, duration: 120 },
    { id: 401, category: 'Волосы', title: 'Женская стрижка', price_min: 4000, price_max: 6000, duration: 60 },
    { id: 402, category: 'Волосы', title: 'Окрашивание в один тон', price_min: 7000, price_max: 12000, duration: 150 },
    { id: 403, category: 'Волосы', title: 'Укладка', price_min: 2800, price_max: 3500, duration: 45 },
    { id: 501, category: 'Косметология', title: 'Комбинированная чистка лица', price_min: 6500, price_max: 6500, duration: 90 },
    { id: 502, category: 'Косметология', title: 'Пилинг', price_min: 4500, price_max: 6000, duration: 45 },
    { id: 503, category: 'Косметология', title: 'Уходовая программа по типу кожи', price_min: 7000, price_max: 7000, duration: 75 },
    { id: 504, category: 'Косметология', title: 'Массаж лица', price_min: 3500, price_max: 3500, duration: 45 },
    { id: 601, category: 'Массаж', title: 'Классический массаж, 60 минут', price_min: 4500, price_max: 4500, duration: 60 },
    { id: 602, category: 'Массаж', title: 'Лимфодренажный массаж', price_min: 5000, price_max: 5000, duration: 60 },
    { id: 603, category: 'Массаж', title: 'Массаж спины и шеи', price_min: 3000, price_max: 3000, duration: 40 },
  ];

  // Оттенки плашек-заглушек вместо фотографий работ: пара цветов на градиент
  const TONES = {
    nude: ['#E9D3C4', '#C99E88'], milk: ['#F3ECE3', '#D9CBB9'], wine: ['#8C3B46', '#4E1F27'],
    chrome: ['#DADCDF', '#8F959C'], french: ['#F6EEEA', '#E3C9C0'], sage: ['#C8D2C1', '#7F8F79'],
    brow: ['#B08D74', '#5E4637'], lash: ['#3D3531', '#171412'], blond: ['#EBD9B4', '#B9985F'],
    copper: ['#C9784C', '#7A3D22'], teal: ['#9FD6CF', '#12B3A6'],
    skin: ['#EAD7CC', '#B98F7C'], stone: ['#D6CFC4', '#8A8175'], oil: ['#D9C08E', '#8C6B32'],
  };
  const w = (tone, caption) => ({ tone: TONES[tone], caption });

  const STAFF = {
    387958: [
      { id: 11, name: 'Алина', specialization: 'Топ-мастер маникюра и педикюра', rating: 4.9, reviews: 64,
        services: [101, 102, 103, 104, 201, 202],
        works: [w('nude', 'Нюд с укреплением'), w('wine', 'Бордо, квадрат'), w('french', 'Френч тонкой линией'),
          w('chrome', 'Хром на миндаль'), w('milk', 'Молочный однотон'), w('sage', 'Шалфей, короткая длина')] },
      { id: 12, name: 'Вероника', specialization: 'Мастер маникюра', rating: 4.8, reviews: 31,
        services: [101, 102, 103, 104],
        works: [w('milk', 'Молочный однотон'), w('teal', 'Бирюза, акцент'), w('nude', 'Нюд, овал'),
          w('french', 'Обратный френч')] },
      { id: 13, name: 'Диана', specialization: 'Бровист, лэшмейкер', rating: 5.0, reviews: 42,
        services: [301, 302, 303],
        works: [w('brow', 'Архитектура бровей'), w('lash', 'Ламинирование ресниц'), w('brow', 'Окрашивание хной'),
          w('lash', 'Наращивание 2D')] },
      { id: 14, name: 'Кира', specialization: 'Стилист-колорист', rating: 4.9, reviews: 27,
        services: [401, 402, 403],
        works: [w('blond', 'Тёплый блонд'), w('copper', 'Медь'), w('milk', 'Каре с укладкой')] },
      { id: 15, name: 'Марина', specialization: 'Косметолог-эстетист', rating: 4.9, reviews: 23,
        services: [501, 502, 503, 504],
        works: [w('skin', 'До и после чистки'), w('milk', 'Уход для сухой кожи'), w('skin', 'Пилинг, курс из 3')] },
      { id: 16, name: 'Игорь', specialization: 'Массажист', rating: 5.0, reviews: 38,
        services: [601, 602, 603],
        works: [w('oil', 'Кабинет массажа'), w('stone', 'Классический массаж')] },
    ],
    898298: [
      { id: 21, name: 'Ева', specialization: 'Топ-мастер маникюра', rating: 4.9, reviews: 58,
        services: [101, 102, 103, 104, 201],
        works: [w('wine', 'Вишня, миндаль'), w('nude', 'Нюд с укреплением'), w('chrome', 'Жемчужная втирка'),
          w('french', 'Френч'), w('sage', 'Олива')] },
      { id: 22, name: 'Полина', specialization: 'Мастер педикюра', rating: 4.7, reviews: 19,
        services: [201, 202],
        works: [w('milk', 'Педикюр, молочный'), w('wine', 'Педикюр, бордо')] },
      { id: 23, name: 'София', specialization: 'Лэшмейкер', rating: 4.9, reviews: 36,
        services: [302, 303, 301],
        works: [w('lash', 'Наращивание 2D'), w('lash', 'Лисий эффект'), w('brow', 'Брови после коррекции')] },
      { id: 24, name: 'Ксения', specialization: 'Врач-косметолог', rating: 4.8, reviews: 17,
        services: [501, 502, 503],
        works: [w('skin', 'Программа против акне'), w('milk', 'Увлажнение')] },
      { id: 25, name: 'Олег', specialization: 'Массажист', rating: 4.9, reviews: 29,
        services: [601, 602, 603],
        works: [w('stone', 'Массаж спины'), w('oil', 'Лимфодренаж')] },
      { id: 26, name: 'Дарья', specialization: 'Стилист', rating: 4.8, reviews: 21,
        services: [401, 403],
        works: [w('blond', 'Укладка локоны'), w('copper', 'Стрижка боб')] },
    ],
  };

  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  // Детерминированная «случайность»: у одного мастера в один день всегда одни и те же
  // занятые окна, чтобы превью не прыгало при каждом нажатии
  function hash(s) {
    let h = 2166136261;
    for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  const salon = (id) => SALONS.find(s => String(s.id) === String(id)) || SALONS[0];
  const staffOf = (salonId) => STAFF[salon(salonId).id] || [];
  const staffById = (salonId, id) => staffOf(salonId).find(s => String(s.id) === String(id));
  const ids = (v) => String(v || '').split(',').map(Number).filter(Boolean);

  function dates(salonId, staffId) {
    const out = [];
    const d = new Date(); d.setHours(12, 0, 0, 0);
    for (let i = 0; i < 21; i++) {
      const day = new Date(d.getTime() + i * 86400000);
      if (hash(`${staffId}:${ymd(day)}`) % 7 < 2) continue; // выходной мастера
      out.push(ymd(day));
    }
    return out;
  }

  function times(salonId, staffId, date) {
    const out = [];
    const now = new Date();
    for (let m = 10 * 60; m <= 20 * 60; m += 30) {
      const t = `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
      if (hash(`${staffId}:${date}:${t}`) % 5 < 2) continue; // занято
      const dt = new Date(`${date}T${t}:00+03:00`);
      if (dt <= now) continue;
      out.push({ time: t, datetime: `${date}T${t}:00+03:00` });
    }
    return out;
  }

  const publicStaff = (s) => ({
    id: s.id, name: s.name, specialization: s.specialization, avatar: '', tone: s.works[0]?.tone,
    rating: s.rating, reviews: s.reviews, works: s.works,
  });

  // Повторяет ответы маршрутов portal/server.js один в один
  function handle(method, path, q = {}, body = {}) {
    switch (path) {
      case '/p/api/health': return { ok: true, demo: true };
      case '/p/api/salons': return SALONS;
      case '/p/api/staff': {
        const want = ids(q.services);
        return staffOf(q.salon)
          .filter(s => want.every(id => s.services.includes(id)))
          .map(publicStaff);
      }
      case '/p/api/services': {
        const st = q.staff ? staffById(q.salon, q.staff) : null;
        const offered = new Set(st ? st.services : staffOf(q.salon).flatMap(s => s.services));
        return SERVICES.filter(s => offered.has(s.id));
      }
      case '/p/api/dates': return { dates: dates(q.salon, q.staff) };
      case '/p/api/times': return times(q.salon, q.staff, q.date);
      case '/p/api/book': {
        if (method !== 'POST') throw new Error('Метод не поддерживается');
        const st = staffById(body.salon, body.staff_id);
        const svc = SERVICES.filter(s => (body.service_ids || []).map(Number).includes(s.id));
        return {
          ok: true, demo: true, salon: salon(body.salon).name, staff: st ? st.name : '',
          services: svc.map(s => s.title).join(', '), datetime: body.datetime,
        };
      }
      default: throw new Error('Не найдено: ' + path);
    }
  }

  const api = { SALONS, SERVICES, STAFF, handle };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PortalDemo = api;
})(typeof window !== 'undefined' ? window : globalThis);
