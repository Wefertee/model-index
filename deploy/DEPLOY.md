# Деплой на Ubuntu 24.04 по IP

Репозиторий: **https://github.com/Wefertee/model-index** (ветка `main`).

Node сам отдаёт статику и принимает форму, домен и nginx не нужны: служба слушает порт 80,
сайт открывается по `http://IP/`.

Все команды ниже — на сервере, от пользователя с `sudo`.

## 1. Node 22

В Ubuntu 24.04 в apt лежит Node 18, а серверу нужен 22.5+ (встроенный `node:sqlite`):

```bash
sudo apt update
sudo apt install -y git curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v        # ждём v22.x
```

## 2. Клон

```bash
sudo useradd --system --home /opt/model-index --shell /usr/sbin/nologin modelindex
sudo mkdir -p /opt/model-index

sudo git clone https://github.com/Wefertee/model-index.git /opt/model-index
sudo chown -R modelindex:modelindex /opt/model-index
```

Репозиторий публичный, поэтому на сервере не нужны ни ключи, ни токены.
`feedback.db` в `.gitignore` — сообщения живут только на сервере и в git не попадают.

## 3. Служба

```bash
sudo cp /opt/model-index/deploy/model-index.service /etc/systemd/system/model-index.service
sudo systemctl daemon-reload
sudo systemctl enable --now model-index
systemctl status model-index --no-pager
```

В юните важны три строки:

```ini
Environment=HOST=0.0.0.0
Environment=PORT=80
AmbientCapabilities=CAP_NET_BIND_SERVICE
```

`0.0.0.0` — иначе сервер слушает только `127.0.0.1` и снаружи не виден.
`CAP_NET_BIND_SERVICE` — разрешает службе под обычным пользователем занять порт 80.

## 4. Порт

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw enable
```

И отдельно — 80 в файрволе/security group панели провайдера. Это самая частая причина
«на сервере curl работает, снаружи нет».

## 5. Проверка

```bash
curl -I http://127.0.0.1/
curl -s -X POST http://127.0.0.1/api/feedback \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","message":"проверка с сервера"}'
```

Ждём `HTTP/1.1 200 OK` и `{"ok":true,"id":1}`.
Дальше в браузере: `http://IP/` → футер → «форма обратной связи».

## 6. Обновление после правок

С локальной машины:

```bash
git push
```

На сервере:

```bash
sudo -u modelindex git -C /opt/model-index pull
sudo systemctl restart model-index
```

Перезапускать нужно только из-за `server.js`; после правки одного `index.html` достаточно
`git pull` — сервер отдаёт файл без кэша, хватит обновить страницу.
Если хочешь одной командой, добавь на сервере алиас:

```bash
printf '#!/bin/sh\nsudo -u modelindex git -C /opt/model-index pull && sudo systemctl restart model-index\n' \
  | sudo tee /usr/local/bin/deploy-model-index >/dev/null
sudo chmod +x /usr/local/bin/deploy-model-index
```

Дальше обновление — просто `sudo deploy-model-index`.

## 7. База и логи

```bash
sudo apt install -y sqlite3
sudo sqlite3 /opt/model-index/feedback.db "select id, created_at, email, message from feedback order by id desc"

journalctl -u model-index -n 50 --no-pager   # последние строки
journalctl -u model-index -f                 # следить вживую
```

Резервная копия — это просто файл:

```bash
sudo cp /opt/model-index/feedback.db ~/feedback-$(date +%F).db
```

---

## Если что-то не открывается

| симптом | причина |
|---|---|
| `curl 127.0.0.1` на сервере работает, снаружи нет | закрыт порт 80 (ufw или панель провайдера) |
| `EADDRINUSE` в логах | порт занят, обычно `apache2`/`nginx` из образа: `sudo ss -lptn 'sport = :80'` |
| `Permission denied` при старте службы | нет `AmbientCapabilities=CAP_NET_BIND_SERVICE` |
| страница пустая / 404 | служба смотрит не туда: проверь `WorkingDirectory=/opt/model-index` |
| форма отвечает «не отправилось» | служба упала: `journalctl -u model-index -n 20 --no-pager` |
| `git pull` просит пароль | клонировали по HTTPS с чужого аккаунта — репозиторий публичный, `git remote set-url origin https://github.com/Wefertee/model-index.git` |

## Когда появится домен

HTTPS — обратный прокси, порт 80 освобождается, служба переводится на `PORT=8123`:

```bash
sudo apt install -y caddy
# /etc/caddy/Caddyfile:
#   example.com {
#       reverse_proxy 127.0.0.1:8123
#   }
```
