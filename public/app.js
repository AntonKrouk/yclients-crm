const $ = s => document.querySelector(s);

// Раньше здесь стояло fetch(p,o).then(r=>r.json()) — без единой проверки ответа, и это
// стоило нам потерянных звонков. Обрыв связи, 401 после протухшей куки, 500 на сервере —
// промис падал молча, а карточка задачи всё равно уезжала с тостом «Отмечено». Админ был
// уверен, что отметил разговор, в базе не появлялось ничего, и задача возвращалась в
// список при следующей перерисовке («обработали, а она снова тут»). Теперь любой не-2xx,
// любой нечитаемый ответ и любой {error} — это исключение с человеческим текстом,
// которое обязан показать вызывающий код.
class ApiError extends Error{
  constructor(msg,status){ super(msg); this.name='ApiError'; this.status=status; }
}
async function api(p,o){
  let r;
  try{ r = await fetch(p,o); }
  catch{ throw new ApiError('нет связи с сервером'); }
  const txt = await r.text().catch(()=>'');
  let data=null, parsed=false;
  if(txt){ try{ data=JSON.parse(txt); parsed=true; }catch{} }
  // сессия кончилась: сервер отдаёт 401 на /api/*, а на остальное — страницу входа
  if(r.status===401 || r.status===403 || (txt && !parsed))
    throw new ApiError('сессия истекла — обновите страницу (F5) и войдите заново', r.status);
  if(!r.ok) throw new ApiError((data&&data.error)||`сервер ответил ${r.status}`, r.status);
  if(data && data.error) throw new ApiError(data.error, r.status);
  return data;
}
// Страховка на всё остальное: загрузчики вкладок ошибку не ловят, и без этого сбой
// выглядел бы как «страница просто не обновилась».
window.addEventListener('unhandledrejection', e=>{
  if(e.reason instanceof ApiError){ toast('Не загрузилось: '+e.reason.message,'bad'); e.preventDefault(); }
});

// Тонкие штриховые иконки вместо эмодзи: наследуют currentColor и не ломают
// типографику. Единый набор — без внешних библиотек.
const svg = d => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  check:    svg('<path d="M3 8.5l3.5 3.5L13 5"/>'),
  clock:    svg('<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>'),
  phoneOff: svg('<path d="M2 2l12 12"/><path d="M5.5 3.2A9 9 0 0 0 3 5.6c-1 1.2.3 3.4 2 5.1s3.9 3 5.1 2a9 9 0 0 0 2.4-2.5"/>'),
  cross:    svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
  ban:      svg('<circle cx="8" cy="8" r="6"/><path d="M3.8 3.8l8.4 8.4"/>'),
  star:     svg('<path d="M8 2l1.8 3.9 4.2.5-3.1 2.9.8 4.2L8 11.5 4.3 13.5l.8-4.2L2 6.4l4.2-.5z"/>'),
  trash:    svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>'),
  gear:     svg('<circle cx="8" cy="8" r="2.4"/><path d="M8 1.5v1.8M8 12.7v1.8M14.5 8h-1.8M3.3 8H1.5M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3M12.6 12.6l-1.3-1.3M4.7 4.7L3.4 3.4"/>'),
  user:     svg('<circle cx="8" cy="5.5" r="2.6"/><path d="M3 13.5c0-2.5 2.2-4 5-4s5 1.5 5 4"/>'),
  refresh:  svg('<path d="M13.5 8a5.5 5.5 0 1 1-1.8-4.1"/><path d="M13.7 2.5v3.2h-3.2"/>'),
  cal:      svg('<rect x="2.5" y="3.5" width="11" height="10" rx="1"/><path d="M2.5 6.5h11M5.5 2v2.5M10.5 2v2.5"/>'),
  note:     svg('<path d="M3 3.5h10v7l-2.5 2.5H3z"/><path d="M13 10.5h-2.5v2.5"/>'),
  plus:     svg('<path d="M8 3.5v9M3.5 8h9"/>'),
  chev:     svg('<path d="M6 3l5 5-5 5"/>'),
  building: svg('<path d="M3 13.5V4l5-2 5 2v9.5"/><path d="M6.5 13.5v-3h3v3M6 6.5h1M9 6.5h1"/>'),
  plug:     svg('<path d="M6 2v4M10 2v4M4.5 6h7v2a3.5 3.5 0 0 1-7 0z"/><path d="M8 11.5v2.5"/>'),
  spark:    svg('<path d="M8 2.5l1.2 3.3L12.5 7l-3.3 1.2L8 11.5 6.8 8.2 3.5 7l3.3-1.2z"/>'),
  wallet:   svg('<path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h8.2v1.5"/><rect x="2" y="5.5" width="12" height="7" rx="1.5"/><circle cx="11" cy="9" r=".9"/>'),
  cake:     svg('<path d="M2.8 13.5h10.4V9.8a1.8 1.8 0 0 0-1.8-1.8H4.6a1.8 1.8 0 0 0-1.8 1.8z"/><path d="M5.5 5.6V4M8 5.6V3.4M10.5 5.6V4"/><path d="M2.8 10.8c1.15 0 1.15 1 2.3 1s1.15-1 2.3-1 1.15 1 2.3 1 1.15-1 2.3-1"/>'),
  copy:     svg('<rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>'),
  msg:      svg('<path d="M2.5 3.5h11v8h-6l-3.5 2.5V11.5h-1.5z"/>'),
};

// Текст, набранный админом (заметки, шаблоны), уходит в innerHTML — одна угловая скобка
// в тексте ломала бы вёрстку блока. Экранируем всё, что пришло от человека.
const esc = s => String(s==null?'':s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// Копирование в буфер. navigator.clipboard живёт только в защищённом контексте
// (https или localhost) — на всякий случай оставляем старый способ через скрытое поле,
// иначе на http-адресе кнопка молча ничего не делала бы.
async function copyText(text){
  try{
    if(navigator.clipboard && window.isSecureContext){ await navigator.clipboard.writeText(text); return true; }
  }catch{ /* нет прав или отказ пользователя — пробуем запасной путь */ }
  try{
    const ta=document.createElement('textarea');
    ta.value=text; ta.setAttribute('readonly','');
    ta.style.cssText='position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta); ta.select();
    const ok=document.execCommand('copy');
    ta.remove();
    return ok;
  }catch{ return false; }
}

// --- Администраторы (кто звонит) ---
let admins = [];
// На «Обзвонах» своё поле «Кто звонит» — там по умолчанию стоит автор списка.
// Берём то поле, которое видит админ прямо сейчас.
const adminSelEl = () => (document.querySelector('#view-calls')?.style.display!=='none'
  ? $('#adminSelCalls') : $('#adminSel'));
const currentAdmin = () => adminSelEl()?.value || localStorage.getItem('admin_name') || '';
// Раньше в журнале у половины звонков стояло безликое «Администратор»: имя подставлялось
// заглушкой, если админ не выбрал себя. Потом стали просить выбрать — но отказ выглядел как
// тост на полторы секунды, кнопка при этом молча не срабатывала, и звонок терялся.
// Теперь спрашиваем модалкой и, получив имя, продолжаем прерванное действие.
let whoResolve=null;
function needAdmin(){
  const a=currentAdmin();
  if(a) return Promise.resolve(a);
  if(!admins.length) return Promise.resolve('Администратор'); // список не заведён — не блокируем работу
  const sel=$('#whoSel');
  sel.innerHTML=admins.map(x=>`<option value="${x.name.replace(/"/g,'&quot;')}">${x.name}</option>`).join('');
  sel.value=localStorage.getItem('admin_name')||admins[0].name;
  $('#whoModal').classList.add('open');
  return new Promise(res=>{ whoResolve=res; });
}
function closeWho(name){
  $('#whoModal').classList.remove('open');
  const res=whoResolve; whoResolve=null;
  if(name){
    localStorage.setItem('admin_name',name);
    for(const s of [$('#adminSel'),$('#adminSelCalls')])
      if(s && [...s.options].some(o=>o.value===name)) s.value=name;
  }
  if(res) res(name||null);
}
$('#whoOk').onclick=()=>closeWho($('#whoSel').value);
$('#whoCancel').onclick=()=>closeWho(null);
$('#whoModal').onclick=e=>{ if(e.target.id==='whoModal') closeWho(null); };
async function loadAdmins(){
  admins = await api('/api/admins');
  const saved=localStorage.getItem('admin_name')||'';
  const opts = admins.length
    ? admins.map(a=>`<option value="${a.name.replace(/"/g,'&quot;')}">${a.name}</option>`).join('')
    : '<option value="">— добавьте админов —</option>';
  // оба поля «Кто звонит» (на «Задачах» и на «Обзвонах») заполняем одинаково
  for(const s of [$('#adminSel'),$('#adminSelCalls')]) s.innerHTML=opts;
  if(admins.length){
    const val = admins.some(a=>a.name===saved) ? saved : admins[0].name;
    $('#adminSel').value=val; $('#adminSelCalls').value=val;
    localStorage.setItem('admin_name', val);
  }
}
function renderAdminList(){
  $('#adminList').innerHTML = admins.length
    ? admins.map(a=>`<div class="admin-row"><span>${a.name}</span><button onclick="removeAdmin(${a.id})">Удалить</button></div>`).join('')
    : '<div class="muted" style="font-size:13px">Пока никого. Добавьте первого администратора ниже.</div>';
}
function openAdminModal(){
  renderAdminList();
  $('#admYcList').innerHTML=''; $('#admImportActions').style.display='none';
  $('#adminModal').classList.add('open');
}
function closeAdminModal(){ $('#adminModal').classList.remove('open'); }
async function addAdmin(){
  const name=$('#adminNewName').value.trim();
  if(!name) return;
  const r=await api('/api/admins',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});
  admins=r.admins||[]; $('#adminNewName').value=''; renderAdminList(); await refreshAdminSel();
}
async function removeAdmin(id){
  const r=await api(`/api/admins/${id}`,{method:'DELETE'});
  admins=r.admins||[]; renderAdminList(); await refreshAdminSel();
}
// Сотрудники с ролью «администратор»/«менеджер» из YClients — по обоим филиалам
const ROLE_RU={administrator:'админ',manager:'менеджер'};
async function loadYcAdmins(){
  const box=$('#admYcList'); box.innerHTML='<div class="muted" style="font-size:13px">Загрузка из YClients…</div>';
  try{
    const list=await api('/api/admins/yclients');
    if(!list.length){ box.innerHTML='<div class="muted" style="font-size:13px">YClients не вернул администраторов</div>'; return; }
    box.innerHTML=list.map(a=>`<label class="${a.added?'added':''}">
      <input type="checkbox" value="${a.name.replace(/"/g,'&quot;')}" ${a.added?'disabled':'checked'}>
      <span>${a.name}</span>
      <span class="rl">${ROLE_RU[a.role]||a.role} · ${a.branches.join(', ')}${a.added?' · уже в списке':''}</span>
    </label>`).join('');
    $('#admImportActions').style.display = list.some(a=>!a.added) ? 'flex' : 'none';
  }catch(e){ box.innerHTML=`<div class="muted" style="font-size:13px">Ошибка: ${e.message}</div>`; }
}
async function importYcAdmins(){
  const names=[...$('#admYcList').querySelectorAll('input:checked:not(:disabled)')].map(i=>i.value);
  if(!names.length){ toast('Никто не отмечен'); return; }
  const r=await api('/api/admins/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({names})});
  admins=r.admins||[]; renderAdminList(); await refreshAdminSel(); await loadYcAdmins();
  toast(`Добавлено: ${names.length}`);
}
// Селектов «кто звонит» два — на «Задачах» и на «Обзвонах». Держим их одинаковыми,
// чтобы админ выбрал себя один раз и звонки с обеих вкладок писались на него.
async function refreshAdminSel(){
  const opts = admins.length ? admins.map(a=>`<option value="${a.name.replace(/"/g,'&quot;')}">${a.name}</option>`).join('') : '<option value="">— добавьте админов —</option>';
  const sel=$('#adminSel'), cur=sel.value;
  for(const s of [sel,$('#adminSelCalls')]) s.innerHTML=opts;
  if(admins.some(a=>a.name===cur)) sel.value=cur; else if(admins.length){ sel.value=admins[0].name; localStorage.setItem('admin_name',sel.value); }
  $('#adminSelCalls').value = sel.value;
}
$('#adminSelCalls').onchange = e => { $('#adminSel').value = e.target.value; $('#adminSel').dispatchEvent(new Event('change')); };

// --- Филиалы ---
let currentBranch = '';
function bp(url){ return currentBranch ? url + (url.includes('?')?'&':'?') + 'branch=' + encodeURIComponent(currentBranch) : url; }
const branchTag = b => b ? `<span class="branch-tag">${b}</span>` : '';
async function loadBranches(){
  const list = await api('/api/branches');
  const sel = $('#branchSel');
  if(!Array.isArray(list) || list.length <= 1){ sel.style.display='none'; return; }
  sel.style.display='';
  sel.innerHTML = '<option value="">Все филиалы</option>' + list.map(b=>`<option value="${b.branch}">${b.branch} · ${b.clients}</option>`).join('');
  sel.value = currentBranch;
  sel.onchange = ()=>{ currentBranch = sel.value; reloadCurrentView(); };
}
function reloadCurrentView(){
  const v = document.querySelector('.tab.active')?.dataset.view;
  if(v==='calls') loadCalls();
  else if(v==='overview') loadOverview();
  else if(v==='clients') loadClients($('#clientSearch').value);
  else if(v==='segments'){ segLoaded=false; loadSegments(); }
  else loadTasks();
}
// --- Тихое обновление ---------------------------------------------------------
// Две точки (Басков и Мытнинская) работают в одной базе, но страница сама не
// перерисовывалась: закрытая соседом задача висела до F5, а его звонок не появлялся
// в журнале обзора. Раз в 45 сек тихо перезагружаем активную вкладку — только «живые»
// (задачи и обзор). Конструктор, ручные списки и ДР не трогаем: там выборка строится долго,
// а перерисовка сбила бы работу.
// Обновление отменяется, если админ занят: открыта карточка клиента или модалка либо
// курсор стоит в поле. Раньше отменяли и при любом набранном тексте в заметке — иначе
// перерисовка стирала её. Теперь заметка живёт черновиком на сервере (saveDraft) и
// возвращается в поле после перерисовки, так что блокировать обновление незачем.
const SILENT_REFRESH_MS = 45000;
function silentBusy(){
  if(document.hidden) return true;
  if($('#drawer').classList.contains('open')) return true;
  if(document.querySelector('.modal-overlay.open')) return true;
  const el = document.activeElement;
  return !!(el && ['INPUT','TEXTAREA','SELECT'].includes(el.tagName));
}
// О сбое фонового обновления сообщаем ОДИН раз, а не каждые 45 секунд: иначе при
// упавшей связи админ получил бы бесконечную ленту красных сообщений и перестал бы
// их читать — а именно они и должны его останавливать при потере звонка.
let silentFailed=false;
function silentRefresh(){
  if(silentBusy()) return;
  const v = document.querySelector('.tab.active')?.dataset.view;
  let p=null;
  if(v==='tasks') p=loadTasks();
  else if(v==='calls') p=loadCalls(false);  // без перерисовки списков: свернуло бы раскрытый блок
  else if(v==='overview') p=loadOverview(); // внутри сам обновит журнал звонков
  if(!p) return;
  p.then(()=>{ silentFailed=false; })
   .catch(e=>{ if(!silentFailed){ silentFailed=true;
     toast('Данные не обновляются: '+(e.message||'нет связи'),'bad'); } });
}
setInterval(silentRefresh, SILENT_REFRESH_MS);
// вернулись на вкладку браузера — показываем свежее, не дожидаясь тика
document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) silentRefresh(); });

const rub = n => Math.round(n||0).toLocaleString('ru-RU') + ' ₽';
// «1 клиент / 2 клиента / 5 клиентов»
const plural = (n,one,few,many) => { const a=Math.abs(n)%100, b=a%10;
  return n+' '+(a>10&&a<20?many:b===1?one:b>=2&&b<=4?few:many); };
// настоящая сумма трат: из карточки YClients (с депозитами), иначе по визитам
const realSpentOf = (c,s) => c.yc_spent!=null ? c.yc_spent : s.total_spent;
const depTag = bal => !bal ? '' : bal>0
  ? ` <span class="dep-tag" title="Остаток депозита">депозит ${rub(bal)}</span>`
  : ` <span class="dep-tag debt" title="Долг (баланс в минусе)">долг ${rub(bal)}</span>`;
// персональная скидка из карточки YClients
const discTag = d => !d ? '' : ` <span class="disc-tag" title="Персональная скидка">−${d}%</span>`;
const fmtDate = d => d ? new Date(d).toLocaleDateString('ru-RU',{day:'numeric',month:'short',year:'2-digit'}) : '—';
const fmtDT = d => d ? new Date(d).toLocaleString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) : '—';
const daysAgoTxt = d => { if(!d) return '—'; const n=Math.round((Date.now()-new Date(d))/864e5); return n<=0?'сегодня':`${n} дн. назад`; };

// kind='bad' — сообщение о сбое: красное и висит дольше, чтобы его успели прочитать
let toastTimer=null;
function toast(msg,kind){
  const t=$('#toast'); t.textContent=msg;
  t.className='toast show'+(kind?' '+kind:'');
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>t.classList.remove('show'), kind==='bad'?5000:1800);
}

// --- Боковое меню ---
// Навигация стоит слева колонкой. На телефоне колонка уезжает за край экрана и
// выдвигается бургером из верхней панели; открытое меню блокирует прокрутку страницы
// и закрывается затемнением, Escape'ом или выбором вкладки.
function setNav(open){
  $('#nav').classList.toggle('open',open);
  $('#navBackdrop').classList.toggle('open',open);
  $('#navBtn').classList.toggle('on',open);
  $('#navBtn').setAttribute('aria-expanded',open?'true':'false');
  document.body.classList.toggle('nav-open',open);
}
$('#navBtn').onclick=()=>setNav(!$('#nav').classList.contains('open'));
$('#navBackdrop').onclick=()=>setNav(false);
document.addEventListener('keydown',e=>{ if(e.key==='Escape' && $('#nav').classList.contains('open')) setNav(false); });

// --- Вкладки ---
document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>{
  document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
  t.classList.add('active');
  setNav(false);                              // на телефоне меню закрывается само
  $('#topbarView').textContent=t.textContent; // в свёрнутом виде видно, где мы находимся
  const v=t.dataset.view;
  ['tasks','calls','overview','clients','vip','deposit','alice','bday','scripts','analytics','segments'].forEach(name=>$('#view-'+name).style.display = name===v?'':'none');
  if(v==='tasks') loadTasks();
  if(v==='calls') loadCalls();
  if(v==='overview') loadOverview();
  if(v==='clients') loadClients();
  if(v==='vip') loadList('vip');
  if(v==='deposit') loadList('deposit');
  if(v==='alice') loadList('alice');
  if(v==='bday') loadBday();
  if(v==='scripts') loadScripts();
  if(v==='analytics') loadAnalytics();
  if(v==='segments') loadSegments();
});

// --- Режим (demo/live) ---
async function refreshMode(){
  const h = await api('/api/health');
  const el=$('#mode');
  if(h.mode==='live'){el.textContent='LIVE';el.classList.add('live');$('#connectBtn').style.display='none';}
  else {el.textContent='ДЕМО-режим';el.classList.remove('live');$('#connectBtn').style.display='';}
}
refreshMode();

// --- Вход в YClients ---
function openLogin(){$('#loginModal').classList.add('open');$('#loginError').textContent='';$('#ycLogin').focus();}
function closeLogin(){$('#loginModal').classList.remove('open');}
$('#connectBtn').onclick=openLogin;
$('#loginModal').onclick=e=>{if(e.target.id==='loginModal')closeLogin();};
$('#loginSubmit').onclick=async ()=>{
  const login=$('#ycLogin').value.trim(), password=$('#ycPassword').value;
  const err=$('#loginError'); err.textContent='';
  if(!login||!password){err.textContent='Введите логин и пароль';return;}
  const b=$('#loginSubmit');b.textContent='Вход…';b.disabled=true;
  try{
    const r=await fetch('/api/yclients/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({login,password})});
    const j=await r.json();
    if(!r.ok){err.textContent=j.error||'Не удалось войти';}
    else{
      $('#ycPassword').value='';
      closeLogin();
      toast(`Подключено к YClients: ${j.sync.clients} клиентов, ${j.sync.tasks} задач`);
      await refreshMode(); loadTasks();
    }
  }catch(e){err.textContent='Ошибка сети';}
  b.textContent='Войти и синхронизировать';b.disabled=false;
};

// --- ЗАДАЧИ ---
const q1 = s => String(s||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'"); // имя внутри onclick='…'
// «2026-08-11 19:00» → « в 19:00»; если время не назначено — просто «сегодня»
const cbTime = due => (String(due||'').split(' ')[1] ? ` в ${String(due).split(' ')[1]}` : ' сегодня');
const RES = [
  {k:'booked',   t:ICON.check+'Записать',    cls:'booked'},
  {k:'callback', t:ICON.clock+'Перезвонить', cls:'callback'},
  {k:'no_answer',t:ICON.phoneOff+'Не ответил', cls:''},
  {k:'refused',  t:ICON.cross+'Отказ',       cls:'refused'},
];
// В списках обзвона зовут не только записаться: на мероприятие, мастер-класс, показ —
// там результат «согласился прийти», записи в YClients при этом нет.
const RES_LIST = [
  RES[0],
  {k:'coming',   t:ICON.check+'Придёт',      cls:'booked'},
  ...RES.slice(1),
];

async function loadTasks(){
  await api('/api/tasks/reopen-due',{method:'POST'});
  const tasks = await api(bp('/api/tasks?status=open'));
  const counts = {};
  tasks.forEach(t=>counts[t.type]=(counts[t.type]||0)+1);
  const KL={rebook:'Пора записать',no_show:'Не пришёл',reactivation:'Реактивация'};
  if(counts.manual) KL.manual='Добавлены вручную';   // плитку показываем, только если такие задачи есть
  $('#taskKpis').innerHTML = Object.entries(KL).map(([k,l])=>
    `<div class="card kpi"><div class="n">${counts[k]||0}</div><div class="l">${l}</div></div>`).join('');

  const list=$('#taskList');
  if(!tasks.length){list.innerHTML='<div class="empty">На сегодня задач нет</div>';return;}
  list.innerHTML = tasks.map(t=>`
    <div class="task${t.callback_at?' callback-today':''}" data-id="${t.id}">
      <div class="left">
        <span class="type-badge t-${t.type}">${t.type_label}</span>
        ${t.callback_at?`<span class="cb-badge">${ICON.clock}перезвонить${cbTime(t.callback_at)}</span>`:''}
        <div class="tname" onclick="openClient(${t.client_id})">${t.name||'Без имени'}${branchTag(t.branch)}</div>
        <div class="tmeta"><span class="phone">${t.phone||'—'}</span> · визитов: ${t.visits_count||0}${t.favorite_staff?` · мастер: ${t.favorite_staff}`:''}</div>
        <div class="treason">${t.reason||''}</div>
      </div>
      <div class="actions">
        <div class="res-row">
          ${RES.map(r=>`<button class="res ${r.cls}" onclick="${r.k==='booked'
              ? `openBooking({client_id:${t.client_id},name:'${q1(t.name)}',task_id:${t.id},noteEl:'#note-${t.id}'})`
              : `act(${t.id},'${r.k}',this)`}">${r.t}</button>`).join('')}
        </div>
        <textarea placeholder="Заметка о звонке…" id="note-${t.id}"
          oninput="saveDraft('/api/tasks/${t.id}/note',this)"
          onblur="saveDraft('/api/tasks/${t.id}/note',this,true)">${esc(t.draft_note||'')}</textarea>
      </div>
    </div>`).join('');
}

// Черновик заметки живёт на сервере: админ печатает, отвлекается на другую вкладку или
// клиента — текст ждёт его на месте, а не пропадает вместе с перерисовкой списка.
// Пишем с задержкой, чтобы не слать запрос на каждую букву; при уходе из поля — сразу.
const draftTimers=new Map();
function putDraft(url,text,keepalive){
  return fetch(url,{method:'PATCH',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({note:text}),keepalive:!!keepalive}).catch(()=>{});
}
function saveDraft(url,el,now){
  clearTimeout(draftTimers.get(url)?.t);
  const send=()=>{ draftTimers.delete(url); putDraft(url,el.value); };
  if(now) send();
  else draftTimers.set(url,{t:setTimeout(send,700),el});   // el в замыкании: переживает перерисовку
}
// Закрывает вкладку браузера или сворачивает окно — дописываем недосохранённое сразу,
// не дожидаясь задержки (keepalive позволяет запросу уйти уже при выгрузке страницы)
function flushDrafts(){
  for(const [url,d] of draftTimers){ clearTimeout(d.t); putDraft(url,d.el.value,true); }
  draftTimers.clear();
}
window.addEventListener('pagehide',flushDrafts);
document.addEventListener('visibilitychange',()=>{ if(document.hidden) flushDrafts(); });

// --- ЗАПИСЬ К МАСТЕРУ (создаёт настоящую запись в YClients) ---
// ctx: {client_id, name, task_id | member_id, list_id, noteEl} — откуда пришли и куда вернуть результат
let bookCtx = null;
// За один визит клиент нередко идёт к нескольким мастерам сразу (маникюр и педикюр
// параллельно, стрижка плюс окрашивание). В YClients каждая такая услуга — ОТДЕЛЬНАЯ
// запись со своим мастером и временем, поэтому форма собирает несколько строк и создаёт
// столько же записей. Больше четырёх за один визит в салоне не делают.
const BOOK_MAX_ROWS = 4;
let bookRows = [];   // [{uid, staffAll, serviceAll, staffPicked, servicePicked}]
let bookUid = 0;

function openBooking(ctx){
  bookCtx = ctx;
  $('#bookWho').textContent = `${ctx.name||'Клиент'} — запись создастся прямо в YClients, в филиале клиента.`;
  $('#bookError').textContent='';
  $('#bookComment').value='';
  // Филиалы обнуляем ДО создания строки: иначе строка успевала запросить мастеров ещё
  // по салону предыдущего клиента, и два ответа гонялись, кто запишется последним.
  bookBranches=[]; bookHomeCid='';
  $('#bookRows').innerHTML=''; bookRows=[];
  addBookRow();                    // одна строка есть всегда
  $('#bookSubmit').disabled=false; $('#bookSubmit').textContent='Записать в YClients';
  $('#bookModal').classList.add('open');
  loadBookBranches();   // филиалы, следом мастера выбранного салона
}
function closeBooking(){ $('#bookModal').classList.remove('open'); bookCtx=null; }
const bookErr = m => { $('#bookError').textContent = m || ''; };

// Мастера и услуги — комбобоксы: список подсказок плюс ручной ввод, так быстрее.
// В поле лежит НАЗВАНИЕ, id ищем сопоставлением (id в value спрятать нельзя — datalist
// показывает пользователю именно value).
const norm = s => String(s||'').trim().toLowerCase();
// Салон выбирается в КАЖДОЙ строке: клиент может попросить одну услугу в Баскове, а
// другую на Мытнинской, да и просто перепутать салон в одной строке проще, чем заметить
// это в общей шапке формы. Список филиалов тянем один раз на всю форму.
let bookBranches=[], bookHomeCid='';
const fld       = (row,name) => $(`#bk${name}-${row.uid}`);
const bookCid   = row => fld(row,'Br').value || '';
const bookQ = (row,extra='') => `client_id=${bookCtx.client_id}${bookCid(row)?`&company_id=${bookCid(row)}`:''}${extra}`;
const staffId   = row => row.staffAll.find(s=>norm(s.name)===norm(fld(row,'Staff').value))?.id || '';
const serviceOf = row => row.serviceAll.find(s=>norm(s.title)===norm(fld(row,'Svc').value)) || null;

function addBookRow(){
  if(bookRows.length>=BOOK_MAX_ROWS) return null;
  const row={uid:++bookUid, staffAll:[], serviceAll:[], staffPicked:'', servicePicked:''};
  bookRows.push(row);
  const box=document.createElement('div');
  box.className='book-item'; box.dataset.uid=row.uid;
  box.innerHTML=`
    <div class="book-item-hd"><span class="book-item-n"></span>
      <button type="button" class="book-item-x" title="Убрать эту запись">✕</button></div>
    <label class="fld">Салон<select id="bkBr-${row.uid}"></select></label>
    <label class="fld">Мастер
      <input type="text" id="bkStaff-${row.uid}" list="bkStaffList-${row.uid}" autocomplete="off"
        placeholder="Введите имя или выберите из списка">
      <datalist id="bkStaffList-${row.uid}"></datalist></label>
    <label class="fld">Услуга
      <input type="text" id="bkSvc-${row.uid}" list="bkSvcList-${row.uid}" autocomplete="off" disabled
        placeholder="Сначала выберите мастера">
      <datalist id="bkSvcList-${row.uid}"></datalist></label>
    <div class="book-row">
      <label class="fld">Дата<select id="bkDate-${row.uid}" disabled><option value="">—</option></select></label>
      <label class="fld">Время<select id="bkTime-${row.uid}" disabled><option value="">—</option></select></label>
    </div>`;
  $('#bookRows').appendChild(box);
  // Комбобоксы реагируют и на выбор из списка, и на дописанный вручную текст: как только
  // введённое совпало с мастером (услугой), подтягиваем следующий шаг. Пока совпадения
  // нет — молчим, чтобы не дёргать YClients на каждую букву.
  fld(row,'Staff').oninput = () => {
    const id=staffId(row);
    if(String(id)===String(row.staffPicked)) return;
    row.staffPicked=id; row.servicePicked='';
    if(id) loadBookServices(row);
  };
  fld(row,'Svc').oninput = () => {
    const id=serviceOf(row)?.id||'';
    if(String(id)===String(row.servicePicked)) return;
    row.servicePicked=id;
    if(id) loadBookDates(row);
  };
  fld(row,'Date').onchange = () => loadBookTimes(row);
  // сменили салон в строке — мастера там другие, строку начинаем заново
  fld(row,'Br').onchange = () => { row.staffPicked=''; row.servicePicked=''; loadBookStaff(row); };
  box.querySelector('.book-item-x').onclick = () => removeBookRow(row.uid);
  renumberBookRows();
  // филиалы уже загружены (добавили строку в открытой форме) — заполняем сразу;
  // иначе это сделает loadBookBranches, когда список приедет
  if(bookCtx && bookBranches.length){ fillBookBranches(row); loadBookStaff(row); }
  return row;
}
// Салон по умолчанию: тот же, что в предыдущей строке (к двум мастерам ходят в один
// салон), а для первой строки — «родной» салон клиента.
function fillBookBranches(row){
  const sel=fld(row,'Br');
  sel.innerHTML=bookBranches.map(b=>`<option value="${b.company_id}">${esc(b.branch)}</option>`).join('');
  const prev=bookRows[bookRows.indexOf(row)-1];
  const def=(prev && bookCid(prev)) || bookHomeCid;
  if(def && [...sel.options].some(o=>o.value===String(def))) sel.value=String(def);
  // один филиал — выбирать не из чего, поле прячем
  sel.closest('.fld').style.display = bookBranches.length<2 ? 'none' : '';
}
function removeBookRow(uid){
  if(bookRows.length<=1) return;      // последнюю строку убрать нельзя — это и есть запись
  bookRows=bookRows.filter(r=>r.uid!==uid);
  $(`#bookRows .book-item[data-uid="${uid}"]`)?.remove();
  renumberBookRows(); bookErr('');
}
// Пока строка одна, форма выглядит ровно как раньше: без номера и без крестика.
function renumberBookRows(){
  const many=bookRows.length>1;
  bookRows.forEach((r,i)=>{
    const box=$(`#bookRows .book-item[data-uid="${r.uid}"]`);
    box.querySelector('.book-item-n').textContent = many?`Запись ${i+1}`:'';
    box.querySelector('.book-item-x').style.display = many?'':'none';
  });
  const add=$('#bookAdd');
  add.style.display = bookRows.length>=BOOK_MAX_ROWS ? 'none' : '';
  add.textContent = many ? '+ Ещё мастер' : '+ Записать ещё к одному мастеру';
}

// Салон записи: по умолчанию тот, где числится клиент, но админ может выбрать соседний —
// клиент нередко просит записать его туда, где удобнее в этот раз.
async function loadBookBranches(){
  const r = await api(`/api/booking/context?client_id=${bookCtx.client_id}`).catch(()=>null);
  bookBranches = r?.branches || [];
  bookHomeCid = r?.company_id ? String(r.company_id) : '';   // «родной» салон клиента
  for(const row of bookRows){ fillBookBranches(row); await loadBookStaff(row); }
}
async function loadBookStaff(row){
  const inp=fld(row,'Staff'), dl=$(`#bkStaffList-${row.uid}`);
  inp.value=''; inp.placeholder='Загрузка…'; dl.innerHTML=''; row.staffAll=[];
  try{
    const list = await api(`/api/booking/staff?${bookQ(row)}`);
    row.staffAll=list;
    if(!list.length){ inp.placeholder='Нет мастеров, доступных к записи'; return; }
    // «любимого» мастера клиента поднимаем наверх и подставляем сразу
    list.sort((a,b)=> (b.favorite?1:0)-(a.favorite?1:0));
    dl.innerHTML=list.map(s=>
      `<option value="${esc(s.name)}" label="${s.favorite?'★ ':''}${esc(s.specialization||'')}"></option>`).join('');
    inp.placeholder='Введите имя или выберите из списка';
    // подставляем любимого мастера только в первую строку: во второй ждут ДРУГОГО мастера,
    // иначе админ каждый раз стирал бы подставленное имя
    if(list[0]?.favorite && bookRows[0]===row){ inp.value=list[0].name; row.staffPicked=list[0].id; loadBookServices(row); }
  }catch(e){ inp.placeholder='Ошибка загрузки'; bookErr(e.message); }
}
async function loadBookServices(row){
  const staff=staffId(row), inp=fld(row,'Svc'), dl=$(`#bkSvcList-${row.uid}`);
  const dsel=fld(row,'Date'), tsel=fld(row,'Time');
  dsel.disabled=true; dsel.innerHTML='<option value="">—</option>';
  tsel.disabled=true; tsel.innerHTML='<option value="">—</option>';
  inp.value=''; dl.innerHTML=''; row.serviceAll=[];
  if(!staff){ inp.disabled=true; inp.placeholder='Сначала выберите мастера'; return; }
  inp.disabled=true; inp.placeholder='Загрузка…'; bookErr('');
  try{
    const list = await api(`/api/booking/services?${bookQ(row,`&staff_id=${staff}`)}`);
    row.serviceAll=list;
    if(!list.length){ inp.placeholder='У мастера нет услуг для записи'; return; }
    list.sort((a,b)=> (b.favorite?1:0)-(a.favorite?1:0));
    dl.innerHTML=list.map(s=>{
      const price = s.price_min ? `${rub(s.price_min)}${s.price_max&&s.price_max!==s.price_min?'–'+rub(s.price_max):''}` : '';
      const len = s.seance_length ? ` · ${Math.round(s.seance_length/60)} мин` : '';
      return `<option value="${esc(s.title)}" label="${s.favorite?'★ ':''}${price}${len}"></option>`;
    }).join('');
    inp.disabled=false; inp.placeholder='Введите название или выберите из списка';
    if(list[0]?.favorite && bookRows[0]===row){ inp.value=list[0].title; row.servicePicked=list[0].id; loadBookDates(row); }
  }catch(e){ inp.placeholder='Ошибка загрузки'; bookErr(e.message); }
}
async function loadBookDates(row){
  const staff=staffId(row), svc=serviceOf(row)?.id||'', sel=fld(row,'Date'), tsel=fld(row,'Time');
  tsel.disabled=true; tsel.innerHTML='<option value="">—</option>';
  if(!staff||!svc){ sel.disabled=true; sel.innerHTML='<option value="">—</option>'; return; }
  sel.disabled=true; sel.innerHTML='<option value="">Загрузка…</option>'; bookErr('');
  try{
    const r = await api(`/api/booking/dates?${bookQ(row,`&staff_id=${staff}&service_ids=${svc}`)}`);
    const dates=r.dates||[];
    if(!dates.length){ sel.innerHTML='<option value="">У мастера нет свободных дней</option>'; return; }
    sel.innerHTML='<option value="">— выберите дату —</option>'+dates.map(d=>{
      const dt=new Date(d+'T12:00:00');
      return `<option value="${d}">${dt.toLocaleDateString('ru-RU',{day:'2-digit',month:'long',weekday:'short'})}</option>`;
    }).join('');
    sel.disabled=false;
    // К нескольким мастерам клиент идёт в ОДИН день — подставляем дату из соседней строки,
    // если этот мастер в неё работает. Не работает — админ выберет свою, строки независимы.
    const other = bookRows.filter(r2=>r2!==row).map(r2=>fld(r2,'Date').value).find(Boolean);
    if(other && dates.includes(other)){ sel.value=other; loadBookTimes(row); }
  }catch(e){ sel.innerHTML='<option value="">Ошибка загрузки</option>'; bookErr(e.message); }
}
async function loadBookTimes(row){
  const staff=staffId(row), svc=serviceOf(row)?.id||'', date=fld(row,'Date').value, sel=fld(row,'Time');
  if(!staff||!svc||!date){ sel.disabled=true; sel.innerHTML='<option value="">—</option>'; return; }
  sel.disabled=true; sel.innerHTML='<option value="">Загрузка…</option>'; bookErr('');
  try{
    const list = await api(`/api/booking/times?${bookQ(row,`&staff_id=${staff}&date=${date}&service_ids=${svc}`)}`);
    if(!list.length){ sel.innerHTML='<option value="">Свободных окон нет</option>'; return; }
    sel.innerHTML='<option value="">— выберите время —</option>'+list.map(t=>
      `<option value="${t.datetime}" data-len="${t.seance_length||0}">${t.time}</option>`).join('');
    sel.disabled=false;
  }catch(e){ sel.innerHTML='<option value="">Ошибка загрузки</option>'; bookErr(e.message); }
}
async function submitBooking(){
  const ctx=bookCtx; // closeBooking() обнулит bookCtx — держим ссылку для обновления блока
  const items=[];
  for(const [i,row] of bookRows.entries()){
    const nth = bookRows.length>1 ? `Запись ${i+1}: ` : '';
    const staff=staffId(row), service=serviceOf(row), tsel=fld(row,'Time'), dt=tsel.value;
    if(!staff){ bookErr(nth+'выберите мастера из списка — имя должно совпасть'); return; }
    if(!service){ bookErr(nth+'выберите услугу из списка — название должно совпасть'); return; }
    if(!dt){ bookErr(nth+'выберите дату и время'); return; }
    // один и тот же мастер на то же самое время — это промах админа, а не «параллельная
    // работа»: разные мастера в одно время нормальны, один мастер дважды — нет
    if(items.some(it=>it.staff_id===Number(staff) && it.datetime===dt)){
      bookErr(nth+'этот мастер уже стоит на это же время в другой строке'); return;
    }
    const len = tsel.selectedOptions[0]?.dataset.len || service.seance_length || 0;
    items.push({staff_id:Number(staff), service_ids:[Number(service.id)],
      datetime:dt, seance_length:Number(len)||undefined,
      company_id:Number(bookCid(row))||null});   // салон у каждой строки свой
  }
  const admin=await needAdmin(); if(!admin) return;
  const btn=$('#bookSubmit'); btn.disabled=true;
  btn.textContent = items.length>1 ? `Записываем (${items.length})…` : 'Записываем…';
  bookErr('');
  try{
    const r = await api('/api/booking/create',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        client_id:ctx.client_id, company_id:Number(bookCid(bookRows[0]))||null, items,
        comment:$('#bookComment').value.trim(),
        task_id:ctx.task_id||null, member_id:ctx.member_id||null, action_id:ctx.action_id||null,
        note:ctx.noteEl?($(ctx.noteEl)?.value||''):'', admin,
      })});
    closeBooking();
    // Часть записей могла не пройти (окно заняли, пока админ говорил) — созданные остаются,
    // и админ должен УВИДЕТЬ, чего не хватает: повторной отправкой мы бы задвоили удачные.
    const made=(r.created||[]).map(c=>`${c.when}${c.staff?' · '+c.staff:''}`).join(' | ');
    const nameOf = id => bookRows.map(row=>row.staffAll.find(s=>String(s.id)===String(id))?.name)
      .find(Boolean) || 'мастер';
    if(r.failed?.length) toast(`Записан частично: ${made}. НЕ прошло — ${
      r.failed.map(f=>`${nameOf(f.staff_id)}: ${f.error}`).join('; ')}`,'bad');
    else toast(`Записан. ${made}`);
    // из правки результата вернёмся туда, откуда пришли: блок списка или текущая вкладка
    if(ctx.action_id){ closeFix(); if(ctx.listId) await reloadListBlock(ctx.listId); else reloadCurrentView(); }
    else if(ctx.list_id) await reloadListBlock(ctx.list_id); else loadTasks();
  }catch(e){ bookErr(e.message||'Не удалось создать запись'); btn.disabled=false; btn.textContent='Записать в YClients'; }
}
// «запись уже создана в YClients» — просто фиксируем звонок как раньше, без создания записи
async function bookJustMark(){
  const ctx=bookCtx;
  const note = ctx.noteEl ? ($(ctx.noteEl)?.value||'') : '';
  const admin = await needAdmin(); if(!admin) return;
  closeBooking();
  try{
    if(ctx.action_id){          // пришли из исправления результата — правим тот же звонок
      closeFix();
      await sendFix(ctx.action_id,'booked',note,ctx.listId,null);
    }else if(ctx.task_id){
      await api(`/api/tasks/${ctx.task_id}/action`,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({result:'booked',note,admin})});
      toast('Отмечено'); loadTasks();
    }else if(ctx.member_id){
      await api(`/api/lists/${ctx.list_id}/members/${ctx.member_id}/action`,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({result:'booked',note,admin})});
      toast('Отмечено'); await reloadListBlock(ctx.list_id);
    }
  }catch(e){ actFailed(e,null); }
}

// «Перезвонить» и «Не ответил» — не просто отметка, а договорённость о времени:
// клиент называет когда («после обеда», «в четверг»), админ ставит этот срок в календаре.
// До срока задача не мозолит глаза, потом сама возвращается в список.
async function act(taskId,result,btn){
  if(result==='callback'||result==='no_answer'){ openSnooze({kind:'task',taskId,result,btn}); return; }
  await sendAct(taskId,result,btn,null);
}
// Пока запрос в пути, вторая кнопка не срабатывает: иначе быстрый двойной клик уходил
// двумя запросами (сервер их всё равно склеит, но лишний звонок в YClients ни к чему).
let actBusy=false;
// Фиксация не прошла — карточка ОСТАЁТСЯ на месте вместе с набранной заметкой, обведённая
// красным, и админ видит, что надо нажать ещё раз. Молчаливый провал здесь дороже всего:
// разговор уже состоялся, второй раз человеку никто не позвонит.
function actFailed(e,btn){
  const card = btn?.closest('.task,.member');
  if(card){
    card.style.opacity='';
    card.classList.add('act-failed');
    setTimeout(()=>card.classList.remove('act-failed'),6000);
  }
  toast('НЕ СОХРАНИЛОСЬ: '+(e instanceof ApiError ? e.message : 'попробуйте нажать ещё раз'),'bad');
  console.error('[act]', e);
}
async function sendAct(taskId,result,btn,until){
  if(actBusy) return; actBusy=true; if(btn) btn.disabled=true;
  try{ await doSendAct(taskId,result,btn,until); }
  catch(e){ actFailed(e,btn); }
  finally { actBusy=false; if(btn) btn.disabled=false; }
}
async function doSendAct(taskId,result,btn,until){
  const note = $('#note-'+taskId)?.value || '';
  const admin = await needAdmin(); if(!admin) return;
  await api(`/api/tasks/${taskId}/action`,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({result,note,admin,snooze_until:until})});
  const card = btn?.closest('.task') || document.querySelector(`.task[data-id="${taskId}"]`);
  if(card){card.style.transition='opacity .25s';card.style.opacity='0';}
  setTimeout(loadTasks,260);
  toast(result==='booked'?'Записан'
    : result==='no_calls'?`Не звоним ${NO_CALLS_DAYS} дней — вернётся ${whenLabel(until)}`
    : until?`Перезвонить ${whenLabel(until)}`
    : result==='callback'?'Отложено на завтра':'Отмечено');
}

// --- КОГДА ПЕРЕЗВОНИТЬ (календарь + быстрые варианты) ---
let snoozeCtx=null;
const pad2 = n => String(n).padStart(2,'0');
const ymd  = d => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
const DOW  = ['воскресенье','понедельник','вторник','среду','четверг','пятницу','субботу'];
// «2026-10-17» → «17.10». Для «не звонить до …» день недели из whenLabel не нужен:
// фраза складывалась в «не звонить до в субботу, 17.10».
const dateLabel = d => { const [, m, dd] = String(d).split(' ')[0].split('-'); return `${dd}.${m}`; };
// «2026-08-12 15:00» → «во вторник, 12.08 в 15:00»
function whenLabel(until){
  const [d,t]=until.split(' ');
  const dt=new Date(d+'T00:00:00');
  const today=ymd(new Date()), tomorrow=ymd(new Date(Date.now()+864e5));
  const day = d===today?'сегодня' : d===tomorrow?'завтра'
    : `в ${DOW[dt.getDay()]}, ${pad2(dt.getDate())}.${pad2(dt.getMonth()+1)}`;
  return day + (t?` в ${t}`:'');
}
// Быстрые варианты. «Позже сегодня» = через два часа, округлённо до часа; после 21:00
// его не предлагаем — салон закрывается, звонить уже некому.
function snoozeQuickOptions(){
  const now=new Date();
  const later=new Date(now.getTime()+2*3600e3); later.setMinutes(0,0,0);
  const out=[];
  // «Позже сегодня» предлагаем, только если эти два часа не перевалили за полночь
  // и салон ещё работает — иначе вариант бессмысленный
  if(ymd(later)===ymd(now) && later.getHours()<21) out.push({lbl:'Позже сегодня',
    sub:`в ${pad2(later.getHours())}:00`, date:ymd(later), time:`${pad2(later.getHours())}:00`});
  const d1=new Date(Date.now()+864e5), d3=new Date(Date.now()+3*864e5), d7=new Date(Date.now()+7*864e5);
  out.push({lbl:'Завтра',sub:`${pad2(d1.getDate())}.${pad2(d1.getMonth()+1)}`,date:ymd(d1),time:''});
  out.push({lbl:'Через 3 дня',sub:`${pad2(d3.getDate())}.${pad2(d3.getMonth()+1)}`,date:ymd(d3),time:''});
  out.push({lbl:'Через неделю',sub:`${pad2(d7.getDate())}.${pad2(d7.getMonth()+1)}`,date:ymd(d7),time:''});
  return out;
}
// ctx: {kind:'task', taskId, result, btn} | {kind:'member', listId, memberId, result, btn}
function openSnooze(ctx){
  snoozeCtx=ctx;
  const {result,btn}=ctx;
  // берём только имя, без бейджа филиала, который лежит в том же .tname
  const name=ctx.name||(btn?.closest('.task,.member')?.querySelector('.tname')?.firstChild?.textContent||'').trim();
  $('#snoozeTitle').textContent = result==='no_answer'?'Когда набрать снова?':'Когда перезвонить?';
  $('#snoozeWho').textContent = (name?`${name}. `:'')
    + (result==='no_answer'?'Не дозвонились — задача вернётся в список к выбранному времени.'
                           :'Клиент просил перезвонить — задача вернётся в список к выбранному времени.');
  const opts=snoozeQuickOptions();
  $('#snoozeQuick').innerHTML=opts.map((o,i)=>
    `<button type="button" data-i="${i}">${o.lbl}<span class="d">${o.sub}</span></button>`).join('');
  $('#snoozeQuick').querySelectorAll('button').forEach(b=>{
    b.onclick=()=>{const o=opts[+b.dataset.i]; $('#snoozeDate').value=o.date; $('#snoozeTime').value=o.time; syncSnooze();};
  });
  // не дозвонились — по умолчанию пробуем ещё раз сегодня, иначе завтра
  const def = (result==='no_answer' && opts[0].date===ymd(new Date())) ? opts[0] : opts.find(o=>o.lbl==='Завтра');
  $('#snoozeDate').min=ymd(new Date());
  $('#snoozeDate').value=def.date; $('#snoozeTime').value=def.time;
  syncSnooze();
  $('#snoozeModal').classList.add('open');
}
function closeSnooze(){ $('#snoozeModal').classList.remove('open'); snoozeCtx=null; }
function snoozeValue(){
  const d=$('#snoozeDate').value, t=$('#snoozeTime').value;
  return d ? (t? `${d} ${t}` : d) : null;
}
// подсветка выбранного варианта + человеческая подпись «перезвонить …»
function syncSnooze(){
  const v=snoozeValue();
  const d=$('#snoozeDate').value, t=$('#snoozeTime').value;
  const opts=snoozeQuickOptions();
  $('#snoozeQuick').querySelectorAll('button').forEach(b=>{
    const o=opts[+b.dataset.i];
    b.classList.toggle('on', !!o && o.date===d && (o.time||'')===(t||''));
  });
  // отложенное на сегодня из списка не исчезает — карточка остаётся, но красной
  $('#snoozeWhen').innerHTML = !v ? 'Выберите дату'
    : d===ymd(new Date()) ? `Останется в списке красной карточкой — <b>перезвонить${t?' в '+t:' сегодня'}</b>`
    : `Вернём в задачи <b>${whenLabel(v)}</b>${t?'':' — с утра'}`;
  $('#snoozeSubmit').disabled = !v;
}
$('#snoozeDate').oninput=syncSnooze;
$('#snoozeTime').oninput=syncSnooze;
$('#snoozeModal').onclick=e=>{ if(e.target.id==='snoozeModal') closeSnooze(); };
// одна отправка для задач и для участников списков — разница только в эндпоинте
async function submitSnooze(result,until){
  const ctx=snoozeCtx; closeSnooze();
  if(ctx.kind==='fix') await sendFix(ctx.actionId,result,$('#fixNote').value,ctx.listId,until);
  else if(ctx.kind==='member') await sendMemAct(ctx.listId,ctx.memberId,result,ctx.btn,until);
  else await sendAct(ctx.taskId,result,ctx.btn,until);
}
$('#snoozeSubmit').onclick=async()=>{
  if(!snoozeCtx) return;
  const v=snoozeValue(); if(!v) return;
  await submitSnooze(snoozeCtx.result,v);
};
// «Просил не звонить» — не отказ и не «никогда»: пауза на два месяца. Клиент исчезает
// из задач, движок его тоже не предлагает (карантин в rules.js), потом вернётся сам.
const NO_CALLS_DAYS=60;
$('#snoozeNoCalls').onclick=async(e)=>{
  e.preventDefault();
  if(!snoozeCtx) return;
  await submitSnooze('no_calls',ymd(new Date(Date.now()+NO_CALLS_DAYS*864e5)));
};

// --- СПИСКИ ОБЗВОНА НА ДАШБОРДЕ ---
async function loadLists(){
  const lists = await api('/api/lists');
  const sec=$('#listSection'), box=$('#listBlocks');
  if(!lists.length){sec.style.display='none';box.innerHTML='';return;}
  sec.style.display='';
  box.innerHTML = lists.map(l=>{
    const pct = l.total? Math.round(l.done/l.total*100):0;
    return `<div class="listblock" data-id="${l.id}">
      <div class="lb-head" onclick="toggleList(${l.id})">
        <span class="lb-chev">${ICON.chev}</span>
        <div>
          <div class="lb-name">${l.name}</div>
          <div class="lb-count">обработано ${l.done} из ${l.total}</div>
        </div>
        <span class="lb-assignee ${l.assignee?'':'empty'}" data-name="${(l.assignee||'').replace(/"/g,'&quot;')}"
          title="Ответственный за список — нажмите, чтобы изменить"
          onclick="event.stopPropagation();setAssignee(${l.id},'${(l.assignee||'').replace(/'/g,"\\'")}')">${ICON.user}${l.assignee||'без ответственного'}</span>
        <div class="lb-actions">
          <div class="lb-progress"><div style="width:${pct}%"></div></div>
          <span class="lb-del" title="Убрать с дашборда" onclick="event.stopPropagation();archiveList(${l.id},'${l.name.replace(/'/g,"\\'")}')">${ICON.trash}</span>
        </div>
      </div>
      <div class="lb-body" id="lb-body-${l.id}"></div>
    </div>`;
  }).join('');
}
async function toggleList(id){
  const block=document.querySelector(`.listblock[data-id="${id}"]`);
  const wasOpen=block.classList.contains('open');
  block.classList.toggle('open');
  if(wasOpen) return;
  // список обзванивает тот, на кого он записан — подставляем его в «Кто звонит».
  // Если звонит кто-то другой, поле рядом, можно переключить.
  const who=block.querySelector('.lb-assignee')?.dataset.name||'';
  const sel=$('#adminSelCalls');
  if(who && [...sel.options].some(o=>o.value===who)) sel.value=who;
  const body=$('#lb-body-'+id);
  body.innerHTML='<div class="muted" style="padding:12px 0">Загрузка…</div>';
  body.innerHTML = renderMembers(id, await api(`/api/lists/${id}/members`));
}
// В работе остаются только те, кому ещё звонить сегодня. Отложенные «на потом» и уже
// обработанные не мозолят глаза — они под свёртками внизу, вместе с их результатами.
function renderMembers(listId,members){
  const today=ymd(new Date());
  const soon=m=>m.status!=='done'&&(m.status!=='snoozed'||(m.callback_at||'').slice(0,10)<=today);
  const active=members.filter(soon);
  const later=members.filter(m=>m.status==='snoozed'&&!soon(m));
  const done=members.filter(m=>m.status==='done');
  const group=(list,label)=>list.length
    ? `<details class="mem-group"><summary>${label} · ${list.length}</summary>
         ${list.map(m=>renderMember(listId,m)).join('')}</details>` : '';
  return (active.length? active.map(m=>renderMember(listId,m)).join('')
       : '<div class="empty">Все обработаны — загляните в свёртки ниже</div>')
    + group(later,'Отложенные') + group(done,'Обработанные');
}
function renderMember(listId,m){
  const done=m.status==='done';
  const R={booked:'записал',callback:'перезвонить',no_answer:'не ответил',refused:'отказ',no_calls:'просил не звонить',coming:'придёт'};
  // отложенный на потом участник помечается сроком; наступил срок — карточка красная
  // у списков, обработанных до появления сроков, callback_at пуст — такие показываем обычными
  const later = m.status==='snoozed' && !!m.callback_at && !m.callback_today;
  // Клиент мог записаться сам уже после разговора. Тогда бейдж записи вытесняет и «перезвонить»,
  // и «не звонить до …»: звонить больше незачем, а старая пометка вводила админа в заблуждение.
  // У строк, где админ сам отметил «записал/придёт», записи не дублируем — это уже видно.
  const b = m.booking, selfBooked = !!b && !(done && (m.result==='booked'||m.result==='coming'));
  const cbShown = !selfBooked && m.callback_today;
  return `<div class="member ${done?'done':''}${cbShown?' callback-today':''}${later&&!selfBooked?' later':''}" id="mem-${m.member_id}">
    <div class="left">
      ${selfBooked?`<span class="cb-badge booked">${ICON.check}записан ${fmtDT(b.date)}${b.staff?' · '+esc(b.staff):''}</span>`:''}
      ${cbShown?`<span class="cb-badge">${ICON.clock}перезвонить${cbTime(m.callback_at)}</span>`:''}
      ${later&&!selfBooked?`<span class="cb-badge later">${ICON.clock}${m.result==='no_calls'?`не звонить до ${dateLabel(m.callback_at)}`:`перезвонить ${whenLabel(m.callback_at)}`}</span>`:''}
      <div class="tname" onclick="openClient(${m.client_id})">${m.name||'Без имени'}</div>
      <div class="tmeta"><span class="phone">${m.phone||'—'}</span> · совпадений: ${m.match_visits} · ${rub(m.match_spent)}${m.favorite_staff?' · '+m.favorite_staff:''}</div>
      ${done?`<div class="treason">✓ ${R[m.result]||'обработан'}${m.note?' — «'+m.note+'»':''} · ${m.admin||''}
        ${m.action_id?`<button class="jr-fix" title="Изменить результат — клиент передумал"
          onclick="openFix(${m.action_id},'${q1(m.name)}','${m.result||''}','${q1(m.note||'')}',${m.client_id},${listId})">изменить</button>`:''}
      </div>`:''}
    </div>
    ${done?'':`<div class="actions">
      <div class="res-row">${RES_LIST.map(r=>`<button class="res ${r.cls}" onclick="${r.k==='booked'
        ? `openBooking({client_id:${m.client_id},name:'${q1(m.name)}',member_id:${m.member_id},list_id:${listId},noteEl:'#memnote-${m.member_id}'})`
        : `memAct(${listId},${m.member_id},'${r.k}',this)`}">${r.t}</button>`).join('')}</div>
      <textarea placeholder="Заметка о звонке…" id="memnote-${m.member_id}"
        oninput="saveDraft('/api/lists/${listId}/members/${m.member_id}/note',this)"
        onblur="saveDraft('/api/lists/${listId}/members/${m.member_id}/note',this,true)">${esc(m.draft_note||'')}</textarea>
    </div>`}
    <button class="row-x" title="Убрать из списка"
      onclick="removeMember(${listId},${m.member_id},'${q1(m.name)}')">✕</button>
  </div>`;
}
// Убрать клиента из списка обзвона: попал по ошибке или звонить передумали.
// История его звонков остаётся в карточке — удаляется только строка списка.
async function removeMember(listId,memberId,name){
  if(!confirm(`Убрать ${name||'клиента'} из списка?`)) return;
  await api(`/api/lists/${listId}/members/${memberId}`,{method:'DELETE'});
  toast('Убран из списка');
  await reloadListBlock(listId);
}
async function memAct(listId,memberId,result,btn){
  // «Перезвонить» и «Не ответил» — тот же календарь, что и в задачах
  if(result==='callback'||result==='no_answer'){ openSnooze({kind:'member',listId,memberId,result,btn}); return; }
  await sendMemAct(listId,memberId,result,btn,null);
}
async function sendMemAct(listId,memberId,result,btn,until){
  if(actBusy) return; actBusy=true; if(btn) btn.disabled=true;
  try{ await doSendMemAct(listId,memberId,result,btn,until); }
  catch(e){ actFailed(e,btn); }
  finally { actBusy=false; if(btn) btn.disabled=false; }
}
async function doSendMemAct(listId,memberId,result,btn,until){
  const note=$('#memnote-'+memberId)?.value||'';
  const admin=await needAdmin(); if(!admin) return;
  await api(`/api/lists/${listId}/members/${memberId}/action`,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({result,note,admin,snooze_until:until})});
  toast(result==='booked'?'Записан'
    : result==='no_calls'?`Не звоним ${NO_CALLS_DAYS} дней — вернётся ${whenLabel(until)}`
    : until?`Перезвонить ${whenLabel(until)}`
    : 'Отмечено');
  await reloadListBlock(listId);
}
// перерисовать участников списка и прогресс (после звонка или записи)
async function reloadListBlock(listId){
  const members=await api(`/api/lists/${listId}/members`);
  const body=$('#lb-body-'+listId);
  if(body) body.innerHTML=renderMembers(listId,members);
  const done=members.filter(m=>m.status==='done'||m.status==='snoozed').length;  // «перезвонить» тоже работа
  const block=document.querySelector(`.listblock[data-id="${listId}"]`);
  if(!block) return;
  block.querySelector('.lb-count').textContent=`обработано ${done} из ${members.length}`;
  block.querySelector('.lb-progress>div').style.width=(members.length?Math.round(done/members.length*100):0)+'%';
}
async function setAssignee(id,current){
  const name=prompt('Ответственный администратор (пусто — убрать):',current||currentAdmin()||'');
  if(name===null) return;
  await api(`/api/lists/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({assignee:name})});
  toast(name.trim()?`Ответственный: ${name.trim()}`:'Ответственный убран');
  loadLists();
}
async function archiveList(id,name){
  if(!confirm(`Убрать список «${name}» с дашборда? История звонков сохранится в карточках клиентов.`)) return;
  await api(`/api/lists/${id}`,{method:'DELETE'});
  toast('Список убран');
  loadLists();
}

// --- ОБЗОР ---
async function loadOverview(){
  const s = await api(bp('/api/stats'));
  $('#ovKpis').innerHTML = [
    ['Открытых задач', s.open_total],
    ['Обработано сегодня', s.done_today],
    ['Записано сегодня', s.booked_today],
    ['Конверсия в запись', s.conversion_pct+'%'],
    ['Всего клиентов', s.clients_total],
  ].map(([l,n])=>`<div class="card kpi"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');

  const L=s.open_by_type.labels||{};
  const types=Object.entries(s.open_by_type).filter(([k])=>k!=='labels');
  const max=Math.max(1,...types.map(([,v])=>v));
  $('#ovTypes').innerHTML = types.length? types.map(([k,v])=>`
    <div style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;font-size:14px;margin-bottom:4px"><span>${L[k]||k}</span><span class="muted">${v}</span></div>
      <div style="height:8px;background:var(--panel2);border-radius:6px;overflow:hidden"><div style="height:100%;width:${v/max*100}%;background:var(--accent)"></div></div>
    </div>`).join('') : '<div class="muted">Открытых задач нет</div>';

  const tb=$('#ovAdmins tbody');
  tb.innerHTML = s.by_admin.length? s.by_admin.map(a=>{
    const conv=a.total?Math.round(a.booked/a.total*100):0;
    return `<tr><td>${a.admin}</td><td>${a.total}</td><td>${a.booked}</td><td>${conv}%</td></tr>`;
  }).join('') : '<tr><td colspan="4" class="muted">Сегодня ещё не было звонков</td></tr>';

  loadJournal();
}
const JR_RES={booked:'Записан',coming:'Придёт',refused:'Отказ',callback:'Перезвонить',no_answer:'Не ответил',no_calls:'Просил не звонить',wrong_number:'Неверный номер',done:'Обработан'};
const loadJournal = () => renderJournal('/api/overview/journal', $('#jrDays').value, $('#jrResult').value, $('#ovJournal'));
async function renderJournal(base,days,result,box){
  let url=`${base}?days=${days}`+(result?`&result=${result}`:'');
  const r=await api(bp(url));
  if(!r.items.length){ box.innerHTML='<div class="empty">За выбранный период звонков нет</div>'; return; }
  box.innerHTML=r.items.map(it=>{
    const b=it.booking;
    const booking=b?`<div class="jr-booking">Записан: ${b.service||'услуга'} · ${b.staff||'мастер'} · ${fmtDT(b.date)}${b.branch?' · '+b.branch:''}</div>`:'';
    // Разговор кончился ничем («отказ», «просил не звонить», «не ответил»), а человек всё-таки
    // в журнале. Результат звонка не трогаем — это история; запись показываем рядом, иначе
    // владелец видит «просил не звонить» и не знает, что клиент давно записан.
    const nb=it.booked_now;
    const nowBooked=nb?`<div class="jr-booking now">Записан позже: ${fmtDT(nb.date)}${nb.staff?' · '+esc(nb.staff):''}${nb.branch?' · '+esc(nb.branch):''}</div>`:'';
    return `<div class="jr-item">
      <span class="jr-res ${it.shown_result||it.result||'no_answer'}">${JR_RES[it.shown_result||it.result]||'звонок'}</span>
      <div class="jr-body">
        <div class="jr-name" onclick="openClient(${it.client_id})">${it.name||'Без имени'}${branchTag(it.branch)}</div>
        ${it.callback_at?`<div class="jr-callback">${ICON.clock}${it.result==='no_calls'?`не звонить до ${dateLabel(it.callback_at)}`:`набрать ${whenLabel(it.callback_at)}`}</div>`:''}
        <div class="jr-meta"><span class="phone">${it.phone||'—'}</span> · звонил: <b>${it.admin||'—'}</b></div>
        ${it.note?`<div class="jr-note">«${it.note}»</div>`:''}
        ${booking}${nowBooked}
      </div>
      <div class="jr-when">${fmtDT(it.created_at)}
        <button class="jr-fix" title="Изменить результат — клиент передумал"
          onclick="openFix(${it.id},'${q1(it.name)}','${it.result||''}','${q1(it.note||'')}',${it.client_id},null)">изменить</button>
      </div>
    </div>`;
  }).join('');
}
$('#jrDays').onchange=loadJournal;
$('#jrResult').onchange=loadJournal;

// --- ИСПРАВЛЕНИЕ РЕЗУЛЬТАТА ЗВОНКА ---
// Звонок уже зафиксирован, но жизнь поменялась: «отказался» → перезвонил и записался.
// Правим саму запись, а не добавляем новую, иначе в статистике будет два звонка вместо одного.
let fixCtx=null;
function openFix(actionId,name,result,note,clientId,listId){
  fixCtx={actionId,name,listId,clientId};
  $('#fixWho').textContent=(name?name+'. ':'')+'Сейчас записано: '+(JR_RES[result]||'звонок').toLowerCase()+'.';
  $('#fixNote').value=note||'';
  // те же кнопки, что в задачах и списках: «Записать» ведёт в форму записи YClients,
  // «Перезвонить»/«Не ответил» — в календарь, остальное фиксируется сразу
  $('#fixButtons').innerHTML=RES_LIST.map(r=>
    `<button class="res ${r.cls}" data-k="${r.k}">${r.t}</button>`).join('');
  $('#fixButtons').querySelectorAll('button').forEach(b=>{ b.onclick=()=>fixPick(b.dataset.k); });
  $('#fixModal').classList.add('open');
}
function closeFix(){ $('#fixModal').classList.remove('open'); fixCtx=null; }
$('#fixModal').onclick=e=>{ if(e.target.id==='fixModal') closeFix(); };

function fixPick(result){
  const ctx=fixCtx;
  if(result==='booked'){        // настоящая запись в YClients, звонок исправится после неё
    closeFix();
    openBooking({client_id:ctx.clientId,name:ctx.name,action_id:ctx.actionId,
      listId:ctx.listId,noteEl:'#fixNote'});
    fixCtx=ctx;                 // контекст нужен после возврата из формы записи
    return;
  }
  if(result==='callback'||result==='no_answer'){
    $('#fixModal').classList.remove('open');
    openSnooze({kind:'fix',actionId:ctx.actionId,listId:ctx.listId,result,name:ctx.name});
    return;
  }
  closeFix();
  sendFix(ctx.actionId,result,$('#fixNote').value,ctx.listId,null);
}
async function sendFix(actionId,result,note,listId,until){
  const admin = await needAdmin(); if(!admin) return;
  try{
    await api(`/api/actions/${actionId}`,{method:'PATCH',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({result,note,admin,snooze_until:until})});
  }catch(e){ actFailed(e,null); return; }
  toast('Результат изменён: '+(JR_RES[result]||result).toLowerCase()
    + (until?` · ${whenLabel(until)}`:''));
  // правили строку списка — обновляем только её блок, чтобы не схлопнуть раскрытый список
  if(listId) await reloadListBlock(listId); else reloadCurrentView();
}

// --- ОБЗВОНЫ (списки из конструктора) ---
// Отдельная вкладка: у ручных списков своя воронка и свой прогресс, в «Обзоре» они
// размывали бы показатели по автозадачам.
async function loadCalls(withLists=true){
  const s = await api(bp('/api/calls/stats'));
  $('#callKpis').innerHTML = [
    ['Активных списков', s.lists],
    ['Осталось обзвонить', s.left],
    ['Обработано из ' + s.members, s.done],
    ['Записались сегодня', s.booked_today],
    ['Придут на мероприятие', s.coming_today],
    ['Согласились', s.conversion_pct+'%'],
  ].map(([l,n])=>`<div class="card kpi"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');

  const tb=$('#callAdmins tbody');
  tb.innerHTML = s.by_admin.length? s.by_admin.map(a=>{
    const conv=a.total?Math.round(a.booked/a.total*100):0;
    return `<tr><td>${a.admin}</td><td>${a.total}</td><td>${a.booked}</td><td>${conv}%</td></tr>`;
  }).join('') : '<tr><td colspan="4" class="muted">Сегодня по спискам ещё не звонили</td></tr>';

  if(withLists) await loadLists();
  $('#callsEmpty').style.display = s.lists ? 'none' : '';
  renderJournal('/api/calls/journal', $('#cjDays').value, $('#cjResult').value, $('#callJournal'));
}
const loadCallJournal = () => renderJournal('/api/calls/journal', $('#cjDays').value, $('#cjResult').value, $('#callJournal'));
$('#cjDays').onchange=loadCallJournal;
$('#cjResult').onchange=loadCallJournal;

// --- Поштучная отправка клиента в задачи ------------------------------------
// Кнопка в строке «Клиентов» и «Конструктора»: админ увидел нужного человека — сразу
// поставил задачу позвонить, не собирая ради него целый список обзвона. Дневной набор
// (10 задач на филиал) от этого не меняется — ручные карточки идут сверх лимита и
// автоматической уборкой не снимаются: висят, пока по ним не отметят результат звонка.
const addBtn = (id) => `<button class="row-add" title="Добавить в задачи на обзвон"
  onclick="event.stopPropagation();addToTasks(${id},this)">+ в задачи</button>`;

// «+ в обзвон» — только в конструкторе: там админ разбирает выборку и решает, кого
// доложить в идущую кампанию. В «Клиентах» такой кнопки нет — оттуда работают задачами.
const callsBtn = (id,name) => `<button class="row-add" title="Добавить в список обзвона"
  onclick="event.stopPropagation();addToCalls(${id},this,'${q1(name)}')">+ в обзвон</button>`;

// Диалог выбора списка. Возвращает id списка или null, если админ передумал.
let pickListResolve=null;
function pickCallList(lists,name){
  $('#pickListWho').textContent=`${name||'Клиент'} — выберите список обзвона.`;
  $('#pickListSel').innerHTML=lists.map(l=>{
    const left=Math.max(0,(l.total||0)-(l.done||0));
    return `<option value="${l.id}">${esc(l.name)} — осталось ${left} из ${l.total||0}${l.assignee?' · '+esc(l.assignee):''}</option>`;
  }).join('');
  $('#pickListModal').classList.add('open');
  return new Promise(res=>{ pickListResolve=res; });
}
function closePickList(id){
  $('#pickListModal').classList.remove('open');
  const res=pickListResolve; pickListResolve=null;
  if(res) res(id||null);
}
$('#pickListOk').onclick=()=>closePickList(Number($('#pickListSel').value)||null);
$('#pickListCancel').onclick=()=>closePickList(null);
$('#pickListModal').onclick=e=>{ if(e.target.id==='pickListModal') closePickList(null); };

// Поштучное добавление в обзвон. Списков нет — предлагаем завести первый прямо отсюда,
// один список — кладём в него сразу, несколько — спрашиваем, в какой.
async function addToCalls(id,btn,name){
  const was=btn.textContent;
  const back=()=>{ btn.textContent=was; btn.disabled=false; };
  btn.disabled=true; btn.textContent='…';
  try{
    const lists=await api('/api/lists');
    if(!lists.length){
      const nm=prompt('Активных списков обзвона нет. Создать новый — название:','Точечный обзвон');
      if(!nm){ back(); return; }
      await api('/api/lists',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({name:nm,assignee:currentAdmin(),client_ids:[id]})});
      btn.classList.add('done'); btn.textContent='в обзвоне'; btn.title='Список «'+nm+'» создан';
      toast(`Список «${nm}» создан, клиент в нём`);
      return;
    }
    const listId = lists.length===1 ? lists[0].id : await pickCallList(lists,name);
    if(!listId){ back(); return; }   // закрыл диалог — ничего не делаем
    const r=await api(`/api/lists/${listId}/members`,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({client_id:id})});
    btn.classList.add('done');
    btn.textContent = r.already ? 'уже в обзвоне' : 'в обзвоне';
    btn.title = `Список «${r.list_name}»`;
    toast(r.already
      ? `${r.name||'Клиент'} уже ждёт звонка в «${r.list_name}»`
      : `${r.name||'Клиент'} — в списке «${r.list_name}»`);
  }catch(e){
    back();
    toast('Не удалось добавить в обзвон: '+(e.message||''),'bad');
  }
}

async function addToTasks(id,btn){
  const was=btn.textContent;
  btn.disabled=true; btn.textContent='…';
  try{
    const r=await api('/api/tasks/manual',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({client_id:id,admin:currentAdmin()})});
    btn.classList.add('done');
    if(r.already){
      btn.textContent='уже в задачах'; btn.title='Задача уже висит: '+r.type_label;
      toast(`${r.name||'Клиент'} уже в задачах — ${r.type_label}`);
    }else{
      btn.textContent='в задачах'; btn.title='Задача создана, ждёт звонка';
      toast(`${r.name||'Клиент'} — теперь в задачах`);
    }
  }catch(e){
    btn.textContent=was; btn.disabled=false;
    toast('Не удалось добавить в задачи: '+(e.message||''),'bad');
  }
}

// --- КЛИЕНТЫ ---
let searchTimer;
$('#clientSearch').oninput = e=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>loadClients(e.target.value),250);};
async function loadClients(q=''){
  const rows = await api(bp('/api/clients?q='+encodeURIComponent(q)));
  const tb=$('#clientTable tbody');
  tb.innerHTML = rows.map(c=>`
    <tr class="crow" onclick="openClient(${c.id})">
      <td title="${(c.comment||'').replace(/"/g,'&quot;')}">${c.do_not_call?ICON.ban:''}${c.name||'—'}${branchTag(c.branch)}</td>
      <td class="phone">${c.phone||'—'}</td>
      <td>${c.visits_count||0}</td>
      <td>${c.avg_interval_days?'~'+Math.round(c.avg_interval_days)+' дн.':'—'}</td>
      <td>${fmtDate(c.last_visit)}</td>
      <td>${fmtDate(c.predicted_next)}</td>
      <td class="tdadd">${addBtn(c.id)}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="empty">Ничего не найдено</td></tr>';
}

// --- РУЧНЫЕ СПИСКИ: VIP, ДЕПОЗИТ, АЛИСА ---
// Постоянные ручные списки. Клиент живёт в списке, пока админ сам не удалит. Автоматические
// задачи по таким клиентам не ставятся — их ведут персонально; в выборках конструктора они
// при этом видны и помечены бейджем (поле lists у строки выборки).
// Списки отличаются ТОЛЬКО названием и префиксом id-шников в разметке, поэтому вся механика
// (поиск, добавление, заметка, удаление, кнопка в карточке клиента) написана один раз и
// параметризуется slug'ом. На сервере ровно так же — см. MANUAL_LISTS в src/db.js.
// Новый список = строка здесь + строка в MANUAL_LISTS + секция в index.html.
const LIST_UI = {
  vip:     { pre:'vip', icon:'star',   name:'VIP',       tag:'VIP',     intoTx:'в VIP',       inTx:'В VIP',      addTx:'— в VIP',       delTx:'Убрать из VIP' },
  deposit: { pre:'dep', icon:'wallet', name:'«Депозит»', tag:'Депозит', intoTx:'в «Депозит»', inTx:'В Депозите', addTx:'— в «Депозит»', delTx:'Убрать из «Депозита»' },
  alice:   { pre:'ali', icon:'user',   name:'«Алиса»',   tag:'Алиса',   intoTx:'в «Алису»',   inTx:'В «Алисе»',  addTx:'— в «Алису»',   delTx:'Убрать из «Алисы»' },
};
const listIds = { vip:new Set(), deposit:new Set(), alice:new Set() };
// Бейджи «этот клиент в ручном списке» для таблицы выборки конструктора.
// Раньше таких клиентов там не показывали вовсе; теперь показываем, но помечаем,
// чтобы админ видел, что человека уже ведут персонально.
const listTags = slugs => (slugs||[]).map(sl => LIST_UI[sl]
  ? ` <span class="list-tag lt-${sl}" title="Клиент в списке ${LIST_UI[sl].name} — задачи по нему не ставятся">${LIST_UI[sl].tag}</span>` : '').join('');

async function loadList(slug){
  const u=LIST_UI[slug];
  const r=await api('/api/'+slug);
  listIds[slug]=new Set(r.items.map(i=>i.client_id));
  $('#'+u.pre+'Summary').innerHTML = r.count
    ? `В списке: <b>${plural(r.count,'клиент','клиента','клиентов')}</b> · суммарно потратили ${rub(r.total_spent)}`
    : '';
  const box=$('#'+u.pre+'List');
  if(!r.count){ box.innerHTML=`<div class="empty">Пока пусто. Найдите клиента в поле выше и добавьте его ${u.intoTx}.</div>`; return; }
  box.innerHTML=r.items.map(v=>{
    const br=(v.branches||[]).map(branchTag).join('');
    const n=v.next_visit;
    return `<div class="vip-card lc-${slug} ${slug!=='vip'?'dep':''}">
      <div class="left">
        <div class="vip-nm" onclick="openClient(${v.client_id})"><span class="vip-star">${ICON[u.icon]}</span> ${v.do_not_call?ICON.ban:''}${v.name||'Без имени'}${br}</div>
        <div class="tmeta"><span class="phone">${v.phone||'—'}</span>${v.top_master?' · мастер: '+v.top_master:''} · <span class="status-badge st-${v.status}">${v.status_label}</span></div>
        <div class="vip-metrics">
          <span class="vip-m">потратил <b>${rub(v.spent)}</b></span>
          <span class="vip-m">визитов <b>${v.visits}</b></span>
          <span class="vip-m">средний чек <b>${rub(v.avg_check)}</b></span>
          <span class="vip-m">последний <b>${fmtDate(v.last_visit)}</b>${v.since_last_days!=null?` (${v.since_last_days} дн.)`:''}</span>
          ${v.deposit_balance?`<span class="vip-m">депозит <b>${rub(v.deposit_balance)}</b></span>`:''}
          ${v.cards>1?`<span class="vip-m">карточек в YClients: <b>${v.cards}</b></span>`:''}
        </div>
        ${n?`<div class="vip-next">Записан: ${n.service||'услуга'} · ${n.staff||'мастер'} · ${fmtDT(n.date)}${n.branch?' · '+n.branch:''}</div>`:''}
        <div class="vip-note ${v.note?'':'empty'}" onclick="editListNote('${slug}',${v.client_id},'${q1(v.note)}')">${v.note?v.note:'Добавить заметку'}</div>
      </div>
      <div class="vip-acts">
        <button class="btn" onclick="openClient(${v.client_id})">История</button>
        <button class="vip-del" onclick="removeFromList('${slug}',${v.client_id},'${q1(v.name)}')">${u.delTx}</button>
      </div>
    </div>`;
  }).join('');
}
async function listSuggest(slug,q){
  const u=LIST_UI[slug];
  const box=$('#'+u.pre+'Suggest');
  if(!q.trim()){box.classList.remove('open');box.innerHTML='';return;}
  const list=await api(`/api/${slug}/search?q=`+encodeURIComponent(q));
  box.classList.add('open');
  box.innerHTML = list.length ? list.map(c=>`
    <div class="vip-sug ${c.added?'added':''}" ${c.added?'':`onclick="addToList('${slug}',${c.id},'${q1(c.name)}')"`}>
      <div>
        <div class="nm">${c.name||'Без имени'}${(c.branches||[]).map(branchTag).join('')}</div>
        <div class="mt">${c.phone||'—'} · ${c.visits} визитов · последний ${fmtDate(c.last_visit)}${c.added?` · уже в списке`:''}</div>
      </div>
      <div class="sp">${rub(c.spent)}</div>
    </div>`).join('') : '<div class="vip-sug" style="cursor:default"><div class="mt">Никого не найдено</div></div>';
}
async function addToList(slug,id,name){
  const u=LIST_UI[slug];
  await api('/api/'+slug,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({client_id:id,admin:currentAdmin()})});
  $('#'+u.pre+'Search').value='';$('#'+u.pre+'Suggest').classList.remove('open');
  toast(`${name} ${u.addTx}`);
  await loadList(slug);
}
async function removeFromList(slug,id,name){
  const u=LIST_UI[slug];
  if(!confirm(`Убрать «${name}» из ${u.name}? По клиенту снова начнут ставиться автоматические задачи.`)) return;
  await api(`/api/${slug}/${id}`,{method:'DELETE'});
  toast('Убран из списка');
  await loadList(slug);
}
async function editListNote(slug,id,current){
  const note=prompt(`Заметка по клиенту (${LIST_UI[slug].name}, пусто — убрать):`,current||'');
  if(note===null) return;
  await api(`/api/${slug}/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({note})});
  await loadList(slug);
}
// добавить/убрать прямо из карточки клиента
async function toggleListFromDrawer(slug){
  if(!drawerClientId) return;
  const u=LIST_UI[slug], on=listIds[slug].has(drawerClientId);
  if(on) await api(`/api/${slug}/${drawerClientId}`,{method:'DELETE'});
  else await api('/api/'+slug,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({client_id:drawerClientId,admin:currentAdmin()})});
  if(on) listIds[slug].delete(drawerClientId); else listIds[slug].add(drawerClientId);
  renderListToggle(slug);
  toast(on?`Убран из ${u.name}`:`Добавлен в ${u.name}`);
  if(document.querySelector('.tab.active')?.dataset.view===slug) loadList(slug);
}
function renderListToggle(slug){
  const u=LIST_UI[slug], b=$('#'+u.pre+'Toggle'), on=listIds[slug].has(drawerClientId);
  b.classList.toggle('on',on);
  b.innerHTML = ICON[u.icon] + u.inTx;
}
let listTimer={};
for(const slug of Object.keys(LIST_UI)){
  $('#'+LIST_UI[slug].pre+'Search').oninput=e=>{
    clearTimeout(listTimer[slug]);
    const q=e.target.value;
    listTimer[slug]=setTimeout(()=>listSuggest(slug,q),250);
  };
}

// --- АНАЛИТИКА ---
// Графики рисуем сами, инлайновым SVG: в проекте намеренно нет ни одной внешней
// библиотеки, и заводить её ради столбиков не стоит. Все размеры — в системе координат
// viewBox, наружу SVG растягивается по ширине карточки.

const MONTH_SHORT = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
// '2026-08' → «авг 26»
const mLabel = m => { const [y,mo]=String(m).split('-').map(Number);
  return `${MONTH_SHORT[mo-1]} ${String(y).slice(2)}`; };
// Масштабируем пропорционально: с preserveAspectRatio="none" подписи на осях
// растягивались бы по горизонтали вместе с картинкой и выглядели приплюснутыми.
const svgWrap = (h, inner) =>
  `<svg viewBox="0 0 760 ${h}" class="an-svg">${inner}</svg>`;

// Горизонтальная сетка с подписями значений — общая для столбчатых графиков
function grid(max, top, bottom, fmt=String){
  const steps=4, out=[];
  for(let i=0;i<=steps;i++){
    const v=max*i/steps, y=bottom-(bottom-top)*(i/steps);
    out.push(`<line x1="44" x2="752" y1="${y}" y2="${y}" class="an-grid"/>
      <text x="40" y="${y+4}" class="an-ax" text-anchor="end">${fmt(Math.round(v))}</text>`);
  }
  return out.join('');
}

// Столбцы с накоплением: две серии друг на друге (новые + вернувшиеся)
function chartStacked(rows, aKey, bKey){
  if(!rows.length) return '<div class="empty">Данных за период нет</div>';
  const H=230, top=16, bottom=H-30;
  const max=Math.max(1,...rows.map(r=>r[aKey]+r[bKey]));
  const bw=(752-44)/rows.length, w=Math.min(bw*0.62,46);
  const bars=rows.map((r,i)=>{
    const x=44+bw*i+(bw-w)/2, sc=(bottom-top)/max;
    const ha=r[aKey]*sc, hb=r[bKey]*sc;
    return `<rect x="${x}" y="${bottom-hb}" width="${w}" height="${hb}" class="an-b2"><title>${mLabel(r.m)}: вернувшихся ${r[bKey]}</title></rect>
      <rect x="${x}" y="${bottom-hb-ha}" width="${w}" height="${ha}" class="an-b1"><title>${mLabel(r.m)}: новых ${r[aKey]}</title></rect>
      <text x="${x+w/2}" y="${H-10}" class="an-ax" text-anchor="middle">${mLabel(r.m)}</text>`;
  }).join('');
  return svgWrap(H, grid(max,top,bottom)+bars);
}

// Столбцы + линия поверх (звонки и конверсия; когорты и процент возврата)
function chartBarsLine(rows, barKey, lineKey, lineMax=100){
  if(!rows.length) return '<div class="empty">Данных за период нет</div>';
  const H=230, top=16, bottom=H-30;
  const max=Math.max(1,...rows.map(r=>r[barKey]));
  const bw=(752-44)/rows.length, w=Math.min(bw*0.62,46);
  const bars=rows.map((r,i)=>{
    const x=44+bw*i+(bw-w)/2, h=r[barKey]*(bottom-top)/max;
    // неполный период — штриховкой: окно возврата ещё не истекло, цифра вырастет
    return `<rect x="${x}" y="${bottom-h}" width="${w}" height="${h}" class="an-b1${r.partial?' partial':''}">
        <title>${mLabel(r.m)}: ${r[barKey]}${r.partial?' (период не закрыт)':''}</title></rect>
      <text x="${x+w/2}" y="${H-10}" class="an-ax" text-anchor="middle">${mLabel(r.m)}</text>`;
  }).join('');
  const lineY = r => bottom-(r[lineKey]||0)*(bottom-top)/lineMax;
  const pts=rows.map((r,i)=>`${44+bw*i+bw/2},${lineY(r)}`).join(' ');
  // Цифру доли пишем прямо у точки: левая шкала отмеряет столбцы (штуки), а не проценты,
  // и без подписи линию приходится читать на глаз. У верхнего края подпись уводим под точку,
  // чтобы она не вылезала за пределы графика.
  const small = rows.length>12 ? ' sm' : '';
  const dots=rows.map((r,i)=>{
    const x=44+bw*i+bw/2, y=lineY(r), above = y-top>16;
    return `<circle cx="${x}" cy="${y}" r="3.5" class="an-dot">
      <title>${mLabel(r.m)}: ${r[lineKey]||0}%</title></circle>
      <text x="${x}" y="${above?y-9:y+16}" class="an-dotv${small}" text-anchor="middle">${r[lineKey]||0}%</text>`;
  }).join('');
  return svgWrap(H, grid(max,top,bottom)+bars+`<polyline points="${pts}" class="an-line"/>`+dots);
}

// Горизонтальные полосы — для списков (статусы, типы задач, админы)
function chartHBars(rows){
  if(!rows.length) return '<div class="empty">Данных за период нет</div>';
  const max=Math.max(1,...rows.map(r=>r.value));
  return `<div class="an-hb">`+rows.map(r=>`
    <div class="an-hb-row">
      <span class="an-hb-l">${esc(r.label)}</span>
      <span class="an-hb-t"><span class="an-hb-f ${r.cls||''}" style="width:${Math.max(2,r.value/max*100)}%"></span></span>
      <span class="an-hb-v">${esc(r.note||String(r.value))}</span>
    </div>`).join('')+`</div>`;
}

const kpi = (n,l,hint) => `<div class="kpi"${hint?` title="${esc(hint)}"`:''}><div class="n">${n}</div><div class="l">${l}</div></div>`;

// Строки с малым числом людей не показываем как выводы: на десятке человек проценты —
// случайность. Порог грубый, но спасает от уверенных заявлений на пустом месте.
const MIN_GROUP = 30;

let anLoaded=false;
async function loadAnalytics(){
  if(!anLoaded){ anLoaded=true; $('#anMonths').onchange=loadAnalytics; }
  const months=$('#anMonths').value;
  const r=await api('/api/analytics?months='+months);

  // с какого дня вообще есть чем мерить работу программы
  const p=r.program;
  $('#anSince').innerHTML = p.started
    ? `Программой пользуются с <b>${fmtDate(p.started)}</b> · сделано ${plural(p.calls,'отметка звонка','отметки звонка','отметок звонков')} по ${plural(p.clients,'клиенту','клиентам','клиентам')}`
    : 'Отметок звонков пока нет — раздел «Работа программы» наполнится, когда админы начнут отмечать результаты.';

  // --- клиентская база ---
  const bm=r.base.by_month, last=bm[bm.length-1];
  const newSum=bm.reduce((s,x)=>s+x.new_clients,0), retSum=bm.reduce((s,x)=>s+x.returning,0);
  const done=r.base.cohorts.filter(c=>!c.partial);
  const avgRet=done.length?Math.round(done.reduce((s,c)=>s+c.pct,0)/done.length):0;
  $('#anBaseKpis').innerHTML =
    kpi(newSum,'новых клиентов за период')+
    kpi(retSum,'визитов вернувшихся')+
    kpi(avgRet+'%','новых пришли снова','Доля новых клиентов, вернувшихся в салон в течение 60 дней после первого визита. Месяцы, где 60 дней ещё не прошли, не учитываются.')+
    kpi(last?last.clients:0,'клиентов в последнем месяце');
  $('#anNewRet').innerHTML = chartStacked(bm,'new_clients','returning')+
    `<div class="an-leg"><span><i class="an-b1"></i>новые</span><span><i class="an-b2"></i>вернувшиеся</span></div>`;
  const ST={active:'Активные',due:'Пора записать',churn:'Уходят',new:'Без визитов'};
  const stTotal=r.base.statuses.reduce((s,x)=>s+x.n,0)||1;
  $('#anStatus').innerHTML = chartHBars(r.base.statuses
    .sort((a,b)=>b.n-a.n)
    .map(s=>({label:ST[s.st]||s.st, value:s.n, cls:'st-'+s.st,
              note:`${s.n} · ${Math.round(s.n/stTotal*100)}%`})));

  // --- работа программы ---
  const c=r.crm;
  if(!c.called.people){
    $('#anCrmKpis').innerHTML='';
    ['anTypes','anCalls'].forEach(id=>
      $('#'+id).innerHTML='<div class="empty">Звонков за период не отмечено</div>');
    $('#anCaveat').innerHTML='';
    return;
  }
  $('#anCrmKpis').innerHTML =
    kpi(c.called.people,'обзвонено клиентов')+
    kpi(c.calls_total,'сделано звонков')+
    kpi(c.conv+'%','записались или согласились')+
    kpi(rub(c.called.revenue),'принесли обзвонённые','Сумма визитов тех, кто пришёл в течение 30 дней после звонка. Это факт прихода, а не заслуга звонка — часть этих людей вернулась бы и сама.');
  // Типы задач сравнимы между собой: обе стороны из числа обзвонённых, отбор одинаковый.
  // Строки с малым числом людей помечаем — на них выводы не строят.
  $('#anTypes').innerHTML = chartHBars(c.by_type.map(t=>({
    label:t.label, value:t.pct,
    cls: t.people<MIN_GROUP ? 'st-new' : (t.pct>=10?'st-active':'st-due'),
    note:`${t.pct}% · ${t.returned} из ${t.people}${t.people<MIN_GROUP?' · мало данных':''} · ${rub(t.revenue)}`
  })));
  $('#anCalls').innerHTML = chartBarsLine(c.by_month,'calls','conv')+
    `<div class="an-leg"><span><i class="an-b1"></i>отметок звонков</span><span><i class="an-lin"></i>записались, %</span></div>`;
  // Прямо на вкладке объясняем, почему здесь НЕТ цифры «программа принесла столько-то».
  // Без этого владелец решит, что её забыли посчитать, — а её честно посчитать нельзя.
  $('#anCaveat').innerHTML = `<b>Почему здесь нет цифры «программа принесла N рублей».</b>
    Чтобы её получить, нужно знать, сколько из этих людей вернулось бы и без звонка.
    Сравнивать с теми, кому не звонили, нельзя: движок снимает задачу, когда клиент
    записался сам, и в такой «контрольной» группе оказываются как раз те, кто вернулся
    своим ходом. Честный ответ даст только эксперимент — часть задач случайным образом
    помечать «не звонить» и через месяц сравнить группы.`;
}

// --- СКРИПТЫ (шаблоны сообщений) ---
// Хранилище текстов, которыми админы пишут клиентам. Категорий заранее нет: админ вписывает
// свою, и она сама попадает в фильтр и в подсказки. Основной сценарий — «Копировать»
// и вставить в мессенджер; из карточки клиента шаблон открывается уже с подставленным
// именем и мастером, с возможностью поправить текст перед копированием.
let scripts=[], scCats=[], scFilter='', scQuery='', scEditId=null, scLoaded=false, scUseId=null;

async function loadScripts(){
  const r=await api('/api/scripts'+(scFilter?'?category='+encodeURIComponent(scFilter):''));
  scripts=r.items; scCats=r.categories; scLoaded=true;
  renderScCats();
  renderScList();
}
function renderScCats(){
  const all=`<button class="sc-cat ${scFilter?'':'on'}" onclick="pickScCat('')">Все</button>`;
  $('#scCats').innerHTML = all + scCats.map(c=>
    `<button class="sc-cat ${scFilter===c.category?'on':''}" onclick="pickScCat('${q1(c.category)}')">${esc(c.category)} <span>${c.n}</span></button>`
  ).join('');
}
// Поиск фильтрует уже загруженный список на месте: шаблонов десятки, а не тысячи,
// и ходить за этим на сервер на каждую букву незачем.
function renderScList(){
  const q=scQuery.toLowerCase().trim();
  const list=q ? scripts.filter(s=>(s.title+' '+s.body).toLowerCase().includes(q)) : scripts;
  const box=$('#scList');
  if(!list.length){
    box.innerHTML = scripts.length
      ? '<div class="empty">Ничего не нашлось. Попробуйте другое слово или сбросьте категорию.</div>'
      : '<div class="empty">Шаблонов пока нет. Нажмите «Новый шаблон» — категорию можно вписать любую, она сама появится в фильтре.</div>';
    return;
  }
  box.innerHTML=list.map(s=>`<div class="sc-card">
    <div class="sc-hd">
      <div class="sc-t">${esc(s.title)}</div>
      ${s.category?`<span class="sc-tag">${esc(s.category)}</span>`:''}
      ${s.used_count?`<span class="sc-used">использован ${s.used_count}×</span>`:''}
    </div>
    <div class="sc-body">${esc(s.body)}</div>
    <div class="sc-acts">
      <button class="btn primary" onclick="copyScript(${s.id})">${ICON.copy}Копировать</button>
      <button class="btn" onclick="openScEdit(${s.id})">Изменить</button>
      <button class="btn" onclick="deleteScript(${s.id},'${q1(s.title)}')">Удалить</button>
    </div>
  </div>`).join('');
}
function pickScCat(c){ scFilter=c; loadScripts(); }
$('#scSearch').oninput=e=>{ scQuery=e.target.value; renderScList(); };

async function copyScript(id){
  const s=scripts.find(x=>x.id===id); if(!s) return;
  if(await copyText(s.body)){
    toast('Текст скопирован');
    api(`/api/scripts/${id}/used`,{method:'POST'}).catch(()=>{});  // счётчик не критичен
  } else toast('Не удалось скопировать — выделите текст вручную','bad');
}

// --- ИИ-помощник ---
// Показываем блок, только если на сервере есть ключ YandexGPT. Проверяем один раз
// за загрузку страницы: ключ в .env посреди рабочего дня не появляется.
let scAiOn=null;
async function checkScAi(){
  if(scAiOn!==null) return scAiOn;
  try{ scAiOn=(await api('/api/scripts/ai')).enabled; }catch{ scAiOn=false; }
  return scAiOn;
}
// Переписка с моделью живёт, пока открыта форма. На сервере её не храним: разговор
// нужен ровно для одного шаблона и заканчивается вместе с ним.
let scAiHistory=[];
function renderScAiLog(pending){
  const log=$('#scAiLog');
  $('#scAiReset').style.display = scAiHistory.length ? '' : 'none';
  log.innerHTML = scAiHistory.map((m,i)=>
    m.role==='user'
      ? `<div class="sc-msg me">${esc(m.text)}</div>`
      : `<div class="sc-msg ai">${esc(m.text)}<button type="button" class="sc-take" onclick="takeScAi(${i})">Вставить в шаблон</button></div>`
  ).join('') + (pending?'<div class="sc-msg ai pending">пишет…</div>':'');
  // именно 'flex', а не '': в стилях у блока display:none, и пустая строка вернула бы его
  log.style.display = (scAiHistory.length||pending) ? 'flex' : 'none';
  log.scrollTop = log.scrollHeight;
}
function takeScAi(i){
  const m=scAiHistory[i]; if(!m) return;
  $('#scBody').value=m.text;
  $('#scBody').focus();
  toast('Текст перенесён в шаблон');
}
function resetScAi(){
  scAiHistory=[];
  $('#scAiTask').value='';
  $('#scAiTask').placeholder='Опишите задачу: напр. «позвать на окрашивание тех, кто не был полгода»';
  $('#scAiNote').textContent='Ответ сразу попадёт в поле «Текст сообщения» ниже. Дальше можно просить правки словами или дописать руками.';
  renderScAiLog(false);
}
$('#scAiReset').onclick=resetScAi;
async function sendScAi(){
  const task=$('#scAiTask').value.trim();
  const note=$('#scAiNote'), b=$('#scAiGo');
  if(!task){ note.textContent='Напишите, что нужно'; return; }
  scAiHistory.push({role:'user',text:task});
  $('#scAiTask').value='';
  renderScAiLog(true);
  b.disabled=true;
  note.textContent='YandexGPT думает, это займёт несколько секунд…';
  try{
    const r=await api('/api/scripts/chat',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({messages:scAiHistory, title:$('#scTitle').value.trim()})});
    scAiHistory.push({role:'assistant',text:r.text});
    renderScAiLog(false);
    $('#scBody').value=r.text;   // свежий ответ сразу в поле шаблона
    $('#scAiTask').placeholder='Что поправить? напр. «короче», «убери про сертификат», «дай другой вариант»';
    note.textContent='Не то? Напишите, что поправить — он помнит разговор.';
  }catch(e){
    scAiHistory.pop();           // неудачную реплику из истории убираем, иначе она уедет в следующий запрос
    renderScAiLog(false);
    $('#scAiTask').value=task;   // и возвращаем текст в поле, чтобы не набирать заново
    note.textContent=e.message||'Не удалось сгенерировать';
  }
  b.disabled=false;
}
$('#scAiGo').onclick=sendScAi;
// Enter отправляет, Shift+Enter — перенос строки: в чате так привычнее
$('#scAiTask').onkeydown=e=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendScAi(); } };

// --- Создание и правка шаблона ---
function openScEdit(id){
  scEditId=id||null;
  const s=id?scripts.find(x=>x.id===id):null;
  $('#scEditTitle').textContent = s?'Изменить шаблон':'Новый шаблон';
  $('#scTitle').value=s?s.title:'';
  $('#scCategory').value=s?(s.category||''):'';
  $('#scBody').value=s?s.body:'';
  $('#scEditError').textContent='';
  $('#scCatList').innerHTML=scCats.map(c=>`<option value="${esc(c.category)}">`).join('');
  resetScAi();   // помощник — с чистого листа при каждом открытии формы
  checkScAi().then(on=>{ $('#scAi').style.display = on ? '' : 'none'; });
  $('#scEditModal').classList.add('open');
  $('#scTitle').focus();
}
function closeScEdit(){ $('#scEditModal').classList.remove('open'); scEditId=null; }
$('#scNew').onclick=()=>openScEdit(null);
$('#scEditModal').onclick=e=>{ if(e.target.id==='scEditModal') closeScEdit(); };
$('#scSave').onclick=async ()=>{
  const payload={title:$('#scTitle').value.trim(), category:$('#scCategory').value.trim(),
    body:$('#scBody').value.trim(), admin:currentAdmin()};
  const err=$('#scEditError'); err.textContent='';
  if(!payload.title){ err.textContent='Введите название'; return; }
  if(!payload.body){ err.textContent='Введите текст сообщения'; return; }
  const b=$('#scSave'); b.disabled=true;
  try{
    if(scEditId) await api(`/api/scripts/${scEditId}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    else await api('/api/scripts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    closeScEdit();
    toast(scEditId?'Шаблон обновлён':'Шаблон сохранён');
    await loadScripts();
  }catch(e){ err.textContent=e.message||'Не удалось сохранить'; }
  b.disabled=false;
};
async function deleteScript(id,title){
  if(!confirm(`Удалить шаблон «${title}»? Отменить это будет нельзя.`)) return;
  await api(`/api/scripts/${id}`,{method:'DELETE'});
  toast('Шаблон удалён');
  await loadScripts();
}

// --- Шаблон под конкретного клиента (из карточки) ---
// Подстановки раскрываем на клиенте: все нужные данные уже приехали вместе с карточкой.
function scFill(body){
  const d=drawerData; if(!d) return body;
  const c=d.client, s=d.stats;
  const next=(d.timeline||[]).filter(e=>e.kind==='visit' && e.status==='upcoming' && new Date(e.date)>=new Date())
    .sort((a,b)=>new Date(a.date)-new Date(b.date))[0];
  const vals={
    // в базе имя лежит целиком («Смирнова Елена»); в сообщении уместно одно слово
    'имя':   String(c.name||'').trim().split(/\s+/)[0] || 'клиент',
    'мастер': (s.masters[0] && s.masters[0].name!=='—' ? s.masters[0].name : (c.favorite_staff||'')),
    'услуга': next?.title || (s.services[0]?.name) || '',
    'дата':   next ? fmtDT(next.date) : '',
    'филиал': (c.branches&&c.branches.length?c.branches.join(', '):c.branch)||'',
  };
  // Метку могут написать в склонённом виде — и админ руками, и ИИ («запишем на {услугу}»).
  // Ловим по основе слова: нераспознанная метка уехала бы клиенту прямо в фигурных
  // скобках, а это худшее, что может случиться с сообщением.
  const STEMS=[[/^им[ея]/,'имя'],[/^мастер/,'мастер'],[/^услуг/,'услуга'],
               [/^дат/,'дата'],[/^филиал/,'филиал']];
  // незаполненную подстановку оставляем видимой — пусть админ заметит и допишет сам,
  // это лучше, чем отправить клиенту фразу с дырой в середине
  return body.replace(/\{([^}]+)\}/g, (m,k)=>{
    const key=k.trim().toLowerCase();
    const hit=STEMS.find(([re])=>re.test(key));
    const v=hit ? vals[hit[1]] : vals[key];
    return v ? v : m;
  });
}
async function openScUse(){
  if(!drawerClientId) return;
  if(!scLoaded) await loadScripts();
  scUseId=null;
  $('#scUseWho').textContent = $('#drawerName').textContent;
  $('#scUseBody').value='';
  renderScPick(null);
  $('#scUseModal').classList.add('open');
}
function closeScUse(){ $('#scUseModal').classList.remove('open'); }
$('#scUseModal').onclick=e=>{ if(e.target.id==='scUseModal') closeScUse(); };
function renderScPick(activeId){
  $('#scPick').innerHTML = scripts.length
    ? scripts.map(s=>`<button class="sc-chip ${s.id===activeId?'on':''}" onclick="useScript(${s.id})">${esc(s.title)}</button>`).join('')
    : '<div class="muted" style="font-size:12.5px">Шаблонов пока нет — заведите их на вкладке «Скрипты».</div>';
}
function useScript(id){
  const s=scripts.find(x=>x.id===id); if(!s) return;
  scUseId=id;
  $('#scUseBody').value=scFill(s.body);
  renderScPick(id);
}
$('#scCopyUse').onclick=async ()=>{
  const text=$('#scUseBody').value.trim();
  if(!text){ toast('Сначала выберите шаблон'); return; }
  if(await copyText(text)){
    toast('Текст скопирован — вставьте в мессенджер');
    if(scUseId) api(`/api/scripts/${scUseId}/used`,{method:'POST'}).catch(()=>{});
    closeScUse();
  } else toast('Не удалось скопировать — выделите текст вручную','bad');
};

// --- ДНИ РОЖДЕНИЯ ---
// Сверху — именинники выбранного дня (по умолчанию сегодняшнего), снизу — календарь.
// Заметка к ДР пишется заранее и лежит вечно: в день рождения клиента она сама всплывает
// в списке, чтобы админ не искал, что для человека готовили.
const MONTHS_RU = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
let bdToday=null;       // сегодня по данным сервера (Москва), чтобы не зависеть от часов ПК
let bdPickDate=null;    // день, выбранный в календаре (список под ним), null — не выбран
let bdCal={year:0,month:0};
let bdLoaded=false;

// 'YYYY-MM-DD' → «17 апреля 1985». Разбираем строку руками: new Date('YYYY-MM-DD')
// считается UTC-полночью и в минусовых поясах показал бы предыдущий день.
// Год 0000 означает «в YClients указаны только день и месяц» — тогда год не печатаем
// и возраст не считаем. Подставляем 2000 при разборе: годы 0–99 JS сам уводит в 1900-е.
const bdNoYear = s => String(s||'').startsWith('0000-');
const bdParse = s => { const [y,m,d]=String(s).split('-').map(Number); return new Date(y||2000,m-1,d); };
const fmtBd = s => !s ? '—' : bdParse(s).toLocaleDateString('ru-RU',
  bdNoYear(s) ? {day:'numeric',month:'long'} : {day:'numeric',month:'long',year:'numeric'});
const fmtBdShort = s => s ? bdParse(s).toLocaleDateString('ru-RU',{day:'numeric',month:'long'}) : '—';

async function loadBday(){
  if(!bdLoaded){
    bdLoaded=true;
    $('#bdMonthSel').innerHTML = MONTHS_RU.map((m,i)=>`<option value="${i+1}">${m}</option>`).join('');
  }
  await loadBdayToday();
  await loadBdayMonth(bdCal.year, bdCal.month);
}

// Верхний блок — ВСЕГДА сегодняшние именинники. Их видно сразу при открытии вкладки,
// и они не подменяются датой, выбранной в календаре (та уезжает вниз).
async function loadBdayToday(){
  const r=await api('/api/birthdays');
  bdToday=r.today;
  if(!bdCal.year){ const [y,m]=r.date.split('-').map(Number); bdCal={year:y,month:m}; }
  $('#bdDayTitle').textContent = `Сегодня, ${fmtBdShort(r.date)}`;
  $('#bdSummary').innerHTML = r.count
    ? `Именинников: <b>${plural(r.count,'клиент','клиента','клиентов')}</b>`
    : '';
  $('#bdList').innerHTML = r.count
    ? r.items.map(bdRowHtml).join('')
    : '<div class="empty">Сегодня именинников нет. Ближайшие дни рождения — в календаре ниже.</div>';
}

// Строка именинника: только то, что нужно для поздравления — имя, телефон, дата, возраст
// и заметка. Визиты, деньги и история намеренно не дублируются: они на один клик дальше,
// в карточке клиента, а здесь сделали бы список длинным и нечитаемым.
function bdRowHtml(v){
  const br=(v.branches||[]).map(branchTag).join('');
  const turns = v.turns!=null && v.turns>0 && v.turns<120 ? `исполняется ${v.turns}` : '';
  return `<div class="bd-row">
    <div class="bd-who" onclick="openClient(${v.client_id})">
      <span class="ic">${ICON.cake}</span>
      <span class="nm">${v.do_not_call?ICON.ban:''}${v.name||'Без имени'}</span>${br}
      <span class="mt">${[v.phone||'—', fmtBdShort(v.birth_date), turns].filter(Boolean).join(' · ')}</span>
    </div>
    <div class="bd-note ${v.note?'':'blank'}" onclick="openBdNote(${v.client_id},'${q1(v.name)}','${q1(v.note)}')">${
      v.note ? `${esc(v.note)}${v.note_by?` <span class="bd-by">— ${esc(v.note_by)}</span>`:''}` : 'заметка ко дню рождения…'}</div>
  </div>`;
}

async function loadBdayMonth(year,month){
  const r=await api(`/api/birthdays/month?year=${year}&month=${month}`);
  bdCal={year:r.year,month:r.month};
  bdToday=r.today;
  $('#bdMonthSel').value=String(r.month);
  // Год выбирается из небольшого окна вокруг текущего: календарь ДР нужен, чтобы
  // планировать поздравления, а не листать историю.
  const [ty]=r.today.split('-').map(Number);
  $('#bdYearSel').innerHTML=[ty-1,ty,ty+1,ty+2].map(y=>`<option value="${y}">${y}</option>`).join('');
  $('#bdYearSel').value=String(r.year);

  // понедельник — первый столбец: getDay() отдаёт 0 для воскресенья
  const shift=(new Date(r.year,r.month-1,1).getDay()+6)%7;
  const total=Object.values(r.by_day).reduce((s,b)=>s+b.count,0);
  $('#bdMonthSummary').textContent = total
    ? `${plural(total,'именинник','именинника','именинников')} в этом месяце`
    : 'В этом месяце именинников нет';

  const cells=[];
  for(let i=0;i<shift;i++) cells.push('<div class="bd-cell empty"></div>');
  for(let d=1;d<=r.days;d++){
    const iso=`${r.year}-${String(r.month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const b=r.by_day[d];
    const cls=['bd-cell'];
    if(b) cls.push('has');
    if(iso===r.today) cls.push('today');
    if(iso===bdPickDate) cls.push('sel');
    const hint=b?`${b.names.join(', ')}${b.count>b.names.length?` и ещё ${b.count-b.names.length}`:''}`:'';
    cells.push(`<div class="${cls.join(' ')}" onclick="pickBdayDay('${iso}')"${hint?` title="${hint.replace(/"/g,'&quot;')}"`:''}>
      <span class="d">${d}</span>
      ${b?`<span class="c${b.noted?' noted':''}">${b.count}</span>`:''}
    </div>`);
  }
  $('#bdGrid').innerHTML=cells.join('');
}

// Клик по дню календаря — список именинников этого дня ПОД календарём.
async function pickBdayDay(iso){
  bdPickDate=iso;
  const r=await api('/api/birthdays?date='+encodeURIComponent(iso));
  $('#bdPick').style.display='';
  $('#bdPickTitle').textContent = iso===r.today ? `Сегодня, ${fmtBdShort(iso)}` : fmtBd(iso);
  $('#bdPickSummary').innerHTML = r.count
    ? `Именинников: <b>${plural(r.count,'клиент','клиента','клиентов')}</b>`
    : '';
  $('#bdPickList').innerHTML = r.count
    ? r.items.map(bdRowHtml).join('')
    : '<div class="empty">В этот день именинников нет.</div>';
  const [y,m]=iso.split('-').map(Number);
  await loadBdayMonth(y,m);            // перерисовать, чтобы подсветилась выбранная клетка
  $('#bdPick').scrollIntoView({behavior:'smooth',block:'start'});
}
function clearBdayPick(){
  bdPickDate=null;
  $('#bdPick').style.display='none';
  loadBdayMonth(bdCal.year,bdCal.month);
}
function shiftBdMonth(delta){
  let y=bdCal.year, m=bdCal.month+delta;
  if(m<1){m=12;y--;} if(m>12){m=1;y++;}
  loadBdayMonth(y,m);
}
$('#bdPrev').onclick=()=>shiftBdMonth(-1);
$('#bdNext').onclick=()=>shiftBdMonth(1);
$('#bdMonthSel').onchange=e=>loadBdayMonth(bdCal.year,Number(e.target.value));
$('#bdYearSel').onchange=e=>loadBdayMonth(Number(e.target.value),bdCal.month);
$('#bdPickClear').onclick=clearBdayPick;

// --- Окно заметки ко дню рождения ---
let bdNoteFor=null;
function openBdNote(id,name,note){
  bdNoteFor={id,name};
  $('#bdNoteWho').textContent=name||'Клиент';
  $('#bdNoteText').value=note||'';
  $('#bdNoteModal').classList.add('open');
  $('#bdNoteText').focus();
}
function closeBdNote(){ $('#bdNoteModal').classList.remove('open'); bdNoteFor=null; }
$('#bdNoteModal').onclick=e=>{ if(e.target.id==='bdNoteModal') closeBdNote(); };
$('#bdNoteSave').onclick=async ()=>{
  if(!bdNoteFor) return;
  const {id}=bdNoteFor, note=$('#bdNoteText').value.trim();
  const b=$('#bdNoteSave'); b.disabled=true;
  try{
    await api(`/api/birthdays/${id}/note`,{method:'PUT',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({note,admin:currentAdmin()})});
    closeBdNote();
    toast(note?'Заметка сохранена':'Заметка убрана');
    // обновляем то, что сейчас на экране: оба списка ДР и/или открытую карточку клиента
    if(document.querySelector('.tab.active')?.dataset.view==='bday'){
      await loadBdayToday();
      if(bdPickDate) await pickBdayDay(bdPickDate);
      else await loadBdayMonth(bdCal.year,bdCal.month);
    }
    if(drawerClientId===id) renderDrawerBday(id);
  }catch(e){ toast('Не удалось сохранить: '+(e.message||''),'bad'); }
  b.disabled=false;
};

// Строка ДР в шапке карточки клиента: дата, сколько исполнится, заметка. Клик — окно заметки.
// Полоса скрыта, пока дата рождения не приехала из YClients (её тянет фоновый проход).
let drawerBday=null;
async function renderDrawerBday(id){
  const strip=$('#drawerBday');
  drawerBday=null; strip.style.display='none';
  let r;
  try{ r=await api(`/api/birthdays/${id}/note`); }catch{ return; }
  if(drawerClientId!==id) return;           // пока грузилось, открыли другого клиента
  if(!r.birth_date) return;
  drawerBday=r;
  const [by,bm,bd]=r.birth_date.split('-').map(Number);
  const now=new Date();
  const isToday = now.getMonth()+1===bm && now.getDate()===bd;
  let turns=now.getFullYear()-by;
  // ДР в этом году уже прошёл → следующий круглый возраст будет в следующем
  if(now.getMonth()+1>bm || (now.getMonth()+1===bm && now.getDate()>bd)) turns++;
  // года в карточке YClients может не быть — тогда про возраст молчим
  const age = by ? `<span class="ag">${isToday?'исполняется':'исполнится'} ${turns}</span>` : '';
  strip.style.display='';
  strip.innerHTML = `<span class="ic">${ICON.cake}</span>
    <span class="dt">${fmtBdShort(r.birth_date)}${isToday?' — сегодня':''}</span>
    ${age}
    <span class="nt ${r.note?'':'blank'}">${esc(r.note)||'заметки нет — добавить'}</span>`;
}
function openBdNoteFromDrawer(){
  if(!drawerClientId) return;
  openBdNote(drawerClientId, $('#drawerName').textContent, drawerBday?.note||'');
}

// --- ЛЕНТА КЛИЕНТА ---
let drawerClientId=null;
let drawerData=null;   // клиент + статистика + лента открытой карточки (нужны шаблонам)
async function toggleDnc(){
  if(!drawerClientId) return;
  const dt=$('#dncToggle');
  const turnOn = !dt.classList.contains('on');
  dt.disabled=true;
  try{
    await api(`/api/clients/${drawerClientId}/dnc`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({value:turnOn})});
    dt.classList.toggle('on',turnOn);
    dt.innerHTML = ICON.ban + 'Не беспокоить';
    $('#drawerDnc').style.display = turnOn ? '' : 'none';
    toast(turnOn?'Клиент отмечен «не беспокоить»':'Отметка снята');
    if(turnOn) loadTasks(); // задачи по нему сняты
  }catch(e){ toast('Не удалось сохранить'); }
  dt.disabled=false;
}
async function openClient(id){
  const {client:c, stats:s, timeline} = await api(`/api/clients/${id}/timeline`);
  // держим данные открытой карточки: по ним раскрываются подстановки в шаблонах сообщений
  drawerData = {client:c, stats:s, timeline};
  $('#drawerName').textContent = c.name || 'Без имени';

  const sb=$('#drawerStatus');
  sb.textContent = s.status_label;
  sb.className = 'status-badge st-'+s.status;

  // пометка «не беспокоить» + комментарий из карточки YClients (без нашего CRM-лога — он в ленте)
  drawerClientId = c.id;
  $('#drawerDnc').style.display = c.do_not_call ? '' : 'none';
  const cb=$('#drawerComment');
  const ownComment=(c.comment||'').split('——— Обзвон (CRM) ———')[0].trim();
  if(ownComment){cb.textContent=ownComment;cb.className='note-box'+(c.do_not_call?' dnc':'');cb.style.display='';}
  else cb.style.display='none';
  const dt=$('#dncToggle');
  dt.classList.toggle('on', !!c.do_not_call);
  dt.innerHTML = ICON.ban + 'Не беспокоить';
  for(const slug of Object.keys(LIST_UI)) renderListToggle(slug);
  $('#scDrawerBtn').innerHTML = ICON.msg + 'Шаблон';
  renderDrawerBday(c.id);

  // подзаголовок шапки: телефон, филиалы, статус визитов — одной строкой
  $('#drawerSub').innerHTML = [
    c.phone?`<a href="tel:+${String(c.phone).replace(/\D/g,'')}" class="phone">${c.phone}</a>`:'',
    (c.branches&&c.branches.length?c.branches.join(', '):c.branch)||'',
    s.total_visits?`${plural(s.total_visits,'визит','визита','визитов')} · ${rub(realSpentOf(c,s))}`:'',
  ].filter(Boolean).join('<span class="dsep">/</span>');

  // вкладки карточки: лента визитов открыта сразу, статистика и контакты — рядом
  document.querySelectorAll('.dtab').forEach(t=>t.onclick=()=>{
    document.querySelectorAll('.dtab').forEach(x=>x.classList.remove('active'));
    t.classList.add('active');
    document.querySelectorAll('.dpane').forEach(p=>p.classList.toggle('active', p.id==='pane-'+t.dataset.pane));
    $('#drawerBody').scrollTop=0;
  });
  document.querySelectorAll('.dtab').forEach((t,i)=>t.classList.toggle('active',i===0));
  document.querySelectorAll('.dpane').forEach(p=>p.classList.toggle('active',p.id==='pane-visits'));
  $('#drawerBody').scrollTop=0;

  // плитки статистики. Настоящая сумма трат (из YClients, с депозитами) если известна, иначе по визитам
  const realSpent = realSpentOf(c,s);
  const spentLabel = c.yc_spent!=null ? 'Потрачено (с депозитом)' : 'Потрачено';
  // визит = поход в салон; за один поход клиент берёт несколько услуг у разных мастеров
  const tiles = [
    ['Визитов' + (s.services_done>s.total_visits?` · ${s.services_done} услуг`:''), s.total_visits],
    ['Средний чек за визит', rub(s.avg_check)],
    [spentLabel, rub(realSpent)],
    ['Периодичность', s.avg_interval_days?'~'+Math.round(s.avg_interval_days)+' дн.':'—'],
    ['Не пришёл', s.no_show + (s.completion_rate!=null?` · ${s.completion_rate}% доходит`:'')],
    ['Не был', s.since_last_days!=null?s.since_last_days+' дн.':'—'],
  ];
  if(s.goods_spent) tiles.push(['На товары' + (s.goods_items?` · ${plural(s.goods_items,'покупка','покупки','покупок')}`:''), rub(s.goods_spent)]);
  if(c.yc_balance>0) tiles.push(['Остаток депозита', `<span style="color:var(--green)">${rub(c.yc_balance)}</span>`]);
  else if(c.yc_balance<0) tiles.push(['Долг (депозит в минусе)', `<span style="color:var(--red)">${rub(c.yc_balance)}</span>`]);
  $('#statTiles').innerHTML = tiles.map(([l,n])=>`<div class="stile"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');

  // график по месяцам
  const maxM = Math.max(1,...s.months.map(m=>m.count));
  $('#monthChart').innerHTML = s.months.map(m=>`
    <div class="mbar" title="${m.label}: ${m.count}">
      <div class="mc">${m.count||''}</div>
      <div class="bar" style="height:${m.count/maxM*100}%;${m.count?'':'opacity:.25'}"></div>
      <div class="ml">${m.label}</div>
    </div>`).join('');

  // полный список мастеров/услуг, ранжированный по частоте, с долей визитов и полосой.
  // markTop — пометить первого (самого частого) как приоритетного
  const brk = (arr,withSum,markTop)=> arr.length? arr.map((x,i)=>`
    <div class="brk${markTop&&i===0?' top':''}">
      <div class="row1"><span class="nm">${x.name}${markTop&&i===0?' <span class="prio">приоритет</span>':''}</span><span class="v">${x.count}× · <b>${x.pct}%</b>${withSum?' · '+rub(x.sum):''}</span></div>
      <div class="bar"><div style="width:${x.pct}%"></div></div>
    </div>`).join('')
    : '<div class="muted" style="font-size:13px">Нет данных</div>';
  $('#statServices').innerHTML = brk(s.services,true,false);
  $('#statMasters').innerHTML = brk(s.masters,false,true);
  $('#cntServices').textContent = s.services.length||'';
  $('#cntMasters').textContent = s.masters.length? `${s.masters.length}${s.masters[0]&&s.masters[0].name!=='—'?' · '+s.masters[0].name:''}` : '';

  // товары: доля считается от денег, а не от числа покупок — админу важнее «на чём он тратит».
  // Дата последней покупки нужна, чтобы предложить расходник вовремя (шампунь кончился).
  const goods = s.goods||[];
  $('#statGoods').innerHTML = goods.length? goods.map(x=>`
    <div class="brk">
      <div class="row1"><span class="nm">${x.name}</span><span class="v">${x.count}× · <b>${rub(x.sum)}</b></span></div>
      <div class="bar"><div style="width:${x.pct}%"></div></div>
      <div class="gdate">последняя покупка: ${fmtDate(x.last)}</div>
    </div>`).join('')
    : '<div class="muted" style="font-size:13px">Товаров не покупал</div>';
  $('#cntGoods').textContent = goods.length? `${goods.length} · ${rub(s.goods_spent)}` : '';

  const topMaster = s.masters[0] && s.masters[0].name!=='—' ? `${s.masters[0].name} · ${s.masters[0].pct}%` : (c.favorite_staff||'—');
  $('#drawerInfo').innerHTML = [
    ['Приоритетный мастер', topMaster],
    ['Телефон', c.phone?`<a href="tel:+${String(c.phone).replace(/\D/g,'')}">${c.phone}</a>`:'—'],
    ['Филиал', (c.branches&&c.branches.length?c.branches.join(', '):c.branch)||'—'],
    ['Последний визит', daysAgoTxt(s.last_visit)],
    ['Прогноз следующего', fmtDate(s.predicted_next)],
    ['Персональная скидка', c.discount_pct ? `−${c.discount_pct}%` : '—'],
  ].map(([k,v])=>`<div><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');

  const STAT={completed:'выполнен',upcoming:'предстоит',no_show:'не пришёл',cancelled:'отменён',unmarked:'не отмечен в YClients'};

  // Один поход в салон = один блок. За визит клиент берёт несколько услуг у разных
  // мастеров, и каждая приезжает из YClients отдельной записью — раньше они шли
  // подряд, каждая со своей датой, и выглядели как четыре визита в один день.
  const dayOf = d => new Date(d).toLocaleDateString('sv-SE',{timeZone:'Europe/Moscow'});
  const fmtDay = d => new Date(d).toLocaleDateString('ru-RU',{day:'numeric',month:'long',year:'2-digit'});
  const fmtTime = d => new Date(d).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
  const groups=[], byKey=new Map();
  for(const e of timeline){
    if(e.kind!=='visit'){ groups.push({kind:e.kind,date:e.date,ev:e}); continue; }
    const key=dayOf(e.date)+'|'+(e.status||'')+'|'+(e.branch||'');
    let g=byKey.get(key);
    if(!g){ g={kind:'day',date:e.date,status:e.status,branch:e.branch,items:[],sum:0}; byKey.set(key,g); groups.push(g); }
    g.items.push(e); g.sum+=e.cost||0;
    if(new Date(e.date)<new Date(g.date)) g.date=e.date;   // начало похода
  }
  groups.sort((a,b)=>new Date(b.date)-new Date(a.date));
  const trips=groups.filter(g=>g.kind==='day').length;

  $('#timeline').innerHTML = groups.map(g=>{
    if(g.kind==='day'){
      const rows=g.items.map(i=>`<div class="vrow">
          <span class="vn">${i.title}</span>
          <span class="vm">${i.staff||''}</span>
          <span class="vc">${i.cost?rub(i.cost):''}</span>
        </div>`).join('');
      return `<div class="ev visit">
        <div class="d">${fmtDay(g.date)}, ${fmtTime(g.date)}${g.branch?' · '+g.branch:''}${
          g.status!=='completed'?`<span class="pill">${STAT[g.status]||g.status}</span>`:''}</div>
        <div class="vsvc">${rows}</div>
        <div class="vsum">${g.items.length>1?plural(g.items.length,'услуга','услуги','услуг')+' · ':''}${rub(g.sum)}</div>
      </div>`;
    }
    const e=g.ev;
    if(g.kind==='call'){const R={booked:'записал',callback:'перезвонить',no_answer:'не ответил',refused:'отказ',no_calls:'просил не звонить',coming:'придёт'};
      return `<div class="ev call"><div class="d">${fmtDT(e.date)} · ${e.admin||''}</div><div class="t">Звонок${e.result?` — ${R[e.result]||e.result}`:''}</div>${e.note?`<div class="s">«${e.note}»</div>`:''}</div>`;}
    return `<div class="ev task"><div class="d">${fmtDT(e.date)}</div><div class="t">Задача: ${e.type_label} <span class="pill">${e.status}</span></div><div class="s">${e.reason||''}</div></div>`;
  }).join('') || '<div class="muted">Событий пока нет</div>';
  $('#cntTimeline').textContent = trips||'';

  $('#overlay').classList.add('open');$('#drawer').classList.add('open');
}
function closeDrawer(){$('#overlay').classList.remove('open');$('#drawer').classList.remove('open');}
$('#overlay').onclick=closeDrawer;

// --- ВЫБОРКИ ---
let segLoaded=false, segResults=[], segFilter={}, segServices=[];
const segExcluded=new Set();   // строки, вычеркнутые админом прямо в таблице выборки
async function loadSegments(){
  if(segLoaded) return; segLoaded=true;
  const [svcs,cats,goods] = await Promise.all([
    api(bp('/api/services-list')), api(bp('/api/service-categories')), api(bp('/api/goods-list')),
  ]);
  segServices = svcs;
  // Группы услуг = категории прайса YClients. Вложенности в YClients нет — список плоский.
  $('#segCategory').innerHTML = '<option value="">Все группы</option>' + cats.map(c=>
    `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
  renderServiceOptions();
  // Товар — комбобокс: можно выбрать из фактически проданных, а можно вписать часть
  // названия руками (сервер ищет по LIKE). В datalist value = чистое название, детали в label.
  $('#segGoodList').innerHTML = goods.map(g=>
    `<option value="${esc(g.title)}" label="${esc(g.purchases)}× · ${esc(g.clients)} клиентов"></option>`).join('');
}
// Услуги в выпадающем списке разложены по категориям прайса YClients — как в самом
// YClients. Выбранная группа сужает список до своих услуг, «Прочее» — то, чего в прайсе нет.
function renderServiceOptions(){
  const cat = $('#segCategory')?.value || '';
  const list = cat ? segServices.filter(s=>(s.category||'')===cat) : segServices;
  const byCat = new Map();
  for(const s of list){
    const k = s.category || 'Прочее (нет в прайсе)';
    if(!byCat.has(k)) byCat.set(k,[]);
    byCat.get(k).push(s.name);
  }
  const groups=[...byCat.entries()].sort((a,b)=>a[0].localeCompare(b[0],'ru'));
  $('#segService').innerHTML = '<option value="">Все услуги</option>' + groups.map(([g,names])=>
    `<optgroup label="${esc(g)}">` +
    names.sort((a,b)=>a.localeCompare(b,'ru')).map(n=>`<option value="${esc(n)}">${esc(n)}</option>`).join('') +
    '</optgroup>').join('');
}
// Ручной полный проход по карточкам YClients. Инкрементальный идёт сам после каждого
// ночного синка — эта кнопка нужна, чтобы обновить разом всех, включая давно не заходивших.
async function syncComments(){
  const st=await api('/api/sync-comments/status');
  if(st.running){toast(`Уже идёт: проверено ${st.done} из ${st.total}`);return;}
  if(!confirm('Подтянуть комментарии, суммы и скидки из карточек всех клиентов YClients? Идёт в фоне, займёт до получаса.')) return;
  await api('/api/sync-comments?full=1',{method:'POST'});
  toast('Запущено в фоне — данные подтянутся постепенно');
}
let segPresetNew=false;
function currentFilter(){
  const f={};
  if(segPresetNew) f.preset='new';
  const cat=$('#segCategory').value.trim(); if(cat)f.category=cat;
  const service=$('#segService').value.trim(); if(service)f.service=service;
  const good=$('#segGood').value.trim(); if(good)f.good=good;
  const staff=$('#segStaff').value.trim(); if(staff)f.staff=staff;
  const from=$('#segFrom').value; if(from)f.from=from;
  const to=$('#segTo').value; if(to)f.to=to;
  const mv=$('#segMinVisits').value; if(mv&&mv!=='1')f.min_visits=mv;
  const sf=$('#segSpentFrom').value; if(sf&&Number(sf)>0)f.spent_from=sf;
  const st=$('#segSpentTo').value; if(st&&Number(st)>0)f.spent_to=st;
  const cm=$('#segComment').value.trim(); if(cm)f.comment=cm;
  const dnc=$('#segDnc').value; if(dnc)f.dnc=dnc;
  const dep=$('#segDeposit').value; if(dep)f.deposit=dep;
  const dsc=$('#segDiscount').value; if(dsc)f.discount=dsc;
  const dscf=$('#segDiscountFrom').value; if(dscf&&Number(dscf)>0)f.discount_from=dscf;
  if(currentBranch) f.branch=currentBranch;
  return f;
}
function filterLabel(f){
  if(f.preset==='new') return 'NEW — первички (NPS)';
  const parts=[];
  if(f.category)parts.push('группа «'+f.category+'»');
  if(f.service)parts.push('«'+f.service+'»');
  if(f.good)parts.push('товар «'+f.good+'»');
  if(f.staff)parts.push('мастер '+f.staff);
  if(f.from||f.to)parts.push(`${f.from||'…'}–${f.to||'…'}`);
  if(f.min_visits)parts.push('визитов≥'+f.min_visits);
  if(f.spent_from||f.spent_to)parts.push(`траты ${f.spent_from?rub(f.spent_from):'…'}–${f.spent_to?rub(f.spent_to):'…'}`);
  if(f.comment)parts.push('коммент «'+f.comment+'»');
  if(f.dnc==='only')parts.push('не беспокоить');
  if(f.deposit==='only')parts.push('депозитники');
  if(f.discount==='any')parts.push('со скидкой');
  if(f.discount==='none')parts.push('без скидки');
  if(f.discount_from)parts.push('скидка от '+f.discount_from+'%');
  return parts.join(', ')||'Все клиенты';
}
let segReq=0;
async function runSegment(){
  segFilter=currentFilter();
  const myReq=++segReq; // при автопоиске запросы идут часто — рисуем только ответ на последний
  const b=$('#segRun');b.textContent='Ищу…';b.disabled=true;
  const r = await api('/api/segments?'+new URLSearchParams(segFilter).toString());
  if(myReq!==segReq) return; // пришёл устаревший ответ — игнорируем
  b.textContent='Показать';b.disabled=false;
  segResults=r.clients;
  segExcluded.clear();               // новая выборка — вычеркнутые строки сбрасываем
  renderSegSummary();
  const tb=$('#segTable tbody');
  // одна строка = один человек: карточки филиалов склеены, суммы сложены
  tb.innerHTML = r.clients.map(c=>{
    const br=(c.branches&&c.branches.length>1)?c.branches.map(branchTag).join(''):branchTag(c.branch);
    return `<tr class="crow" onclick="openClient(${c.id})">
      <td title="${(c.comment||'').replace(/"/g,'&quot;')}">${c.do_not_call?ICON.ban:''}${c.name||'—'}${br}${listTags(c.lists)}${discTag(c.discount)}${depTag(c.deposit_balance)}</td>
      <td class="phone">${c.phone||'—'}</td>
      <td><b>${c.match_visits}</b></td>
      <td>${c.total_visits||0}</td>
      <td><b>${rub(c.real_spent)}</b></td>
      <td>${rub(c.match_spent)}</td>
      <td title="Покупки товаров${segFilter.good?' по фильтру «'+segFilter.good+'»':''}">${c.goods_count?`${c.goods_count}× · ${rub(c.goods_spent)}`:'—'}</td>
      <td>${fmtDate(c.last_match)}</td>
      <td class="muted" style="font-size:12px">${(c.masters||'').split(',').slice(0,3).join(', ')}</td>
      <td class="tdadd">${addBtn(c.id)}${callsBtn(c.id,c.name)}</td>
      <td class="tdx"><button class="row-x" title="Вычеркнуть из выборки"
        onclick="event.stopPropagation();segExclude(${c.id})">✕</button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="11" class="empty">Ничего не найдено под эти условия</td></tr>';
}
// Вычеркнуть человека из выборки перед созданием списка: фильтр может зацепить лишнего,
// а переписывать условия ради одного клиента долго. В список такие строки не попадут.
function segExclude(id){
  segExcluded.add(Number(id));
  const tb=$('#segTable tbody');
  [...tb.querySelectorAll('tr.crow')].forEach(tr=>{
    if(tr.getAttribute('onclick')===`openClient(${id})`) tr.remove();
  });
  renderSegSummary();
}
// Сводка считается по ОСТАВШИМСЯ строкам — иначе после вычёркивания цифры врали бы
function renderSegSummary(){
  const rows=segResults.filter(c=>!segExcluded.has(Number(c.id)));
  const sum=(f)=>rows.reduce((s,c)=>s+(Number(c[f])||0),0);
  const cut = segExcluded.size ? ` <span style="color:var(--muted)">· вычеркнуто ${segExcluded.size}</span>` : '';
  $('#segSummary').innerHTML = (segPresetNew
    ? `Первичек к обзвону: <b>${rows.length}</b> · принесли ${rub(sum('real_spent'))}`
    : `Найдено: <b>${plural(rows.length,'клиент','клиента','клиентов')}</b> · ${sum('match_visits')} совпадающих визитов · `
      + `по выборке ${rub(sum('match_spent'))} · всего потратили ${rub(sum('real_spent'))}`
      + (rows.filter(c=>!Number(c.real_spent)).length
          ? ` <span style="color:var(--amber)">· у ${rows.filter(c=>!Number(c.real_spent)).length} суммы нет в базе</span>`:'')
    ) + cut;
  $('#segToList').disabled = rows.length===0;
}
async function createListFromFilter(){
  if(segResults.length===segExcluded.size) return;
  const suggested='Обзвон: '+filterLabel(segFilter);
  const name=prompt('Название списка для обзвона:', suggested);
  if(!name) return;
  const assignee=prompt('Ответственный администратор (пусто — без ответственного):', currentAdmin()||'');
  if(assignee===null) return;
  try{
    const r=await api('/api/lists',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({name,filter:segFilter,assignee,exclude_ids:[...segExcluded]})});
    toast(`Список «${name}» создан: ${r.members} клиентов${assignee.trim()?' · отв. '+assignee.trim():''}`);
    document.querySelector('[data-view="calls"]').click();
  }catch(e){toast('Не удалось создать список: '+(e.message||''),'bad');}
}
// --- Точечная сборка списка -------------------------------------------------
// Фильтры конструктора отвечают на «кого позвать по признаку», а этот блок — на
// «позвать вот этих конкретных». Клиенты копятся чипами и уходят одним списком.
const manPicked=new Map();
let manTimer;
$('#manSearch').oninput=e=>{clearTimeout(manTimer);manTimer=setTimeout(()=>manSuggest(e.target.value),250);};
async function manSuggest(q){
  const box=$('#manSuggest');
  if(!q.trim()){box.classList.remove('open');box.innerHTML='';return;}
  const list=await api('/api/client-search?q='+encodeURIComponent(q));
  box.classList.add('open');
  box.innerHTML = list.length ? list.map(c=>{
    const on=manPicked.has(c.id);
    return `<div class="vip-sug ${on?'added':''}" ${on?'':`onclick="manAdd(${c.id},'${q1(c.name)}','${q1(c.phone||'')}')"`}>
      <div>
        <div class="nm">${c.do_not_call?ICON.ban:''}${c.name||'Без имени'}${(c.branches||[]).map(branchTag).join('')}${discTag(c.discount)}</div>
        <div class="mt">${c.phone||'—'} · ${c.visits} визитов · последний ${fmtDate(c.last_visit)}${on?' · уже выбран':''}</div>
      </div>
      <div class="sp">${rub(c.spent)}</div>
    </div>`;
  }).join('') : '<div class="vip-sug" style="cursor:default"><div class="mt">Никого не найдено</div></div>';
}
function manAdd(id,name,phone){
  manPicked.set(id,{name,phone});
  $('#manSearch').value='';$('#manSuggest').classList.remove('open');
  renderManChips();
}
function manRemove(id){manPicked.delete(id);renderManChips();}
function renderManChips(){
  const box=$('#manChips');
  box.innerHTML=[...manPicked.entries()].map(([id,c])=>
    `<span class="man-chip">${c.name||'Без имени'}${c.phone?`<span class="sub">${c.phone}</span>`:''}
      <span class="x" onclick="manRemove(${id})" title="Убрать">✕</span></span>`).join('');
  $('#manActs').style.display = manPicked.size ? 'flex' : 'none';
  $('#manSummary').textContent = manPicked.size ? `Выбрано: ${plural(manPicked.size,'клиент','клиента','клиентов')}` : '';
}
$('#manClear').onclick=()=>{manPicked.clear();renderManChips();};
$('#manToList').onclick=async()=>{
  if(!manPicked.size) return;
  const name=prompt('Название списка для обзвона:','Точечный обзвон');
  if(!name) return;
  const assignee=prompt('Ответственный администратор (пусто — без ответственного):', currentAdmin()||'');
  if(assignee===null) return;
  try{
    const r=await api('/api/lists',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({name,assignee,client_ids:[...manPicked.keys()]})});
    toast(`Список «${name}» создан: ${r.members} клиентов`);
    manPicked.clear();renderManChips();
    document.querySelector('[data-view="calls"]').click();
  }catch(e){toast('Не удалось создать список: '+(e.message||''),'bad');}
};

$('#segRun').onclick=runSegment;
$('#segToList').onclick=createListFromFilter;
// NEW — готовый пресет первичек для NPS-обзвона. Остальные фильтры продолжают работать
// поверх него (можно сузить филиалом, услугой или периодом первого визита).
$('#segNew').onclick=()=>{
  segPresetNew=!segPresetNew;
  $('#segNew').classList.toggle('on',segPresetNew);
  $('#segNewHint').classList.toggle('on',segPresetNew);
  clearTimeout(segTimer); runSegment();
};
// Автопоиск при вводе любого критерия (с задержкой), чтобы список появлялся сразу
let segTimer;
const segAuto=()=>{clearTimeout(segTimer);segTimer=setTimeout(runSegment,350);};
['segStaff','segFrom','segTo','segMinVisits','segSpentFrom','segSpentTo','segDiscountFrom','segComment','segGood'].forEach(id=>$('#'+id).addEventListener('input',segAuto));
['segFrom','segTo','segDnc','segDeposit','segDiscount','segService','segGood'].forEach(id=>$('#'+id).addEventListener('change',segAuto));
// Группа услуг заодно сужает подсказки в поле «Услуга содержит»
$('#segCategory').addEventListener('change',()=>{renderServiceOptions();segAuto();});
$('#segReset').onclick=()=>{clearTimeout(segTimer);['segService','segStaff','segFrom','segTo','segComment','segDnc','segDeposit','segSpentFrom','segSpentTo','segDiscount','segDiscountFrom','segCategory','segGood'].forEach(id=>$('#'+id).value='');$('#segMinVisits').value='1';segPresetNew=false;$('#segNew').classList.remove('on');$('#segNewHint').classList.remove('on');$('#segSummary').textContent='';$('#segTable tbody').innerHTML='';$('#segToList').disabled=true;segResults=[];segExcluded.clear();renderServiceOptions();};

// --- Обновление ---
// Дёргаем ТОЛЬКО будущие записи (окно «сегодня → +180 дн», 3-6 секунд). Нужно, когда
// админ записал клиента прямо в YClients и хочет сразу убрать его из задач, не дожидаясь
// получасового крона. Полный синк (12 мес. истории, минуты, сводка в Telegram) остаётся
// за кроном в 08:00 — из интерфейса его больше не запустить случайно.
$('#syncBtn').onclick = async ()=>{
  const b=$('#syncBtn');b.textContent='Обновляю…';b.disabled=true;
  try{
    const r=await api('/api/sync-upcoming',{method:'POST'});
    if(r.skipped) toast('Демо-режим: обновлять нечего');
    else toast(`Обновлено: ${r.visits} записей${r.cancelled?`, отменено ${r.cancelled}`:''}`);
  }
  catch(e){toast('Не удалось обновить: '+(e.message||''),'bad');}
  b.textContent='Обновить';b.disabled=false;
  loadTasks();
};

// --- Запись к мастеру: события формы (каждый шаг подгружает следующий) ---
// Поля салона/мастера/услуги/даты живут внутри строк записи — обработчики вешаются в addBookRow()
$('#bookAdd').onclick = () => addBookRow();
$('#bookSubmit').onclick = submitBooking;
$('#bookJustMark').onclick = e=>{ e.preventDefault(); bookJustMark(); };
$('#bookModal').onclick = e=>{ if(e.target.id==='bookModal') closeBooking(); };

// --- Администраторы: события ---
$('#adminSel').onchange = ()=>{ localStorage.setItem('admin_name', $('#adminSel').value); };
$('#adminManage').onclick = openAdminModal;
$('#adminModal').onclick = e=>{ if(e.target.id==='adminModal') closeAdminModal(); };
$('#adminAdd').onclick = addAdmin;
$('#admLoadYc').onclick = loadYcAdmins;
$('#admImport').onclick = importYcAdmins;
$('#adminNewName').onkeydown = e=>{ if(e.key==='Enter'){ e.preventDefault(); addAdmin(); } };

// Старт
loadAdmins();
loadBranches();
// нужны listIds, чтобы кнопки ручных списков в карточке клиента знали своё состояние
for(const slug of Object.keys(LIST_UI)) loadList(slug);
loadTasks();
