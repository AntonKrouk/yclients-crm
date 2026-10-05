'use strict';

// Витрина Privé7: мастера по направлениям, их работы, цены, отзывы и оценки.
// Записи на сайте нет (решение 04.10.2026): клиент звонит в салон — кнопка
// «Позвонить» внизу показывает телефоны обоих филиалов.
// Превью-страница подменяет сервер через window.PORTAL_API (demo.js в браузере).

(function () {
  const $ = (id) => document.getElementById(id);
  const app = $('app');

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rub = (n) => Number(n || 0).toLocaleString('ru-RU') + ' ₽';
  const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)} ч${m % 60 ? ' ' + (m % 60) + ' мин' : ''}` : `${m} мин`);
  const MON = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const shortDate = (ymd) => { const d = new Date(ymd + 'T12:00:00'); return `${d.getDate()} ${MON[d.getMonth()]}`; };
  const plural = (n, a, b, c) => { const m = n % 100, k = n % 10; return m > 10 && m < 20 ? c : k === 1 ? a : k > 1 && k < 5 ? b : c; };
  const telHref = (p) => 'tel:+' + String(p || '').replace(/\D/g, '');

  async function call(method, path, q = {}, body) {
    if (window.PORTAL_API) {
      await new Promise(r => setTimeout(r, 120)); // чтобы в превью было видно загрузку
      return window.PORTAL_API(method, path, q, body);
    }
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== '' && v != null)).toString();
    const res = await fetch(path + (qs ? '?' + qs : ''), {
      method, headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.');
    return json;
  }

  // --- состояние ------------------------------------------------------------
  const S = {
    salons: [], salon: null, tab: 'staff', group: '',
    staff: [], services: [],            // мастера и прайс салона
    screen: 'home', stack: [],
    master: null, masterServices: [], reviews: null,
    rform: { rating: 0, text: '', author: '', phone: '', publish: false, consent: false },
    reviewResult: null, error: '', busy: false,
  };
  const RATING_WORDS = ['', 'Очень плохо', 'Плохо', 'Нормально', 'Хорошо', 'Отлично'];

  // --- движение ---------------------------------------------------------------
  // Кого укачивает (настройка «уменьшить движение»), тому без анимаций — и здесь, и в CSS
  const RM = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const calm = () => Boolean(RM && RM.matches);
  const dl = (ms) => ` style="--d:${ms}ms"`;

  // Переход между экранами через View Transitions: фото мастера перетекает из карточки
  // в шапку его страницы и обратно. update() меняет экран и может вернуть элемент,
  // в который «приземляется» фото. Где браузер не умеет — просто смена экрана.
  function morph(update, fromEl) {
    if (!document.startViewTransition || calm()) { update(); return null; }
    if (fromEl) fromEl.style.viewTransitionName = 'mph';
    let toEl = null;
    const vt = document.startViewTransition(() => {
      toEl = update();
      if (toEl) toEl.style.viewTransitionName = 'mph';
    });
    // имя должно быть у одного элемента на странице — снимаем, иначе следующий переход сломается
    vt.finished.catch(() => {}).then(() => { if (toEl) toEl.style.viewTransitionName = ''; });
    return vt;
  }

  function go(screen) {
    if (S.screen === 'home') S.homeY = window.scrollY; // вернёмся к той же карточке
    S.stack.push(S.screen);
    S.screen = screen; S.error = '';
    try { history.pushState({ s: screen }, ''); } catch { /* превью */ }
    render(); window.scrollTo(0, 0);
  }
  // animate=false — браузер уже сам показал анимацию «назад» (свайп в Safari)
  function back(animate = true) {
    if (!S.stack.length) return;
    const from = S.master?.id;
    const update = () => {
      S.screen = S.stack.pop(); S.error = '';
      if (S.screen === 'home') S.master = null;
      render();
      window.scrollTo(0, S.screen === 'home' ? S.homeY || 0 : 0);
      return S.screen === 'home' && from != null ? app.querySelector(`[data-master="${from}"] .card-ph`) : null;
    };
    if (animate) morph(update); else update();
  }
  window.addEventListener('popstate', (e) => back(!e.hasUAVisualTransition));

  // --- загрузка -------------------------------------------------------------
  async function loadSalon(id) {
    S.salon = S.salons.find(s => String(s.id) === String(id)) || S.salons[0];
    try { localStorage.setItem('prive.salon', S.salon.id); } catch { /* без памяти */ }
    S.staff = []; S.services = []; S.master = null; S.stack = []; S.screen = 'home'; S.error = '';
    render();
    try {
      const [staff, services] = await Promise.all([
        call('GET', '/p/api/staff', { salon: S.salon.id }),
        call('GET', '/p/api/services', { salon: S.salon.id }),
      ]);
      S.staff = staff; S.services = services;
    } catch (e) { S.error = e.message; }
    render();
  }

  // fromEl — фото в карточке, из которого «вырастает» шапка страницы мастера
  async function openMaster(id, fromEl) {
    S.master = S.staff.find(m => String(m.id) === String(id));
    if (!S.master) return;
    S.masterServices = []; S.reviews = null;
    // фото прилетит из карточки — своя анимация появления ему не нужна
    S.heroAnim = !(fromEl && document.startViewTransition && !calm());
    const vt = morph(() => go('master'), fromEl);
    try {
      const [svc, rev] = await Promise.all([
        call('GET', '/p/api/services', { salon: S.salon.id, staff: S.master.id }),
        call('GET', '/p/api/reviews', { salon: S.salon.id, staff: S.master.id }).catch(() => []),
      ]);
      S.masterServices = svc; S.reviews = rev;
    } catch (e) { S.error = e.message; S.reviews = S.reviews || []; }
    // не перерисовываем страницу посреди перелёта фото — дождёмся его конца
    if (vt) await vt.finished.catch(() => {});
    render();
  }

  function openReview() {
    S.rform = { rating: 0, text: '', author: '', phone: '', publish: false, consent: false };
    go('review');
  }

  async function submitReview() {
    const f = S.rform;
    const digits = f.phone.replace(/\D/g, '');
    S.error = '';
    if (!f.rating) S.error = 'Поставьте оценку: нажмите на звёзды.';
    else if (f.author.trim().length < 2) S.error = 'Напишите, как подписать отзыв.';
    else if (digits.length > 1 && digits.length !== 11) S.error = 'Проверьте номер телефона: нужно 10 цифр после +7. Или оставьте поле пустым.';
    else if (!f.consent) S.error = 'Отметьте согласие на обработку данных.';
    if (S.error) return render();
    S.busy = true; render();
    try {
      S.reviewResult = await call('POST', '/p/api/review', {}, {
        salon: S.salon.id, staff_id: S.master.id, rating: f.rating, text: f.text, author: f.author,
        phone: digits.length === 11 ? f.phone : '', publish: f.publish, consent: f.consent,
        website: $('website')?.value || '',
      });
      S.busy = false; S.screen = 'reviewDone'; render(); window.scrollTo(0, 0);
    } catch (e) { S.busy = false; S.error = e.message; render(); }
  }

  // --- куски разметки -------------------------------------------------------
  const initials = (n) => esc(String(n || '?').trim().charAt(0).toUpperCase());
  const rating = (m) => (m.rating
    ? `<div class="rate"><b>★ ${Number(m.rating).toFixed(1).replace('.', ',')}</b>${m.reviews ? ` · ${m.reviews} ${plural(m.reviews, 'отзыв', 'отзыва', 'отзывов')}` : ''}</div>`
    : '<div class="rate">Пока без оценок</div>');
  function tile(w, i) {
    const inner = w.src ? `<img src="${esc(w.src)}" alt="${esc(w.caption)}" loading="lazy">` : '';
    const bg = w.tone ? ` style="background:linear-gradient(145deg,${esc(w.tone[0])},${esc(w.tone[1])})"` : '';
    return `<button class="tile rv-tile" type="button"${dl(320 + Math.min(i, 11) * 45)} data-work="${i}" aria-label="${esc(w.caption || 'Работа')}"${bg}>${inner}</button>`;
  }
  const svcRow = (s) => `
    <div class="svc">
      <span class="svc-t">${esc(s.title)}${s.duration ? `<small>${dur(s.duration)}</small>` : ''}</span>
      <span class="price">${s.price_max > s.price_min ? 'от ' : ''}${rub(s.price_min)}</span>
    </div>`;
  // fadeIn — цены пришли вторым запросом (страница мастера): просто проявляются;
  // иначе (вкладка «Цены») — встают лесенкой вместе с экраном
  function svcGroups(list, hideSingle, fadeIn) {
    const cats = [];
    for (const s of list) {
      let c = cats.find(x => x.name === s.category);
      if (!c) cats.push(c = { name: s.category, items: [] });
      c.items.push(s);
    }
    // у мастера одного направления заголовок категории повторял бы шапку — прячем
    const head = !(hideSingle && cats.length === 1);
    return cats.map((c, i) => `<section class="cat ${fadeIn ? 'in' : 'rv1'}"${fadeIn ? '' : dl(160 + Math.min(i, 8) * 60)}>${head ? `<h2 class="eyebrow">${esc(c.name)}</h2>` : ''}${c.items.map(svcRow).join('')}</section>`).join('');
  }

  // Направление мастера: админ может выбрать его в CRM, иначе — по должности (position)
  // и специализации из YClients. Порядок строк = порядок проверки и показа:
  // «Косметолог, массаж лица» должен попасть в косметологию, поэтому она выше массажа.
  const GROUPS = [
    ['Стилисты', /стилист|парикмахер|колорист|барбер|волос|hair/i],
    ['Мастера маникюра/педикюра', /маникюр|педикюр|ногт|nail/i],
    ['Брови и ресницы', /бров|ресниц|лэш|lash/i],
    ['Косметологи', /космет|эстетист|дерматолог/i],
    ['Массажисты', /массаж|spa|спа-/i],
    ['Визажисты', /визаж|макияж|make-?up/i],
  ];
  const OTHER = 'Другие мастера';
  function groupOf(m) {
    if (m.direction) return m.direction; // сервер уже учёл выбор админа в CRM
    const text = `${m.position || ''} ${m.specialization || ''}`;
    const hit = GROUPS.find(([, re]) => re.test(text));
    return hit ? hit[0] : (m.position || OTHER);
  }
  function grouped(list) {
    const order = GROUPS.map(g => g[0]);
    const map = new Map();
    for (const m of list) {
      const g = groupOf(m);
      if (!map.has(g)) map.set(g, []);
      map.get(g).push(m);
    }
    const rank = (g) => (order.includes(g) ? order.indexOf(g) : g === OTHER ? 99 : 50);
    return [...map.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
  }

  // Карточка мастера в списке: крупное фото, имя, направление. Портфолио — внутри,
  // по нажатию. В демо фото нет — вместо него монограмма на оттенке первой работы.
  const photo = (m, cls) => `<span class="${cls}"${!m.avatar && m.tone ? ` style="background:linear-gradient(160deg,${esc(m.tone[0])},${esc(m.tone[1])})"` : ''}>${m.avatar
    ? `<img src="${esc(m.avatar)}" alt="" loading="lazy">`
    : `<span class="mono">${initials(m.name)}</span>`}</span>`;
  // Первые десять карточек встают лесенкой, остальные — по мере прокрутки (.late)
  const masterCard = (m, i) => `
          <button class="card rv2${i >= 10 ? ' late' : ''}" type="button"${dl(140 + Math.min(i, 10) * 60)} data-master="${m.id}">
            ${photo(m, 'card-ph')}
            <span class="card-b">
              <span class="m-name">${esc(m.name)}</span>
              <span class="m-spec">${esc(m.specialization)}</span>
              ${rating(m)}
            </span>
          </button>`;

  const stars = (n) => `<span class="stars" aria-label="${n} из 5">${'★'.repeat(n)}<span>${'★'.repeat(5 - n)}</span></span>`;
  const STAR_SVG = '<svg viewBox="0 0 24 24" width="36" height="36" aria-hidden="true"><path d="M12 2.8l2.7 5.9 6.4.7-4.8 4.3 1.4 6.3L12 16.8 6.3 20l1.4-6.3L2.9 9.4l6.4-.7z" fill="currentColor"/></svg>';
  const PHONE_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6.6 3.5h3l1.5 4-2 1.3a11 11 0 0 0 6.1 6.1l1.3-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';

  const errBox = () => (S.error ? `<p class="err" role="alert">${esc(S.error)}</p>` : '');
  const skel = (n) => Array.from({ length: n }, () => '<div class="skel"></div>').join('');

  // --- экраны ---------------------------------------------------------------
  function home() {
    const tabs = `<div class="tabs rv" role="tablist"${dl(180)}>
      <button type="button" role="tab" data-tab="staff" aria-selected="${S.tab === 'staff'}">Мастера</button>
      <button type="button" role="tab" data-tab="services" aria-selected="${S.tab === 'services'}">Цены</button></div>`;
    const loading = !S.staff.length && !S.error;
    let body;
    if (S.tab !== 'staff') body = loading ? skel(4) : `<div class="prices">${svcGroups(S.services)}</div>`;
    else if (loading) body = `<div class="cards">${'<div class="card skel-card"></div>'.repeat(4)}</div>`;
    else {
      const groups = grouped(S.staff);
      if (S.group && !groups.some(([g]) => g === S.group)) S.group = '';
      const chips = groups.length > 1 ? `<div class="chips rv1"${dl(60)} role="group" aria-label="Направление">
        <button class="chip" type="button" data-group="" aria-pressed="${!S.group}">Все</button>
        ${groups.map(([g, ms]) => `<button class="chip" type="button" data-group="${esc(g)}" aria-pressed="${S.group === g}">${esc(g)} <span>${ms.length}</span></button>`).join('')}
      </div>` : '';
      // Одна сплошная сетка: разделы по одному мастеру оставляли бы полстроки пустыми.
      // Направление над именем не подписываем (Антон, 04.10.2026): специализация и так под именем.
      const shown = S.group ? groups.filter(([g]) => g === S.group) : groups;
      body = chips + `<div class="cards">${shown.flatMap(([, ms]) => ms).map((m, i) => masterCard(m, i)).join('')}</div>`;
    }
    return `<section class="intro"><span class="eyebrow rv">Privé7 · ${esc(S.salon?.name || '')}</span>
      <h1 class="rv"${dl(60)}>${S.tab === 'staff' ? 'Наши мастера' : 'Услуги и цены'}</h1>
      <p class="rv"${dl(120)}>${S.tab === 'staff' ? 'Посмотрите работы и отзывы. Записаться можно по телефону салона.' : 'Точную стоимость мастер назовёт на консультации, она зависит от длины, объёма и сложности.'}</p></section>
      ${tabs}${errBox()}${body}`;
  }

  // Мастер работает и в другом салоне — клиенту полезно: можно выбрать точку ближе
  const alsoLine = (m) => !m.also?.length ? '' : `<div class="m-also">${S.salons.length === 2
    ? 'Принимает в обоих салонах' : 'Принимает также: ' + esc(m.also.join(', '))}</div>`;

  function master() {
    const m = S.master;
    // .mp-side / .mp-main: на компьютере — две колонки (portal.css), на телефоне — одна
    return `<div class="mp"><div class="mp-side">
      <section class="hero">${photo(m, 'hero-ph' + (S.heroAnim ? ' rv-ph' : ''))}<div class="hero-t rv"${dl(S.heroAnim ? 260 : 160)}><h1>${esc(m.name)}</h1><div class="m-spec">${esc(m.specialization)}</div>${alsoLine(m)}${rating(m)}</div></section>
      ${m.bio ? `<section class="sec bio rv"${dl(320)}><p>${esc(m.bio).replace(/\n+/g, '</p><p>')}</p></section>` : ''}
      </div><div class="mp-main">
      <section class="sec rv"${dl(240)}><span class="eyebrow">Работы</span>
        ${m.works?.length ? `<div class="works">${m.works.map((w, i) => tile(w, i)).join('')}</div>` : '<p class="empty">Мастер ещё не добавил работы.</p>'}</section>
      <section class="sec rv"${dl(300)}><span class="eyebrow">Услуги и цены</span>${errBox()}
        ${S.masterServices.length ? svcGroups(S.masterServices, true, true) : skel(3)}</section>
      <section class="sec rv"${dl(360)} id="reviews"><div class="sec-h"><span class="eyebrow">Отзывы</span>
        <button class="link" type="button" data-act="review">Оставить отзыв</button></div>
        ${S.reviews === null ? skel(2) : S.reviews.length ? S.reviews.map(r => `
          <article class="rev in"><div class="rev-h">${stars(r.rating)}<span class="rev-d">${shortDate(r.date)}</span></div>
            ${r.text ? `<p>${esc(r.text)}</p>` : ''}<span class="rev-a">${esc(r.author)}</span></article>`).join('')
        : '<p class="empty">Отзывов пока нет. Ваш может стать первым.</p>'}</section>
      </div></div>`;
  }

  function review() {
    const f = S.rform, m = S.master;
    return `<section class="intro"><span class="eyebrow rv">Отзыв о мастере · ${esc(m.name)}</span><h1 class="rv"${dl(60)}>Как прошёл визит?</h1>
      <p class="rv"${dl(120)}>Отзыв прочитают мастер и руководство салона. Регистрация не нужна.</p></section>
      <div class="picker rv"${dl(180)} role="radiogroup" aria-label="Оценка">
        ${[1, 2, 3, 4, 5].map(n => `<button type="button" class="star" role="radio" data-star="${n}" aria-checked="${f.rating === n}"${dl((n - 1) * 45)}
          aria-label="${n} из 5 — ${RATING_WORDS[n]}"${n <= f.rating ? ' data-on' : ''}>${STAR_SVG}</button>`).join('')}
      </div>
      <p class="picker-l">${f.rating ? RATING_WORDS[f.rating] : 'Нажмите на звезду'}</p>
      <form class="form rv"${dl(240)} id="rform" novalidate>
        <div class="field"><label for="rtext">${f.rating && f.rating <= 3 ? 'Что пошло не так? Мы разберёмся' : 'Что понравилось, что стоит улучшить'}</label>
          <textarea id="rtext" maxlength="1000" placeholder="Например: аккуратная работа, помогла выбрать оттенок">${esc(f.text)}</textarea></div>
        <div class="field"><label for="rauthor">Как подписать отзыв</label>
          <input id="rauthor" maxlength="40" autocomplete="given-name" value="${esc(f.author)}" placeholder="Анна или Анна К.">
          <span class="hint">На сайте покажем только это имя.</span></div>
        <div class="field"><label for="rphone">Телефон <span class="hint">(необязательно)</span></label>
          <input id="rphone" type="tel" inputmode="tel" autocomplete="tel" value="${esc(f.phone)}" placeholder="+7 (9__) ___-__-__">
          <span class="hint">Оставьте, если хотите, чтобы салон с вами связался. На сайте номер не показываем.</span></div>
        <div class="hp" aria-hidden="true"><label for="website">Сайт</label><input id="website" tabindex="-1" autocomplete="off"></div>
        <label class="consent"><input type="checkbox" id="rpublish"${f.publish ? ' checked' : ''}>
          <span>Разрешаю опубликовать отзыв на сайте под указанным именем (<a href="/consent-publish" target="_blank" rel="noopener">согласие на распространение</a>). Без этой отметки его прочитает только салон.</span></label>
        <label class="consent"><input type="checkbox" id="rconsent"${f.consent ? ' checked' : ''}>
          <span>Даю <a href="/consent" target="_blank" rel="noopener">согласие на обработку персональных данных</a>, указанных в отзыве, на условиях <a href="/privacy" target="_blank" rel="noopener">политики</a>.</span></label>
      </form>${errBox()}`;
  }

  function reviewDone() {
    const r = S.reviewResult || {};
    const low = r.low;
    const left = Boolean(S.rform.phone);
    let text;
    if (low && left) text = 'Нам жаль, что визит оставил такое впечатление. Руководство салона свяжется с вами в ближайшее время, чтобы разобраться и всё исправить.';
    else if (low) text = 'Нам жаль, что визит оставил такое впечатление. Если хотите, чтобы мы разобрались и всё исправили, позвоните в салон: руководство ответит лично.';
    else if (S.rform.publish) text = 'Опубликуем его после проверки, обычно в течение дня. Мастер обязательно прочитает.';
    else text = 'Отзыв получит только салон, на сайте его не будет. Мастер обязательно прочитает.';
    return `<section class="done"><div class="ok${low ? ' ok-warm' : ''}"><svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">${low
      ? '<path pathLength="1" d="M4 5h16v11H9l-5 4z" fill="none" stroke="currentColor" stroke-width="1.6"/>'
      : '<path pathLength="1" d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2"/>'}</svg></div>
      <h1 class="rv"${dl(200)}>${low ? 'Спасибо, что рассказали' : 'Спасибо за отзыв'}</h1>
      <div class="rv"${dl(260)}>${stars(S.rform.rating)}</div>
      <p class="rv"${dl(320)}>${text}</p>
      <button class="btn-ghost rv"${dl(380)} type="button" id="toMaster">Вернуться к мастеру</button></section>`;
  }

  // --- телефоны салонов -----------------------------------------------------
  // Текущий салон — первым: клиент смотрит его мастеров и чаще всего звонит туда же.
  function openCall() {
    const list = [...S.salons].sort((a, b) => (String(b.id) === String(S.salon?.id)) - (String(a.id) === String(S.salon?.id)));
    $('sheetList').innerHTML = list.map(s => {
      const current = String(s.id) === String(S.salon?.id);
      return `<div class="salon${current ? ' current' : ''}">
        <div class="salon-h"><span class="salon-n">${esc(s.name)}</span>${current ? '<span class="tag">Вы смотрите этот салон</span>' : ''}</div>
        ${s.address ? `<div class="salon-a">${esc(s.address)}</div>` : ''}
        ${s.phone ? `<div class="salon-p">${esc(s.phone)}</div>
          <div class="salon-btns">
            <a class="btn" href="${telHref(s.phone)}">${PHONE_SVG}<span>Позвонить</span></a>
            <button class="btn-ghost" type="button" data-copy="${esc(s.phone)}">Скопировать номер</button>
          </div>` : '<div class="salon-a">Телефон уточняется</div>'}
        ${s.hours ? `<div class="salon-a">${esc(s.hours)}</div>` : ''}
      </div>`;
    }).join('');
    $('sheet').hidden = false;
    $('sheetClose').focus();
  }
  const closeSheet = () => { $('sheet').hidden = true; };

  async function copyPhone(btn) {
    const v = btn.dataset.copy;
    try { await navigator.clipboard.writeText(v); btn.textContent = 'Скопировано'; }
    catch {
      // буфер обмена недоступен — выделяем номер, чтобы скопировать вручную
      const p = btn.closest('.salon').querySelector('.salon-p');
      const r = document.createRange(); r.selectNodeContents(p);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      btn.textContent = 'Номер выделен';
    }
    setTimeout(() => { btn.textContent = 'Скопировать номер'; }, 1800);
  }

  // --- отрисовка ------------------------------------------------------------
  function bar() {
    const b = $('bar'), sum = $('barSum'), btn = $('barBtn');
    let label = 'Позвонить в салон', text = '', enabled = true, call = true;
    if (S.screen === 'review') {
      call = false; label = S.busy ? 'Отправляем…' : 'Отправить отзыв'; enabled = Boolean(S.rform.rating) && !S.busy;
      text = S.rform.rating ? `<b class="gold">${'★'.repeat(S.rform.rating)}</b><span>${RATING_WORDS[S.rform.rating]}</span>` : '<span>Поставьте оценку</span>';
    } else if (S.screen === 'master' && S.master) {
      text = `<b>Записаться к мастеру</b><span>${esc(S.master.name)}, по телефону салона</span>`;
    } else {
      text = `<b>Записаться</b><span>по телефону салона</span>`;
    }
    b.hidden = !S.salon;
    sum.innerHTML = text;
    btn.innerHTML = call ? `${PHONE_SVG}<span>${label}</span>` : esc(label);
    btn.disabled = !enabled;
  }

  // «Часы» появления (см. «движение» в portal.css): когда сменился экран (--t0), пришли
  // данные (--t1), выбран фильтр (--t2). Ключ тот же — часы идут дальше, и анимации
  // перерисованного экрана продолжаются с того же места, а не начинаются заново.
  const CLOCKS = {};
  function clock(name, key) {
    const c = CLOCKS[name] || (CLOCKS[name] = {});
    if (c.key !== key) { c.key = key; c.at = performance.now(); }
    app.style.setProperty('--' + name, Math.round(c.at - performance.now()) + 'ms');
  }

  // Бегунок под выбранной кнопкой (салон, вкладка): едет со старого места на новое
  const IND = {};
  function indicator(box, name, animate = true) {
    const on = box && box.offsetParent && box.querySelector('[aria-selected="true"]');
    if (!on) return;
    const now = { x: on.offsetLeft, w: on.offsetWidth }, was = IND[name];
    IND[name] = now;
    const set = (p) => { box.style.setProperty('--ix', p.x + 'px'); box.style.setProperty('--iw', p.w + 'px'); };
    box.classList.add('has-ind');
    if (!animate || !was || (was.x === now.x && was.w === now.w)) return set(now);
    box.classList.remove('ind-anim'); set(was);
    void box.offsetWidth; // зафиксировать старое место, чтобы был переход
    box.classList.add('ind-anim'); set(now);
  }

  function render() {
    $('salons').innerHTML = S.salons.map(s =>
      `<button type="button" role="tab" data-salon="${s.id}" aria-selected="${String(S.salon?.id) === String(s.id)}">${esc(s.name)}</button>`).join('');
    $('salons').hidden = S.screen !== 'home';
    $('back').hidden = !S.stack.length;
    const screen = [S.screen, S.salon?.id, S.tab, S.master?.id].join('|');
    clock('t0', screen);
    clock('t1', screen + '|' + (S.staff.length > 0));
    clock('t2', screen + '|' + (S.staff.length > 0) + '|' + S.group);
    const screens = { home, master, review, reviewDone };
    app.innerHTML = S.salon ? screens[S.screen]() : `<section class="intro">${errBox() || skel(3)}</section>`;
    app.dataset.screen = S.screen; // ширина колонки зависит от экрана: форма отзыва уже, список мастеров шире
    // полоса фильтров перерисовывается с начала — возвращаем выбранный фильтр в поле зрения
    const on = app.querySelector('.chip[aria-pressed="true"]');
    if (on && on.parentElement) on.parentElement.scrollLeft = Math.max(0, on.offsetLeft - on.parentElement.offsetLeft - 16);
    indicator($('salons'), 'salons');
    indicator(app.querySelector('.tabs'), 'tabs');
    bar();
  }

  // Шапка в прокрутке — плотнее, с тенью и размытием (portal.css: .top.scrolled)
  const topBar = document.querySelector('.top');
  const onScroll = () => topBar.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', () => {
    indicator($('salons'), 'salons', false);
    indicator(app.querySelector('.tabs'), 'tabs', false);
  });

  // --- события --------------------------------------------------------------
  document.addEventListener('click', (e) => {
    const el = e.target.closest('button');
    if (!el) return;
    const d = el.dataset;
    if (el.id === 'back') return history.state ? history.back() : back();
    if (d.salon) return loadSalon(d.salon);
    if (d.tab) { S.tab = d.tab; return render(); }
    if ('group' in d) { S.group = d.group; return render(); }
    if (d.master) return openMaster(d.master, el.querySelector('.card-ph'));
    if (d.work) return openWork(Number(d.work));
    if (d.star) { S.rform.rating = Number(d.star); S.error = ''; return render(); }
    if (d.act === 'review') return openReview();
    if (d.copy) return copyPhone(el);
    if (el.id === 'toMaster') { S.screen = S.stack.pop() || 'home'; render(); return window.scrollTo(0, 0); }
    if (el.id === 'lbClose') return ($('lb').hidden = true);
    if (el.id === 'sheetClose') return closeSheet();
    if (el.id === 'barBtn') return S.screen === 'review' ? submitReview() : openCall();
  });
  $('lb').addEventListener('click', (e) => { if (e.target.id === 'lb') $('lb').hidden = true; });
  $('sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('lb').hidden = true; closeSheet(); } });

  function openWork(i) {
    const w = S.master?.works?.[i];
    if (!w) return;
    const box = $('lbImg');
    box.innerHTML = w.src ? `<img src="${esc(w.src)}" alt="${esc(w.caption)}">` : '';
    box.style.background = w.tone ? `linear-gradient(145deg,${w.tone[0]},${w.tone[1]})` : '';
    $('lbCap').textContent = w.caption || '';
    $('lb').hidden = false;
  }

  // Телефон в форме отзыва — с маской +7 (9XX) XXX-XX-XX
  function maskPhone(v) {
    let d = v.replace(/\D/g, '');
    if (d.startsWith('8')) d = '7' + d.slice(1);
    if (d && !d.startsWith('7')) d = '7' + d;
    d = d.slice(0, 11);
    const p = d.slice(1);
    let out = '+7';
    if (p.length) out += ' (' + p.slice(0, 3);
    if (p.length >= 3) out += ')';
    if (p.length > 3) out += ' ' + p.slice(3, 6);
    if (p.length > 6) out += '-' + p.slice(6, 8);
    if (p.length > 8) out += '-' + p.slice(8, 10);
    return d ? out : '';
  }
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'rphone') { t.value = maskPhone(t.value); S.rform.phone = t.value.replace(/\D/g, '').length > 1 ? t.value : ''; }
    else if (t.id === 'rtext') S.rform.text = t.value;
    else if (t.id === 'rauthor') S.rform.author = t.value;
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'rconsent') S.rform.consent = e.target.checked;
    if (e.target.id === 'rpublish') S.rform.publish = e.target.checked;
  });
  document.addEventListener('submit', (e) => { e.preventDefault(); submitReview(); });

  // Ссылка …#review ведёт сразу к форме отзыва (её можно присылать после визита)
  async function openFromHash() {
    if (location.hash !== '#review' || !S.staff[0]) return;
    await openMaster(S.staff[0].id);
    openReview();
  }
  window.addEventListener('hashchange', openFromHash);

  // --- старт ----------------------------------------------------------------
  (async function start() {
    render();
    try {
      const [salons, health] = await Promise.all([call('GET', '/p/api/salons'), call('GET', '/p/api/health').catch(() => ({}))]);
      S.salons = salons;
      $('demoNote').hidden = !health.demo;
      let saved = null;
      try { saved = localStorage.getItem('prive.salon'); } catch { /* без памяти */ }
      await loadSalon(saved || salons[0]?.id);
      openFromHash();
    } catch (e) { S.error = e.message; render(); }
  })();
})();
