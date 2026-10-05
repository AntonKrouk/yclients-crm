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

  // Оформление: «Стекло» (основное с 05.10.2026, по референсу Антона) или «Бумага» (как CRM,
  // прежний вид). Выбор — переключателем в демо-плашке или ссылкой ?look=paper / ?look=glass;
  // запоминается в браузере. В index.html «Стекло» прописано сразу, чтобы не мелькала бумага.
  const LOOKS = { paper: 'Бумага', glass: 'Стекло' };
  function setLook(look, save) {
    if (!LOOKS[look]) look = 'paper';
    if (look === 'paper') delete document.documentElement.dataset.look;
    else document.documentElement.dataset.look = look;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = look === 'glass' ? '#2A2522' : '#F6F4F0';
    if (save) try { localStorage.setItem('prive.look', look); } catch { /* без памяти */ }
    $('lookSw').innerHTML = Object.entries(LOOKS).map(([k, v]) =>
      `<button type="button" data-lk="${k}" aria-pressed="${k === look}"><span>${v}</span></button>`).join('');
    // отступы у оформлений разные — бегунки переставить на новые места
    indicator($('salons'), 'salons', false);
    indicator(app.querySelector('.tabs'), 'tabs', false);
    indicator(app.querySelector('.rail-in'), 'rail', false, '[aria-pressed="true"]');
  }
  function initLook() {
    const fromUrl = new URLSearchParams(location.search).get('look');
    let saved = null;
    try { saved = localStorage.getItem('prive.look'); } catch { /* без памяти */ }
    setLook(fromUrl || saved || 'glass', Boolean(fromUrl));
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
    // один атрибут style на оба свойства: второй такой же атрибут браузер молча отбрасывает
    const bg = w.tone ? `background:linear-gradient(145deg,${esc(w.tone[0])},${esc(w.tone[1])});` : '';
    return `<button class="tile rv-tile" type="button" style="${bg}--d:${320 + Math.min(i, 11) * 45}ms" data-work="${i}" aria-label="${esc(w.caption || 'Работа')}">${inner}</button>`;
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
  // и специализации из YClients. Строки — в порядке показа (Антон, 05.10.2026), третье
  // поле — значок в боковом меню. Тот же список — в src/vitrina.js.
  const GROUPS = [
    ['Стилисты', /стилист|парикмахер|колорист|барбер|волос|hair/i, 'hair'],
    ['Визажисты', /визаж|макияж|make-?up/i, 'makeup'],
    ['Брови и ресницы', /бров|ресниц|лэш|lash/i, 'lash'],
    ['Мастера маникюра/педикюра', /маникюр|педикюр|ногт|nail/i, 'nail'],
    ['Косметологи', /космет|эстетист|дерматолог/i, 'skin'],
    ['Массажисты', /массаж|spa|спа-/i, 'massage'],
    ['Мастера перманента', /перманент|татуаж|pmu/i, 'pmu'],
  ];
  // Порядок проверки другой: «перманентный макияж бровей» содержит и «макияж», и «бров» —
  // перманент первым; «Косметолог, массаж лица» — в косметологию; «визажист-бровист» — в брови.
  const MATCH = ['Мастера перманента', 'Стилисты', 'Мастера маникюра/педикюра', 'Брови и ресницы',
    'Косметологи', 'Массажисты', 'Визажисты'].map(n => GROUPS.find(([g]) => g === n));
  const OTHER = 'Другие мастера';
  function groupOf(m) {
    if (m.direction) return m.direction; // сервер уже учёл выбор админа в CRM
    const text = `${m.position || ''} ${m.specialization || ''}`;
    const hit = MATCH.find(([, re]) => re.test(text));
    return hit ? hit[0] : (m.position || OTHER);
  }

  // Значки направлений: тонкая линия в одну толщину, как стрелка «назад» и телефон
  const ICONS = {
    all: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/>',
    hair: '<circle cx="6.5" cy="6.5" r="2.6"/><circle cx="6.5" cy="17.5" r="2.6"/><path d="M8.6 8 20 17.2M8.6 16 20 6.8"/>',
    makeup: '<path d="M8 21h8v-7.5H8z"/><path d="M9.3 13.5V8.6L14.7 5v8.5"/><path d="M8 17h8"/>',
    lash: '<path d="M3 13c2.6-3.4 5.6-5 9-5s6.4 1.6 9 5c-2.6 3.4-5.6 5-9 5s-6.4-1.6-9-5z"/><circle cx="12" cy="13" r="2.4"/><path d="M12 8V5.2M8 8.8 6.6 6.4M16 8.8l1.4-2.4M4.8 10.6 3 9M19.2 10.6 21 9"/>',
    nail: '<path d="M10 3h4v4.6h-4z"/><path d="M7.2 11a3 3 0 0 1 3-3.4h3.6a3 3 0 0 1 3 3.4V18a3 3 0 0 1-3 3h-3.6a3 3 0 0 1-3-3z"/><path d="M7.2 13.5h9.6"/>',
    skin: '<path d="M12 3.2c2.8 3.5 5 6.3 5 9.3a5 5 0 0 1-10 0c0-3 2.2-5.8 5-9.3z"/><path d="M9.7 13a2.4 2.4 0 0 0 2.3 2.4"/>',
    massage: '<ellipse cx="12" cy="18.3" rx="7.5" ry="2.4"/><ellipse cx="12" cy="13" rx="5.4" ry="2.2"/><ellipse cx="12" cy="8.2" rx="3.4" ry="1.8"/><path d="M12 6.4c0-1.7.8-2.8 2.4-3.4"/>',
    pmu: '<path d="M14.6 4.2l5.2 5.2-9.4 9.4-4.4 1 1-4.4z"/><path d="M12.6 6.2l5.2 5.2M4 20l2-2"/>',
    other: '<circle cx="6" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18" cy="12" r="1.4"/>',
  };
  const iconOf = (g) => (g === '' ? 'all' : (GROUPS.find(([n]) => n === g) || [])[2] || 'other');
  const icon = (key) => `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${ICONS[key]}</svg>`;
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
  const CHAT_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4.5 5.5h15v10.5H10l-4.5 3.5V16h-1z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  const WA_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4.4 19.6l1.1-3.9a8.1 8.1 0 1 1 3 2.9z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9.2 8.3c.3-.4.7-.4 1-.3l.9 2-.7.9c.6 1.1 1.5 2 2.6 2.6l.9-.7 2 .9c.1.3.1.7-.3 1-.9.7-2.3.6-3.8-.3a9.4 9.4 0 0 1-3-3c-.9-1.5-1-2.9-.3-3.8z" fill="currentColor"/></svg>';
  const TG_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M21 4.6 3.6 11.3c-.7.3-.7 1.3 0 1.6l4.2 1.5 1.6 4.9c.2.6 1 .8 1.5.3l2.3-2.2 4.3 3.2c.6.4 1.4.1 1.6-.6l3-13.9c.2-.9-.6-1.6-1.1-1.5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M7.8 14.4 17.5 8l-7.4 7.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  const PHONE_SVG ='<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6.6 3.5h3l1.5 4-2 1.3a11 11 0 0 0 6.1 6.1l1.3-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';

  const errBox = () => (S.error ? `<p class="err" role="alert">${esc(S.error)}</p>` : '');
  const skel = (n) => Array.from({ length: n }, () => '<div class="skel"></div>').join('');

  // --- экраны ---------------------------------------------------------------
  // Мастера выбранного направления. Одна сплошная сетка: разделы по одному мастеру
  // оставляли бы полстроки пустыми. Направление над именем не подписываем (Антон,
  // 04.10.2026): специализация и так под именем.
  function roster(groups) {
    const shown = S.group ? groups.filter(([g]) => g === S.group) : groups;
    const list = shown.flatMap(([, ms]) => ms);
    return `<div class="roster"><div class="roster-h rv2"><h2>${esc(S.group || 'Все мастера')}</h2>
        <span>${list.length} ${plural(list.length, 'мастер', 'мастера', 'мастеров')}</span></div>
      <div class="cards">${list.map((m, i) => masterCard(m, i)).join('')}</div></div>`;
  }

  // Смена направления — без перерисовки всего экрана: меню остаётся на месте, поэтому
  // выбранный пункт плавно раскрывается, а бегунок переезжает (portal.css, «меню»)
  function pickGroup(g) {
    S.group = g;
    const r = app.querySelector('.roster');
    if (!r) return render();
    app.querySelectorAll('.ri').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.group === g)));
    clocks();
    r.outerHTML = roster(grouped(S.staff));
    indicator(app.querySelector('.rail-in'), 'rail', true, '[aria-pressed="true"]');
    // на телефоне пункт меню у края ряда — подвинуть его в середину
    const on = app.querySelector('.ri[aria-pressed="true"]');
    if (on) centerInRow(on, calm() ? 'auto' : 'smooth');
  }
  // Ряд прокручивается вбок только на телефоне; на компьютере scrollTo ничего не сдвинет
  function centerInRow(el, behavior = 'auto') {
    const row = el.parentElement;
    row.scrollTo({ left: Math.max(0, el.offsetLeft - (row.clientWidth - el.offsetWidth) / 2), behavior });
  }

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
      // Боковое меню направлений: значки, название — у выбранного (телефон) или при
      // наведении на меню (компьютер). Разметка одна, раскладку решает portal.css.
      const item = (g, n, i) => `<button class="ri" type="button" data-group="${esc(g)}" aria-pressed="${S.group === g}" style="--i:${i}">
          <span class="ri-ic">${icon(iconOf(g))}</span><span class="ri-l">${esc(g || 'Все мастера')}<span class="ri-n">${n}</span></span></button>`;
      const rail = groups.length > 1 ? `<nav class="rail rv1"${dl(60)} aria-label="Направление"><div class="rail-in">
        ${item('', S.staff.length, 0)}${groups.map(([g, ms], i) => item(g, ms.length, i + 1)).join('')}
      </div></nav>` : '';
      body = `<div class="staff-l">${rail}${roster(groups)}</div>`;
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
    $('sheetTitle').textContent = 'Позвонить в салон';
    $('sheetSub').textContent = 'Администратор подберёт время и мастера.';
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

  // --- написать в мессенджер ------------------------------------------------
  // WhatsApp открывается с готовым текстом («хочу записаться к мастеру …»); Telegram
  // текст в личный чат подставлять не умеет — просто открывает переписку с салоном.
  const canWrite = () => S.salons.some(s => s.whatsapp || s.telegram);
  function waText(s) {
    const m = S.screen !== 'home' ? S.master : null;
    const here = m && (String(s.id) === String(S.salon?.id) || (m.also || []).includes(s.name));
    return here ? `Здравствуйте! Хочу записаться к мастеру ${m.name}, салон Privé7 ${s.name}.`
      : `Здравствуйте! Хочу записаться в Privé7, салон ${s.name}.`;
  }
  function openWrite() {
    const list = [...S.salons].sort((a, b) => (String(b.id) === String(S.salon?.id)) - (String(a.id) === String(S.salon?.id)));
    $('sheetTitle').textContent = 'Написать в салон';
    $('sheetSub').textContent = 'Ответим в мессенджере: подберём время и мастера.';
    $('sheetList').innerHTML = list.map(s => {
      const current = String(s.id) === String(S.salon?.id);
      const wa = s.whatsapp ? `<a class="btn btn-wa" href="https://wa.me/${esc(s.whatsapp)}?text=${encodeURIComponent(waText(s))}" target="_blank" rel="noopener">${WA_SVG}<span>WhatsApp</span></a>` : '';
      const tg = s.telegram ? `<a class="btn btn-tg" href="https://t.me/${esc(s.telegram)}" target="_blank" rel="noopener">${TG_SVG}<span>Telegram</span></a>` : '';
      return `<div class="salon${current ? ' current' : ''}">
        <div class="salon-h"><span class="salon-n">${esc(s.name)}</span>${current ? '<span class="tag">Вы смотрите этот салон</span>' : ''}</div>
        ${s.address ? `<div class="salon-a">${esc(s.address)}</div>` : ''}
        ${wa || tg ? `<div class="salon-btns">${wa}${tg}</div>` : '<div class="salon-a">Мессенджеры уточняются — позвоните, пожалуйста</div>'}
        ${s.hours ? `<div class="salon-a">${esc(s.hours)}</div>` : ''}
      </div>`;
    }).join('');
    $('sheet').hidden = false;
    $('sheetClose').focus();
  }

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
    const b = $('bar'), sum = $('barSum'), btn = $('barBtn'), write = canWrite();
    // с кнопкой «Написать» рядом надпись короче — две кнопки должны влезть на телефоне
    let label = write ? 'Позвонить' : 'Позвонить в салон', text = '', enabled = true, call = true;
    const how = write ? 'звонком или в мессенджере' : 'по телефону салона';
    if (S.screen === 'review') {
      call = false; label = S.busy ? 'Отправляем…' : 'Отправить отзыв'; enabled = Boolean(S.rform.rating) && !S.busy;
      text = S.rform.rating ? `<b class="gold">${'★'.repeat(S.rform.rating)}</b><span>${RATING_WORDS[S.rform.rating]}</span>` : '<span>Поставьте оценку</span>';
    } else if (S.screen === 'master' && S.master) {
      text = `<b>Записаться к мастеру</b><span>${esc(S.master.name)}, ${how}</span>`;
    } else {
      text = `<b>Записаться</b><span>${how}</span>`;
    }
    b.hidden = !S.salon;
    b.classList.toggle('two', call && write);
    sum.innerHTML = text;
    btn.innerHTML = call ? `${PHONE_SVG}<span>${label}</span>` : esc(label);
    btn.disabled = !enabled;
    $('barWrite').hidden = !(call && write);
    $('barWrite').innerHTML = `${CHAT_SVG}<span>Написать</span>`;
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

  // Бегунок под выбранной кнопкой (салон, вкладка, пункт меню): едет со старого места
  // на новое. Ставит --ix/--iw (по горизонтали) и --iy/--ih (по вертикали, меню)
  const IND = {};
  function indicator(box, name, animate = true, sel = '[aria-selected="true"]') {
    const on = box && box.offsetParent && box.querySelector(sel);
    if (!on) return;
    const now = { x: on.offsetLeft, w: on.offsetWidth, y: on.offsetTop, h: on.offsetHeight }, was = IND[name];
    IND[name] = now;
    const set = (p) => { for (const k of ['x', 'w', 'y', 'h']) box.style.setProperty('--i' + k, p[k] + 'px'); };
    box.classList.add('has-ind');
    if (!animate || !was || ['x', 'w', 'y', 'h'].every(k => was[k] === now[k])) return set(now);
    box.classList.remove('ind-anim'); set(was);
    void box.offsetWidth; // зафиксировать старое место, чтобы был переход
    box.classList.add('ind-anim'); set(now);
  }

  function clocks() {
    const screen = [S.screen, S.salon?.id, S.tab, S.master?.id].join('|');
    clock('t0', screen);
    clock('t1', screen + '|' + (S.staff.length > 0));
    clock('t2', screen + '|' + (S.staff.length > 0) + '|' + S.group);
  }

  function render() {
    $('salons').innerHTML = S.salons.map(s =>
      `<button type="button" role="tab" data-salon="${s.id}" aria-selected="${String(S.salon?.id) === String(s.id)}">${esc(s.name)}</button>`).join('');
    $('salons').hidden = S.screen !== 'home';
    $('back').hidden = !S.stack.length;
    clocks();
    const screens = { home, master, review, reviewDone };
    app.innerHTML = S.salon ? screens[S.screen]() : `<section class="intro">${errBox() || skel(3)}</section>`;
    app.dataset.screen = S.screen; // ширина колонки зависит от экрана: форма отзыва уже, список мастеров шире
    // ряд направлений (телефон) перерисовывается с начала — возвращаем выбранное в поле зрения
    const on = app.querySelector('.ri[aria-pressed="true"]');
    if (on) centerInRow(on);
    indicator($('salons'), 'salons');
    indicator(app.querySelector('.tabs'), 'tabs');
    indicator(app.querySelector('.rail-in'), 'rail', true, '[aria-pressed="true"]');
    bar();
  }

  // Шапка в прокрутке — плотнее, с тенью и размытием (portal.css: .top.scrolled)
  const topBar = document.querySelector('.top');
  const onScroll = () => topBar.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', () => {
    indicator($('salons'), 'salons', false);
    indicator(app.querySelector('.tabs'), 'tabs', false);
    indicator(app.querySelector('.rail-in'), 'rail', false, '[aria-pressed="true"]');
  });

  // --- события --------------------------------------------------------------
  document.addEventListener('click', (e) => {
    const el = e.target.closest('button');
    if (!el) return;
    const d = el.dataset;
    if (d.lk) return morph(() => setLook(d.lk, true)); // плавная смена всего экрана
    if (el.id === 'back') return history.state ? history.back() : back();
    if (d.salon) return loadSalon(d.salon);
    if (d.tab) { S.tab = d.tab; return render(); }
    if ('group' in d) return pickGroup(d.group);
    if (d.master) return openMaster(d.master, el.querySelector('.card-ph'));
    if (d.work) return openWork(Number(d.work));
    if (d.star) { S.rform.rating = Number(d.star); S.error = ''; return render(); }
    if (d.act === 'review') return openReview();
    if (d.copy) return copyPhone(el);
    if (el.id === 'toMaster') { S.screen = S.stack.pop() || 'home'; render(); return window.scrollTo(0, 0); }
    if (el.id === 'lbClose') return ($('lb').hidden = true);
    if (el.id === 'lbPrev') return stepWork(-1);
    if (el.id === 'lbNext') return stepWork(1);
    if (el.id === 'sheetClose') return closeSheet();
    if (el.id === 'barBtn') return S.screen === 'review' ? submitReview() : openCall();
    if (el.id === 'barWrite') return openWrite();
  });
  $('lb').addEventListener('click', (e) => { if (e.target.id === 'lb') $('lb').hidden = true; });
  $('sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { $('lb').hidden = true; closeSheet(); }
    if (!$('lb').hidden && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) stepWork(e.key === 'ArrowLeft' ? -1 : 1);
  });

  // Просмотр работ: листается стрелками, свайпом (и перетаскиванием мышью), клавишами ← →.
  // По кругу: после последней — первая.
  let lbAt = 0;
  const works = () => S.master?.works || [];
  function openWork(i) {
    if (!works()[i]) return;
    lbAt = i;
    showWork(0);
    $('lb').hidden = false;
  }
  // dir: 1 — пришла следующая (въезжает справа), -1 — предыдущая (слева), 0 — без анимации
  function showWork(dir) {
    const list = works(), w = list[lbAt];
    if (!w) return;
    const box = $('lbImg');
    box.innerHTML = w.src ? `<img src="${esc(w.src)}" alt="${esc(w.caption)}" draggable="false">` : '';
    box.style.background = w.tone ? `linear-gradient(145deg,${w.tone[0]},${w.tone[1]})` : '';
    $('lbCap').textContent = w.caption || '';
    $('lbCount').textContent = list.length > 1 ? `${lbAt + 1} / ${list.length}` : '';
    $('lbPrev').hidden = $('lbNext').hidden = list.length < 2;
    // соседние фото — загрузить заранее, чтобы листалось без пустой паузы
    for (const d of [1, -1]) { const n = list[(lbAt + d + list.length) % list.length]; if (n?.src) new Image().src = n.src; }
    if (dir && !calm() && box.animate) box.animate(
      [{ transform: `translateX(${dir * 48}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }],
      { duration: 340, easing: 'cubic-bezier(.2,.7,.2,1)' });
  }
  function stepWork(d) {
    const n = works().length;
    if (n < 2) return;
    lbAt = (lbAt + d + n) % n;
    showWork(d);
  }
  // Свайп: фото едет за пальцем; сдвинули больше чем на 50 px — листаем, меньше — возвращается
  {
    const box = $('lbImg');
    let drag = null;
    const reset = () => { drag = null; box.style.transform = ''; box.style.opacity = ''; };
    box.addEventListener('pointerdown', (e) => {
      if (works().length < 2) return;
      drag = { x: e.clientX };
      box.setPointerCapture(e.pointerId);
    });
    box.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      box.style.transform = `translateX(${dx}px)`;
      box.style.opacity = String(1 - Math.min(Math.abs(dx) / 500, 0.35));
    });
    box.addEventListener('pointerup', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      reset();
      if (Math.abs(dx) > 50) stepWork(dx < 0 ? 1 : -1);
    });
    box.addEventListener('pointercancel', reset);
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
    initLook();
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
