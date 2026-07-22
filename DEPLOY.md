# Деплой на Timeweb VPS (Cloud Server)

Пошагово. Все команды выполняются на сервере под root, если не указано иное.
Данные (звонки, списки, задачи) лежат в SQLite на диске сервера и переживают перезапуски и обновления кода.

---

## 1. Создать сервер на Timeweb

Панель Timeweb → **Облачные серверы** → Создать:
- ОС: **Ubuntu 24.04**
- Конфигурация: минимальная (1 vCPU, 1–2 ГБ RAM) — приложению хватает
- Записать **публичный IP** и root-пароль

Подключиться: `ssh root@ВАШ_IP`

## 2. Базовая подготовка + Node.js 22

```bash
apt update && apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs git
node -v    # должно быть v22+ (нужно для встроенного node:sqlite)
```

## 3. Пользователь и код

```bash
adduser --system --group --home /opt/yclients-crm crm
cd /opt
git clone https://github.com/AntonKrouk/yclients-crm.git
# репозиторий приватный → Git спросит логин GitHub и токен (Personal Access Token,
# создать: github.com/settings/tokens, права repo). Пароль от аккаунта не подойдёт.
chown -R crm:crm /opt/yclients-crm
cd /opt/yclients-crm
sudo -u crm npm ci --omit=dev
```

## 4. Файл .env с секретами

```bash
sudo -u crm nano /opt/yclients-crm/.env
```

Вставить (значения YCLIENTS_* взять из своего локального .env; пароли придумать):

```
YCLIENTS_PARTNER_TOKEN=...ваш партнёрский токен...
YCLIENTS_USER_TOKEN=...ваш user token...
YCLIENTS_COMPANY_ID=387958

# Вход в дашборд — ОБЯЗАТЕЛЬНО задать надёжный пароль
DASHBOARD_PASSWORD=придумайте-надёжный-пароль
SESSION_SECRET=длинная-случайная-строка
CRON_SECRET=ещё-одна-случайная-строка

PORT=3020
DATA_DIR=/opt/yclients-crm/data
PUBLIC_URL=https://crm.babochka.com
```

Сгенерировать случайные строки: `openssl rand -hex 24`

## 5. Автозапуск через systemd

```bash
cp /opt/yclients-crm/deploy/yclients-crm.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now yclients-crm
systemctl status yclients-crm      # active (running)
journalctl -u yclients-crm -f      # логи в реальном времени (Ctrl+C выйти)
```

При первом старте приложение подтянет клиентов и визиты из YClients (в логах увидите `[bootstrap] ... clients ...`).

## 6. Доступ снаружи

### Быстрая проверка (по IP)
```bash
ufw allow 3020/tcp   # если включён фаервол
```
Открыть `http://ВАШ_IP:3020` → появится страница входа.

### Правильно: домен + HTTPS (рекомендуется)
1. Направить A-запись поддомена (напр. `crm.babochka.com`) на IP сервера.
2. Поставить nginx и сертификат:
```bash
apt install -y nginx certbot python3-certbot-nginx
cp /opt/yclients-crm/deploy/nginx.conf.example /etc/nginx/sites-available/yclients-crm
# в файле заменить server_name на свой домен:
nano /etc/nginx/sites-available/yclients-crm
ln -s /etc/nginx/sites-available/yclients-crm /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d crm.babochka.com     # выпустит HTTPS автоматически
ufw allow 'Nginx Full'; ufw delete allow 3020/tcp   # закрыть прямой порт
```
Готово: `https://crm.babochka.com` — открывается без VPN, с HTTPS и входом по паролю.

## 7. Авто-синхронизация по расписанию (cron)

Раз в сутки в 7:00 обновлять данные из YClients и слать сводку в Telegram:
```bash
crontab -e
```
Добавить (подставить свой CRON_SECRET):
```
0 7 * * * curl -s -X POST "http://127.0.0.1:3020/api/sync?token=ВАШ_CRON_SECRET" >/dev/null
```

## 8. Обновление приложения (после доработок)

Когда я запушу правки в GitHub:
```bash
cd /opt/yclients-crm
sudo -u crm git pull
sudo -u crm npm ci --omit=dev     # если менялись зависимости
systemctl restart yclients-crm
```
Данные (звонки, списки, задачи) сохраняются — они в `data/`, git их не трогает.

---

### Что где лежит
- Код: `/opt/yclients-crm`
- База (важно, бэкапить): `/opt/yclients-crm/data/crm.db`
- Логи: `journalctl -u yclients-crm`
- Настройки/секреты: `/opt/yclients-crm/.env`

### Бэкап базы (рекомендуется, cron раз в день)
```
30 3 * * * cp /opt/yclients-crm/data/crm.db /opt/yclients-crm/data/backup-$(date +\%F).db
```
