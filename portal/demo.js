'use strict';

// Демо-данные витрины. Один файл на два мира: сервер отдаёт их, пока нет
// токенов YClients (локальная разработка), а превью-страница подключает его прямо в
// браузер вместо сервера. Поэтому здесь нет ни require, ни fetch — только данные и
// функция handle(), повторяющая ответы настоящих маршрутов /p/api/*.
// Имена, цены и работы — примерные, к реальным мастерам салона отношения не имеют.

(function (root) {
  // Телефоны — заглушки: настоящие номера живут в data/portal-salons.json на сервере
  const SALONS = [
    { id: 387958, name: 'Басков', phone: '+7 (812) 000-00-01', address: '', hours: 'Ежедневно 10:00–22:00' },
    { id: 898298, name: 'Мытнинская', phone: '+7 (812) 000-00-02', address: '', hours: 'Ежедневно 10:00–22:00' },
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
    { id: 701, category: 'Макияж', title: 'Дневной макияж', price_min: 4000, price_max: 4000, duration: 60 },
    { id: 702, category: 'Макияж', title: 'Вечерний макияж', price_min: 5500, price_max: 5500, duration: 75 },
    { id: 703, category: 'Макияж', title: 'Свадебный макияж с пробным', price_min: 12000, price_max: 12000, duration: 150 },
    { id: 801, category: 'Перманентный макияж', title: 'Пудровые брови', price_min: 15000, price_max: 15000, duration: 150 },
    { id: 802, category: 'Перманентный макияж', title: 'Межресничная стрелка', price_min: 12000, price_max: 12000, duration: 120 },
    { id: 803, category: 'Перманентный макияж', title: 'Губы, акварельная техника', price_min: 17000, price_max: 17000, duration: 150 },
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
        bio: 'Восемь лет в профессии. Любит сложный нюд, тонкий френч и короткую аккуратную длину. Работает только одноразовыми пилками.',
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
      { id: 17, name: 'Мила', specialization: 'Визажист', rating: 4.9, reviews: 18,
        services: [701, 702, 703],
        works: [w('copper', 'Вечерний образ'), w('skin', 'Нюдовый дневной'), w('wine', 'Акцент на губы')] },
      { id: 18, name: 'Яна', specialization: 'Мастер перманентного макияжа', rating: 5.0, reviews: 26,
        services: [801, 802, 803],
        works: [w('brow', 'Пудровые брови'), w('lash', 'Межресничка'), w('copper', 'Губы акварелью')] },
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

  // Опубликованные отзывы (после модерации). Подпись — только имя, которое клиент
  // указал сам, и первая буква фамилии, если он её дал.
  const REVIEW_POOL = [
    { author: 'Анна', rating: 5, text: 'Всё аккуратно и без спешки. Покрытие держится уже третью неделю, ни одного скола.' },
    { author: 'Екатерина Л.', rating: 5, text: 'Пришла с конкретной картинкой, получила даже лучше. Отдельное спасибо за кофе и тишину.' },
    { author: 'Мария', rating: 4, text: 'Результат отличный. Немного задержались с началом, минут на десять, но предупредили заранее.' },
    { author: 'Ольга', rating: 5, text: 'Хожу второй год и не представляю, к кому ещё. Всегда подскажет, что лучше именно мне.' },
    { author: 'Юлия С.', rating: 5, text: 'Очень бережные руки. Записалась сразу на следующий раз.' },
    { author: 'Ирина', rating: 5, text: 'Спокойная атмосфера, всё объяснили по ходу. Буду рекомендовать подругам.' },
  ];
  function reviewsOf(staffId) {
    const n = 2 + (hash('r' + staffId) % 2);
    const out = [];
    for (let i = 0; i < n; i++) {
      const r = REVIEW_POOL[(hash(staffId + ':' + i) + i) % REVIEW_POOL.length];
      const d = new Date(Date.now() - (6 + i * 17 + hash('d' + staffId + i) % 9) * 86400000);
      out.push({ ...r, date: d.toISOString().slice(0, 10) });
    }
    return out;
  }


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

  const publicStaff = (s) => ({
    id: s.id, name: s.name, specialization: s.specialization, avatar: '', tone: s.works[0]?.tone, bio: s.bio || '',
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
      case '/p/api/reviews': return reviewsOf(q.staff);
      case '/p/api/review': {
        if (method !== 'POST') throw new Error('Метод не поддерживается');
        return { ok: true, demo: true, low: Number(body.rating) <= 3 };
      }
      default: throw new Error('Не найдено: ' + path);
    }
  }

  const api = { SALONS, SERVICES, STAFF, handle };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PortalDemo = api;
})(typeof window !== 'undefined' ? window : globalThis);
