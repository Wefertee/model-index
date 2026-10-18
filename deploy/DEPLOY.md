# Хостинг на Ubuntu 24.04 без домена (http://IP), выкладка через git

Схема:

```
локально: git commit → git push deploy main
                            ↓ ssh
сервер: /srv/git/model-index.git (bare) → хук post-receive
                            ↓
        /opt/model-index (рабочая копия) → systemctl restart model-index
                            ↓
        http://IP/  — сайт и форма на одном порту
```

Ниже всё — от пользователя с `sudo`, если не сказано иное.

---

## 1. Node 22

В Ubuntu 24.04 в apt лежит Node 18, а серверу нужен 22.5+ (встроенный `node:sqlite`):

```bash
sudo apt update
sudo apt install -y curl ca-certificates git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v        # ждём v22.x
node -e "new (require('node:sqlite').DatabaseSync)(':memory:'); console.log('sqlite ok')"
```

## 2. Пользователь и каталог

Сервис не работает от root:

```bash
sudo useradd --system --home /opt/model-index --shell /usr/sbin/nologin modelindex
sudo mkdir -p /opt/model-index
```

## 3. Пустой репозиторий на сервере

```bash
sudo mkdir -p /srv/git
sudo git init --bare --initial-branch=main /srv/git/model-index.git
sudo chown -R modelindex:modelindex /srv/git/model-index.git
```

Это «склад» без файлов: сюда приходит `push`, а хук раскладывает содержимое в `/opt/model-index`.

## 4. Первый push с локальной машины

В папке проекта (репозиторий уже инициализирован, первый коммит есть):

```bash
git remote add deploy ssh://root@IP/srv/git/model-index.git
git push -u deploy main
```

`IP` — адрес VPS. Спросит пароль root; если сделал `ssh-copy-id root@IP`, спросит ключ и больше не будет.

На этом шаге в `/opt/model-index` ещё пусто: хука нет, `push` только наполнил склад.

## 5. Разовая выкладка и установка хука

```bash
sudo git --git-dir=/srv/git/model-index.git --work-tree=/opt/model-index checkout -f main
sudo chown -R modelindex:modelindex /opt/model-index

sudo cp /opt/model-index/deploy/post-receive /srv/git/model-index.git/hooks/post-receive
sudo chmod +x /srv/git/model-index.git/hooks/post-receive
sudo chown modelindex:modelindex /srv/git/model-index.git/hooks/post-receive
```

Хук хранится в репозитории (`deploy/post-receive`), поэтому его правки тоже версионируются.
Дальше он сам делает `checkout` в `/opt/model-index`, `git clean -fd` и `systemctl restart`.
`feedback.db` в `.gitignore`, а `clean` без `-x` игнорируемые файлы не трогает — база при выкладке остаётся на месте.

## 6. Служба systemd

Юнит тоже в репозитории:

```bash
sudo cp /opt/model-index/deploy/model-index.service /etc/systemd/system/model-index.service
sudo systemctl daemon-reload
sudo systemctl enable --now model-index
systemctl status model-index --no-pager
```

Ключевые строки юнита:

```ini
Environment=HOST=0.0.0.0
Environment=PORT=80
AmbientCapabilities=CAP_NET_BIND_SERVICE
```

`0.0.0.0` — иначе сервер слушает только `127.0.0.1` и снаружи не виден.
`CAP_NET_BIND_SERVICE` — позволяет службе под обычным пользователем занять порт 80.

## 7. Фаервол

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw enable
sudo ufw status
```

Плюс порт 80 в файрволе/security group панели провайдера — это отдельная настройка и самая частая причина «локально работает, снаружи нет».

## 8. Проверка

```bash
curl -I http://127.0.0.1/
curl -s -X POST http://127.0.0.1/api/feedback \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","message":"проверка с сервера"}'
```

Ждём `HTTP/1.1 200 OK` и `{"ok":true,"id":1}`. Дальше в браузере: `http://IP/` → футер → «форма обратной связи».

## 9. Обновления

```bash
git add -A
git commit -m "поправил таблицу"
git push deploy main
```

В ответе будет `→ выкладываю main в /opt/model-index` и `✓ готово`: служба перезапущена, страница открывается с новым кодом (сервер отдаёт без кэша).

Откат:

```bash
git revert HEAD && git push deploy main
# или жёстко:
git reset --hard HEAD~1 && git push --force deploy main
```

## 10. База и логи

```bash
sudo apt install -y sqlite3
sudo sqlite3 /opt/model-index/feedback.db "select id, created_at, email, message from feedback order by id desc"

journalctl -u model-index -n 50 --no-pager   # последние строки
journalctl -u model-index -f                 # следить вживую
```

Резервная копия — просто файл:

```bash
sudo cp /opt/model-index/feedback.db ~/feedback-$(date +%F).db
```

## 11. Если хочешь репозиторий на GitHub/GitLab

Схема та же, меняются две вещи: сервер клонирует репозиторий, а обновление — `git pull`.

```bash
# на сервере, вместо шага 3
sudo git clone https://github.com/USER/model-index.git /opt/model-index
sudo chown -R modelindex:modelindex /opt/model-index

# обновление вместо push
ssh root@IP 'cd /opt/model-index && git pull && systemctl restart model-index'
```

Хук `deploy/post-receive` в этом случае не нужен.

---

## Если что-то не открывается

| симптом | причина |
|---|---|
| `curl 127.0.0.1` на сервере работает, снаружи нет | закрыт порт 80 (ufw или панель провайдера) |
| `EADDRINUSE` в логах | порт занят, обычно `apache2`/`nginx` из образа: `sudo ss -lptn 'sport = :80'` |
| `Permission denied` при старте службы | нет `AmbientCapabilities=CAP_NET_BIND_SERVICE` |
| страница пустая / 404 | служба смотрит не туда: проверь `WorkingDirectory=/opt/model-index` |
| `push` прошёл, а сайт старый | хук не установлен или не исполняемый: `ls -l /srv/git/model-index.git/hooks/post-receive` |
| `fatal: not a git repository` на сервере | забыл `--git-dir` и `--work-tree` в шаге 5 |
| форма отвечает «не отправилось» | служба упала: `journalctl -u model-index -n 20 --no-pager` |

## Позже, когда появится домен

HTTPS добавляется обратным прокси, порт 80 освобождается, служба переводится на `PORT=8123`:

```bash
sudo apt install -y caddy
# /etc/caddy/Caddyfile:
#   example.com {
#       reverse_proxy 127.0.0.1:8123
#   }
```

До этого сайт живёт по `http://IP` — без сертификата, и это нормально.
