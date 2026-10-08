// Хмарне сховище договорів — приватний Vercel Blob + код доступу.
//
//   GET  /api/sync              → { docs: [...] }
//   POST /api/sync { docs: [] } → зливає список пристрою з хмарою і повертає об'єднаний
//
// Кожен запит має нести заголовок  x-app-code  зі значенням змінної APP_CODE.
import { get, put } from '@vercel/blob';

const KEY = 'dogovory.json';
const TOMBSTONE_TTL = 180 * 24 * 3600 * 1000;   // позначки про видалення тримаємо пів року

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'private, no-store');
  res.end(JSON.stringify(body));
}

// Тіло запиту: рантайм зазвичай уже розпарсив JSON, але читаємо і потік — про всяк випадок
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try { return JSON.parse(raw || '{}'); } catch (e) { return {}; }
}

async function readDocs() {
  try {
    const res = await get(KEY, { access: 'private', useCache: false });
    if (!res || res.statusCode !== 200 || !res.stream) return [];
    const data = JSON.parse(await new Response(res.stream).text());
    return Array.isArray(data.docs) ? data.docs : [];
  } catch (e) {
    // Порожнє сховище — це не помилка
    if (e && (e.name === 'BlobNotFoundError' || /not\s*found/i.test(e.message || ''))) return [];
    throw e;
  }
}

async function writeDocs(docs) {
  await put(KEY, JSON.stringify({ docs, savedAt: new Date().toISOString() }), {
    access: 'private',
    contentType: 'application/json',
    allowOverwrite: true,
    addRandomSuffix: false,
    cacheControlMaxAge: 0
  });
}

// Зливає два списки: для однакового id перемагає запис із пізнішим updatedAt.
// Видалені записи їдуть як «надгробки» ({deleted:true}), щоб видалення дійшло на всі пристрої.
function merge(remote, incoming) {
  const map = new Map();
  for (const d of [...remote, ...incoming]) {
    if (!d || !d.id) continue;
    const prev = map.get(d.id);
    if (!prev || String(d.updatedAt || '') > String(prev.updatedAt || '')) map.set(d.id, d);
  }
  const cutoff = new Date(Date.now() - TOMBSTONE_TTL).toISOString();
  return [...map.values()]
    .filter(d => !(d.deleted && String(d.updatedAt || '') < cutoff))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

export default async function handler(req, res) {
  const expected = process.env.APP_CODE;
  if (!expected) return send(res, 500, { error: 'APP_CODE не налаштовано на сервері' });
  if (req.headers['x-app-code'] !== expected) return send(res, 401, { error: 'Невірний код доступу' });

  try {
    if (req.method === 'GET') {
      return send(res, 200, { docs: await readDocs(), syncedAt: new Date().toISOString() });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const incoming = Array.isArray(body.docs) ? body.docs : [];
      const remote = await readDocs();
      const merged = merge(remote, incoming);
      // пишемо лише коли справді щось змінилося
      if (JSON.stringify(merged) !== JSON.stringify(merge(remote, []))) await writeDocs(merged);
      return send(res, 200, { docs: merged, syncedAt: new Date().toISOString() });
    }
    return send(res, 405, { error: 'Метод не підтримується' });
  } catch (e) {
    return send(res, 500, { error: 'Помилка сховища: ' + (e && e.message ? e.message : String(e)) });
  }
}
