#!/usr/bin/env node
'use strict';

/*
 * Model Index: минимальный сервер обратной связи.
 * Без зависимостей: node:http + node:sqlite (с откатом на JSONL).
 * Запуск:  node server.js  →  http://127.0.0.1:8123
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 8123);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const DB_FILE = path.join(ROOT, 'feedback.db');
const JSONL_FILE = path.join(ROOT, 'feedback.jsonl');
const MAX_BODY = 32 * 1024;
const COOLDOWN_MS = 15 * 1000;

/* ---------- хранилище ---------- */
let db = null;
let storage = 'jsonl';

try {
  const { DatabaseSync } = require('node:sqlite');
  db = new DatabaseSync(DB_FILE);
  db.exec(`
    CREATE TABLE IF NOT EXISTS feedback (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT    NOT NULL,
      name       TEXT,
      email      TEXT    NOT NULL,
      message    TEXT    NOT NULL,
      ip         TEXT,
      ua         TEXT
    )
  `);
  storage = 'sqlite';
} catch (err) {
  console.warn('[хранилище] node:sqlite недоступен, пишу в feedback.jsonl:', err.message);
}

function saveFeedback(entry) {
  if (db) {
    const stmt = db.prepare(
      'INSERT INTO feedback (created_at, name, email, message, ip, ua) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const info = stmt.run(entry.created_at, entry.name, entry.email, entry.message, entry.ip, entry.ua);
    return Number(info.lastInsertRowid);
  }
  fs.appendFileSync(JSONL_FILE, JSON.stringify(entry) + '\n', 'utf8');
  return fs.readFileSync(JSONL_FILE, 'utf8').split('\n').filter(Boolean).length;
}

function listFeedback(limit = 50) {
  if (db) {
    return db.prepare(
      'SELECT id, created_at, name, email, message FROM feedback ORDER BY id DESC LIMIT ?'
    ).all(limit);
  }
  if (!fs.existsSync(JSONL_FILE)) return [];
  return fs.readFileSync(JSONL_FILE, 'utf8')
    .split('\n').filter(Boolean).map((line, i) => Object.assign({ id: i + 1 }, JSON.parse(line)))
    .slice(-limit).reverse();
}

/* ---------- утилиты ---------- */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const lastHit = new Map();

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Сообщение слишком большое.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress || 'unknown';
}

/* ---------- маршруты ---------- */
async function handleFeedback(req, res) {
  const ip = clientIp(req);
  const now = Date.now();
  if (now - (lastHit.get(ip) || 0) < COOLDOWN_MS) {
    return send(res, 429, { error: 'Слишком часто. Попробуйте через несколько секунд.' });
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    return send(res, err.status || 400, { error: err.message });
  }

  let data;
  try {
    data = JSON.parse(raw || '{}');
  } catch {
    return send(res, 400, { error: 'Тело запроса не является JSON.' });
  }

  const name = String(data.name || '').trim().slice(0, 80);
  const email = String(data.email || '').trim().slice(0, 120);
  const message = String(data.message || '').trim().slice(0, 4000);
  const trap = String(data.company || '').trim(); // honeypot

  if (trap) return send(res, 200, { ok: true, id: 0 }); // тихо игнорируем ботов
  if (!EMAIL_RE.test(email)) return send(res, 400, { error: 'Нужен корректный e-mail.' });
  if (message.length < 4) return send(res, 400, { error: 'Сообщение слишком короткое.' });

  const entry = {
    created_at: new Date().toISOString(),
    name: name || null,
    email,
    message,
    ip,
    ua: String(req.headers['user-agent'] || '').slice(0, 300)
  };

  let id;
  try {
    id = saveFeedback(entry);
  } catch (err) {
    console.error('[ошибка записи]', err);
    return send(res, 500, { error: 'Не удалось сохранить сообщение.' });
  }

  lastHit.set(ip, now);
  console.log(`[обратная связь #${id}] ${email}, ${message.length} симв.`);
  return send(res, 200, { ok: true, id });
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = path.join(ROOT, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));

  if (!full.startsWith(ROOT) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return send(res, 404, 'не найдено', 'text/plain; charset=utf-8');
  }

  const ext = path.extname(full).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml'
  };

  const body = fs.readFileSync(full);
  res.writeHead(200, {
    'Content-Type': types[ext] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  try {
    if (url.pathname === '/api/feedback' && req.method === 'POST') return await handleFeedback(req, res);

    if (url.pathname === '/api/feedback' && req.method === 'GET') {
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(clientIp(req));
      if (!local) return send(res, 403, { error: 'Список доступен только с этой машины.' });
      return send(res, 200, { storage, count: listFeedback(200).length, items: listFeedback(50) });
    }

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);

    return send(res, 405, { error: 'Метод не поддерживается.' });
  } catch (err) {
    console.error('[сервер]', err);
    if (!res.headersSent) send(res, 500, { error: 'Внутренняя ошибка.' });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Порт ${PORT} занят. Возможно, сервер уже запущен: http://${HOST}:${PORT}`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`Model Index: http://${HOST}:${PORT}  ·  хранилище: ${storage === 'sqlite' ? DB_FILE : JSONL_FILE}`);
});
