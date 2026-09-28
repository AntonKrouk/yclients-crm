'use strict';

// Клиентская запись Privé7. Два пути к записи:
//   мастер → его работы и услуги → время → контакты
//   услуги → кто их делает → время → контакты
// Превью-страница подменяет сервер через window.PORTAL_API (demo.js в браузере).

(function () {
  const $ = (id) => document.getElementById(id);
  const app = $('app');

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rub = (n) => Number(n || 0).toLocaleString('ru-RU') + ' ₽';
  const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)} ч${m % 60 ? ' ' + (m % 60) + ' мин' : ''}` : `${m} мин`);
  const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  const MON = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const dayOf = (ymd) => new Date(ymd + 'T12:00:00');
  const longDate = (ymd) => { const d = dayOf(ymd); return `${WD[d.getDay()]}, ${d.getDate()} ${MON[d.getMonth()]}`; };
  const plural = (n, a, b, c) => { const m = n % 100, k = n % 10; return m > 10 && m < 20 ? c : k === 1 ? a : k > 1 && k < 5 ? b : c; };
  const CHECK = '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4"/></svg>';

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
    salons: [], salon: null, tab: 'staff',
    staff: [], services: [],            // справочники салона
    screen: 'home', stack: [],
    master: null, masterServices: [],   // выбранный мастер и что он делает
    picked: new Set(),                  // выбранные услуги (id)
    candidates: [],                     // мастера под выбранные услуги
    dates: [], date: '', times: [], slot: null,
    form: { name: '', phone: '', comment: '', consent: false },
    result: null, error: '', busy: false,
  };

  const svcList = () => (S.master ? S.masterServices : S.services);
  const pickedSvcs = () => svcList().filter(s => S.picked.has(s.id));
  function totals(list) {
    const min = list.reduce((a, s) => a + (s.price_min || 0), 0);
    const max = list.reduce((a, s) => a + (s.price_max || s.price_min || 0), 0);
    const minutes = list.reduce((a, s) => a + (s.duration || 0), 0);
    return { price: (max > min ? 'от ' : '') + rub(min), minutes };
  }

  function go(screen) {
    S.stack.push(S.screen);
    S.screen = screen; S.error = '';
    try { history.pushState({ s: screen }, ''); } catch { /* превью */ }
    render(); window.scrollTo(0, 0);
  }
  function back() {
    if (!S.stack.length) return;
    S.screen = S.stack.pop(); S.error = '';
    if (S.screen === 'home') { S.master = null; if (S.tab === 'staff') S.picked.clear(); }
    render(); window.scrollTo(0, 0);
  }
  window.addEventListener('popstate', () => back());

  // --- загрузка -------------------------------------------------------------
  async function loadSalon(id) {
    S.salon = S.salons.find(s => String(s.id) === String(id)) || S.salons[0];
    try { localStorage.setItem('prive.salon', S.salon.id); } catch { /* без памяти */ }
    S.staff = []; S.services = []; S.master = null; S.picked.clear(); S.stack = []; S.screen = 'home';
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

  async function openMaster(id) {
    S.master = S.staff.find(m => String(m.id) === String(id)) || S.candidates.find(m => String(m.id) === String(id));
    const fromServices = S.picked.size > 0 && S.screen === 'pick';
    if (!fromServices) S.picked.clear();
    S.masterServices = [];
    go('master');
    try { S.masterServices = await call('GET', '/p/api/services', { salon: S.salon.id, staff: S.master.id }); }
    catch (e) { S.error = e.message; }
    render();
  }

  async function openPick() {
    S.candidates = null;
    go('pick');
    try { S.candidates = await call('GET', '/p/api/staff', { salon: S.salon.id, services: [...S.picked].join(',') }); }
    catch (e) { S.error = e.message; S.candidates = []; }
    render();
  }

  async function openTime() {
    S.dates = null; S.date = ''; S.times = []; S.slot = null;
    go('time');
    try {
      const r = await call('GET', '/p/api/dates', { salon: S.salon.id, staff: S.master.id, services: [...S.picked].join(',') });
      S.dates = r.dates || [];
      if (S.dates[0]) await pickDate(S.dates[0]);
    } catch (e) { S.error = e.message; S.dates = []; }
    render();
  }

  async function pickDate(ymd) {
    S.date = ymd; S.times = null; S.slot = null; render();
    try { S.times = await call('GET', '/p/api/times', { salon: S.salon.id, staff: S.master.id, date: ymd, services: [...S.picked].join(',') }); }
    catch (e) { S.error = e.message; S.times = []; }
    render();
  }

  async function submit() {
    const f = S.form;
    S.error = '';
    if (f.name.trim().length < 2) S.error = 'Напишите, как к вам обращаться.';
    else if (f.phone.replace(/\D/g, '').length !== 11) S.error = 'Проверьте номер телефона: нужно 10 цифр после +7.';
    else if (!f.consent) S.error = 'Отметьте согласие на обработку данных, без него записать не получится.';
    if (S.error) return render();
    S.busy = true; render();
    try {
      S.result = await call('POST', '/p/api/book', {}, {
        salon: S.salon.id, staff_id: S.master.id, service_ids: [...S.picked],
        datetime: S.slot.datetime, name: f.name, phone: f.phone, comment: f.comment,
        consent: f.consent, website: $('website')?.value || '',
      });
      S.busy = false; S.stack = []; S.screen = 'done'; render(); window.scrollTo(0, 0);
    } catch (e) { S.busy = false; S.error = e.message; render(); }
  }

  // --- куски разметки -------------------------------------------------------
  const initials = (n) => esc(String(n || '?').trim().charAt(0).toUpperCase());
  const ava = (m, lg) => `<div class="ava${lg ? ' lg' : ''}">${m.avatar ? `<img src="${esc(m.avatar)}" alt="">` : initials(m.name)}</div>`;
  const rating = (m) => (m.rating ? `<div class="rate"><b>★ ${Number(m.rating).toFixed(1).replace('.', ',')}</b>${m.reviews ? ` · ${m.reviews} ${plural(m.reviews, 'отзыв', 'отзыва', 'отзывов')}` : ''}</div>` : '');
  function tile(w, i, zoom) {
    const inner = w.src ? `<img src="${esc(w.src)}" alt="${esc(w.caption)}" loading="lazy">` : '';
    const bg = w.tone ? ` style="background:linear-gradient(145deg,${esc(w.tone[0])},${esc(w.tone[1])})"` : '';
    return zoom
      ? `<button class="tile" type="button" data-work="${i}" aria-label="${esc(w.caption || 'Работа')}"${bg}>${inner}</button>`
      : `<div class="tile"${bg}>${inner}</div>`;
  }
  const svcRow = (s) => `
    <button class="svc" type="button" data-svc="${s.id}" aria-pressed="${S.picked.has(s.id)}">
      <span class="chk">${CHECK}</span>
      <span class="svc-t">${esc(s.title)}${s.duration ? `<small>${dur(s.duration)}</small>` : ''}</span>
      <span class="price">${s.price_max > s.price_min ? 'от ' : ''}${rub(s.price_min)}</span>
    </button>`;
  function svcGroups(list) {
    const cats = [];
    for (const s of list) {
      let c = cats.find(x => x.name === s.category);
      if (!c) cats.push(c = { name: s.category, items: [] });
      c.items.push(s);
    }
    return cats.map(c => `<section class="cat"><h2 class="eyebrow">${esc(c.name)}</h2>${c.items.map(svcRow).join('')}</section>`).join('');
  }
  const errBox = () => (S.error ? `<p class="err" role="alert">${esc(S.error)}</p>` : '');
  const skel = (n) => Array.from({ length: n }, () => '<div class="skel"></div>').join('');

  // --- экраны ---------------------------------------------------------------
  function home() {
    const tabs = `<div class="tabs" role="tablist">
      <button type="button" role="tab" data-tab="staff" aria-selected="${S.tab === 'staff'}">Мастера</button>
      <button type="button" role="tab" data-tab="services" aria-selected="${S.tab === 'services'}">Услуги и цены</button></div>`;
    const loading = !S.staff.length && !S.error;
    const body = S.tab === 'staff'
      ? `<div class="masters">${loading ? skel(3) : S.staff.map(m => `
          <button class="master" type="button" data-master="${m.id}">
            ${ava(m)}
            <span class="m-body">
              <span class="m-name">${esc(m.name)}</span>
              <span class="m-spec">${esc(m.specialization)}</span>
              ${rating(m)}
              ${m.works?.length ? `<span class="thumbs">${m.works.slice(0, 4).map((w, i) => tile(w, i)).join('')}</span>` : ''}
            </span>
          </button>`).join('')}</div>`
      : (loading ? skel(4) : svcGroups(S.services));
    return `<section class="intro"><span class="eyebrow">Онлайн-запись · ${esc(S.salon?.name || '')}</span>
      <h1>${S.tab === 'staff' ? 'Выберите мастера' : 'Выберите услуги'}</h1>
      <p>${S.tab === 'staff' ? 'Посмотрите работы и запишитесь на удобное время.' : 'Отметьте всё, что хотите сделать за визит, и мы покажем, кто из мастеров свободен.'}</p></section>
      ${tabs}${errBox()}${body}`;
  }

  function master() {
    const m = S.master;
    return `<section class="profile">${ava(m, true)}<div><h1>${esc(m.name)}</h1><div class="m-spec">${esc(m.specialization)}</div>${rating(m)}</div></section>
      <section class="sec"><span class="eyebrow">Работы</span>
        ${m.works?.length ? `<div class="works">${m.works.map((w, i) => tile(w, i, true)).join('')}</div>` : '<p class="empty">Мастер ещё не добавил работы.</p>'}</section>
      <section class="sec"><span class="eyebrow">Услуги и цены</span>${errBox()}
        ${S.masterServices.length ? svcGroups(S.masterServices).replace(/<section class="cat">/g, '<section class="cat" style="padding-top:10px">') : skel(3)}</section>`;
  }

  function pick() {
    const list = pickedSvcs();
    return `<section class="intro"><span class="eyebrow">Шаг 2 из 4</span><h1>Кто сделает</h1>
      <p>${esc(list.map(s => s.title).join(', '))}</p></section>${errBox()}
      <div class="masters">${S.candidates === null ? skel(2) : S.candidates.length ? S.candidates.map(m => `
        <button class="master" type="button" data-master="${m.id}">${ava(m)}
          <span class="m-body"><span class="m-name">${esc(m.name)}</span><span class="m-spec">${esc(m.specialization)}</span>${rating(m)}</span>
        </button>`).join('') : '<p class="empty" style="padding-top:18px">Эти услуги не делает один мастер. Уберите часть услуг или запишитесь к разным мастерам по очереди.</p>'}</div>`;
  }

  function time() {
    const list = pickedSvcs();
    const t = totals(list);
    const days = (S.dates || []).map(d => { const x = dayOf(d); return `
      <button class="day" type="button" data-date="${d}" aria-pressed="${S.date === d}" aria-label="${longDate(d)}">
        <small>${WD[x.getDay()]}</small><b>${x.getDate()}</b><small>${MON[x.getMonth()].slice(0, 3)}</small></button>`; }).join('');
    let slots = '';
    if (S.times === null) slots = skel(1);
    else if (S.date && !S.times.length) slots = '<p class="empty">На этот день всё занято. Выберите другой.</p>';
    else if (S.times.length) {
      const parts = [['Утро', 0, 12], ['День', 12, 17], ['Вечер', 17, 24]].map(([name, a, b]) => {
        const xs = S.times.filter(s => { const h = Number(s.time.slice(0, 2)); return h >= a && h < b; });
        return xs.length ? `<div class="slots-g"><span class="eyebrow">${name}</span><div class="slots">${xs.map(s =>
          `<button class="slot" type="button" data-slot="${esc(s.datetime)}" aria-pressed="${S.slot?.datetime === s.datetime}">${esc(s.time)}</button>`).join('')}</div></div>` : '';
      });
      slots = parts.join('');
    }
    return `<section class="intro"><span class="eyebrow">Шаг 3 из 4</span><h1>Когда удобно</h1></section>
      <div class="summary"><span class="who">${esc(S.master.name)}</span>
        <span class="what">${esc(list.map(s => s.title).join(', '))} · ${dur(t.minutes)}</span></div>
      ${errBox()}
      <section class="sec"><span class="eyebrow">Дата</span>
        ${S.dates === null ? skel(1) : S.dates.length ? `<div class="days">${days}</div>${slots}` : '<p class="empty">Ближайшие три недели у мастера всё занято. Выберите другого мастера или позвоните в салон.</p>'}</section>`;
  }

  function contacts() {
    const list = pickedSvcs();
    const t = totals(list);
    const f = S.form;
    return `<section class="intro"><span class="eyebrow">Шаг 4 из 4</span><h1>Ваши контакты</h1></section>
      <div class="summary"><dl class="lines">
        <div><dt>Салон</dt><dd>${esc(S.salon.name)}</dd></div>
        <div><dt>Мастер</dt><dd>${esc(S.master.name)}</dd></div>
        <div><dt>Услуги</dt><dd>${esc(list.map(s => s.title).join(', '))}</dd></div>
        <div><dt>Когда</dt><dd>${longDate(S.date)}, ${esc(S.slot.time)}</dd></div>
        <div><dt>Стоимость</dt><dd>${t.price}</dd></div></dl></div>
      <form class="form" id="form" novalidate>
        <div class="field"><label for="name">Как к вам обращаться</label>
          <input id="name" autocomplete="given-name" maxlength="60" value="${esc(f.name)}" placeholder="Имя"></div>
        <div class="field"><label for="phone">Телефон</label>
          <input id="phone" type="tel" inputmode="tel" autocomplete="tel" value="${esc(f.phone)}" placeholder="+7 (9__) ___-__-__">
          <span class="hint">Администратор салона свяжется с вами, чтобы подтвердить запись.</span></div>
        <div class="field"><label for="comment">Пожелания <span class="hint">(необязательно)</span></label>
          <textarea id="comment" maxlength="300" placeholder="Например: хочу снять старое покрытие">${esc(f.comment)}</textarea></div>
        <div class="hp" aria-hidden="true"><label for="website">Сайт</label><input id="website" tabindex="-1" autocomplete="off"></div>
        <label class="consent"><input type="checkbox" id="consent"${f.consent ? ' checked' : ''}>
          <span>Согласна(ен) на обработку персональных данных для записи и связи со мной.</span></label>
      </form>${errBox()}`;
  }

  function done() {
    const r = S.result || {};
    const at = S.date ? `${longDate(S.date)}, ${esc(S.slot?.time || '')}` : '';
    return `<section class="done"><div class="ok"><svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2"/></svg></div>
      <h1>Вы записаны</h1>
      <div class="summary" style="width:100%"><dl class="lines">
        <div><dt>Когда</dt><dd>${at}</dd></div>
        <div><dt>Мастер</dt><dd>${esc(r.staff || S.master?.name || '')}</dd></div>
        <div><dt>Услуги</dt><dd>${esc(r.services || '')}</dd></div>
        <div><dt>Салон</dt><dd>${esc(r.salon || S.salon?.name || '')}</dd></div></dl></div>
      <p>Администратор салона свяжется с вами, чтобы подтвердить запись. Если планы изменятся, просто позвоните нам.</p>
      <button class="btn-ghost" type="button" id="again">Записаться ещё</button></section>`;
  }

  // --- отрисовка ------------------------------------------------------------
  function bar() {
    const b = $('bar'), sum = $('barSum'), btn = $('barBtn');
    let show = false, label = '', text = '', enabled = true;
    const list = pickedSvcs(), t = totals(list);
    const svcSummary = list.length ? `<b>${t.price}</b><span>${list.length} ${plural(list.length, 'услуга', 'услуги', 'услуг')} · ${dur(t.minutes)}</span>` : '<span>Отметьте услуги</span>';
    if (S.screen === 'home' && S.tab === 'services' && S.services.length) { show = true; label = 'Выбрать мастера'; text = svcSummary; enabled = list.length > 0; }
    else if (S.screen === 'master' && S.masterServices.length) { show = true; label = 'Выбрать время'; text = svcSummary; enabled = list.length > 0; }
    else if (S.screen === 'time') { show = true; label = 'Продолжить'; enabled = Boolean(S.slot);
      text = S.slot ? `<b>${esc(S.slot.time)}</b><span>${longDate(S.date)}</span>` : '<span>Выберите время</span>'; }
    else if (S.screen === 'contacts') { show = true; label = S.busy ? 'Записываем…' : 'Записаться'; enabled = !S.busy; text = `<b>${t.price}</b><span>${esc(S.slot?.time || '')}, ${S.date ? longDate(S.date) : ''}</span>`; }
    b.hidden = !show; sum.innerHTML = text; btn.textContent = label; btn.disabled = !enabled;
  }

  function render() {
    $('salons').innerHTML = S.salons.map(s =>
      `<button type="button" role="tab" data-salon="${s.id}" aria-selected="${String(S.salon?.id) === String(s.id)}">${esc(s.name)}</button>`).join('');
    $('salons').hidden = S.screen !== 'home';
    $('back').hidden = !S.stack.length;
    const screens = { home, master, pick, time, contacts, done };
    app.innerHTML = S.salon ? screens[S.screen]() : `<section class="intro">${errBox() || skel(3)}</section>`;
    bar();
  }

  // --- события --------------------------------------------------------------
  document.addEventListener('click', (e) => {
    const el = e.target.closest('button');
    if (!el) return;
    const d = el.dataset;
    if (el.id === 'back') return history.state ? history.back() : back();
    if (d.salon) return loadSalon(d.salon);
    if (d.tab) { S.tab = d.tab; S.picked.clear(); return render(); }
    if (d.master) return openMaster(d.master);
    if (d.svc) { const id = Number(d.svc); S.picked.has(id) ? S.picked.delete(id) : S.picked.add(id); return render(); }
    if (d.date) return pickDate(d.date);
    if (d.slot) { S.slot = S.times.find(s => s.datetime === d.slot); return render(); }
    if (d.work) return openWork(Number(d.work));
    if (el.id === 'again') { S.result = null; S.stack = []; S.screen = 'home'; S.master = null; S.picked.clear(); return render(); }
    if (el.id === 'lbClose') return ($('lb').hidden = true);
    if (el.id === 'barBtn') {
      if (S.screen === 'home') return openPick();
      if (S.screen === 'master') return openTime();
      if (S.screen === 'time') return go('contacts');
      if (S.screen === 'contacts') return submit();
    }
  });
  $('lb').addEventListener('click', (e) => { if (e.target.id === 'lb') $('lb').hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('lb').hidden = true; });

  function openWork(i) {
    const w = S.master?.works?.[i];
    if (!w) return;
    const box = $('lbImg');
    box.innerHTML = w.src ? `<img src="${esc(w.src)}" alt="${esc(w.caption)}">` : '';
    box.style.background = w.tone ? `linear-gradient(145deg,${w.tone[0]},${w.tone[1]})` : '';
    $('lbCap').textContent = w.caption || '';
    $('lb').hidden = false;
  }

  // Поля формы: запоминаем по ходу ввода, телефон — с маской +7 (9XX) XXX-XX-XX
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
    if (t.id === 'phone') { t.value = maskPhone(t.value); S.form.phone = t.value; }
    else if (t.id === 'name') S.form.name = t.value;
    else if (t.id === 'comment') S.form.comment = t.value;
  });
  document.addEventListener('change', (e) => { if (e.target.id === 'consent') S.form.consent = e.target.checked; });
  document.addEventListener('submit', (e) => { e.preventDefault(); submit(); });

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
    } catch (e) { S.error = e.message; render(); }
  })();
})();
