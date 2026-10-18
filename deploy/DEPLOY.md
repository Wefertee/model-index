# Хостинг на Ubuntu 24.04 без домена (http://IP)

Сайт — это папка из двух файлов (`index.html`, `server.js`) и одного сервиса.
Node сам отдаёт статику и принимает форму, поэтому nginx не нужен: служба слушает порт 80
и открывается по адресу `http://ВАШ_IP/`.

Всё ниже — от пользователя с `sudo`.

---

## 1. Node 22

В Ubuntu 24.04 в репозитории лежит Node 18, а серверу нужен 22.5+ (встроенный `node:sqlite`).
Ставим LTS от NodeSource:

```bash
sudo apt update
sudo apt install -y curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v        # ждём v22.x
```

Проверить, что SQLite на месте:

```bash
node -e "new (require('node:sqlite').DatabaseSync)(':memory:'); console.log('sqlite ok')"
```

## 2. Отдельный пользователь и каталог

Сервис не должен работать от root.

```bash
sudo useradd --system --home /opt/model-index --shell /usr/sbin/nologin modelindex
sudo mkdir -p /opt/model-index
```

## 3. Закинуть файлы

Со своей машины (Windows, PowerShell или Git Bash, из папки проекта):

```bash
scp index.html server.js root@ВАШ_IP:/opt/model-index/
```

Без scp — можно через редактор на сервере (`sudo -u modelindex nano /opt/model-index/server.js`),
но тогда файлы надо вставить целиком.

Права:

```bash
sudo chown -R modelindex:modelindex /opt/model-index
sudo chmod 750 /opt/model-index
```

## 4. Служба systemd

Скопируйте `deploy/model-index.service` на сервер:

```bash
scp deploy/model-index.service root@ВАШ_IP:/tmp/
sudo mv /tmp/model-index.service /etc/systemd/system/model-index.service
```

Либо создайте вручную `sudo nano /etc/systemd/system/model-index.service` и вставьте содержимое файла.

Ключевое место — порт 80 без root:

```ini
Environment=HOST=0.0.0.0
Environment=PORT=80
AmbientCapabilities=CAP_NET_BIND_SERVICE
```

`HOST=0.0.0.0` обязателен: по умолчанию сервер слушает только 127.0.0.1 и снаружи недоступен.

Запуск:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now model-index
systemctl status model-index --no-pager
```

В статусе должно быть `active (running)`, в логах — строка
`Model Index: http://0.0.0.0:80 · хранилище: /opt/model-index/feedback.db`.

## 5. Фаервол

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw enable
sudo ufw status
```

Если у провайдера есть свой файрвол/security group в панели — там тоже надо открыть 80.
Это самая частая причина «сервис работает, а сайт не открывается».

## 6. Проверка

```bash
curl -I http://127.0.0.1/
curl -s -X POST http://127.0.0.1/api/feedback \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","message":"проверка с сервера"}'
```

Ожидаемо: `HTTP/1.1 200 OK` и `{"ok":true,"id":1}`.
Дальше — в браузере: `http://ВАШ_IP/` → футер → «форма обратной связи» → отправить.

## 7. Смотреть сообщения

```bash
sudo apt install -y sqlite3
sudo sqlite3 /opt/model-index/feedback.db "select id, created_at, email, message from feedback order by id desc"
```

Или тем же Node:

```bash
sudo -u modelindex node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/opt/model-index/feedback.db');console.table(d.prepare('select id,created_at,email,substr(message,1,50) m from feedback order by id desc').all())"
```

## 8. Обновить сайт после правок

```bash
scp index.html root@ВАШ_IP:/opt/model-index/
ssh root@ВАШ_IP 'chown modelindex:modelindex /opt/model-index/index.html && systemctl restart model-index'
```

Перезапуск нужен только из-за `server.js`; для правок одного `index.html` достаточно
перезалить файл и обновить страницу в браузере (сервер отдаёт без кэша).

## 9. Логи

```bash
journalctl -u model-index -n 50 --no-pager     # последние строки
journalctl -u model-index -f                   # следить вживую
```

---

## Если что-то не открывается

| симптом | причина |
|---|---|
| `curl 127.0.0.1` работает, снаружи нет | не открыт порт 80 (ufw или файрвол провайдера) |
| `EADDRINUSE` в логах | порт занят, обычно это `apache2`/`nginx` из образа — `sudo ss -lptn 'sport = :80'` и остановить лишнее |
| `Permission denied` при старте | забыли `AmbientCapabilities=CAP_NET_BIND_SERVICE` |
| 502/пустая страница | `WorkingDirectory` не `/opt/model-index` — сервер не нашёл `index.html` |
| форма отвечает «не отправилось» | сервис упал: `journalctl -u model-index -n 20` |

## Позже, когда появится домен

Обратный прокси и HTTPS добавляются одним пакетом Caddy (порт 80 на это время
освобождается, сервис переводится на `PORT=8123`):

```bash
sudo apt install -y caddy
# /etc/caddy/Caddyfile:
#   example.com {
#       reverse_proxy 127.0.0.1:8123
#   }
```

До этого момента сайт живёт по `http://IP` — без сертификата, это нормально.
