// Lokale Datenhaltung in IndexedDB (alle Daten bleiben auf dem Gerät)
const DB_NAME = 'fahrtenbuch';
const DB_VERSION = 1;
export const STORES = ['settings', 'periods', 'legs', 'days', 'trips', 'receipts'];

let dbp = null;
export function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const rq = indexedDB.open(DB_NAME, DB_VERSION);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
  return dbp;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const os = tx.objectStore(store);
    let result;
    const rq = fn(os);
    if (rq) rq.onsuccess = () => { result = rq.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const getAll = (store) => run(store, 'readonly', (os) => os.getAll());
export const get = (store, id) => run(store, 'readonly', (os) => os.get(id));
export const putRaw = (store, rec) => run(store, 'readwrite', (os) => os.put(rec));
export const delRaw = (store, id) => run(store, 'readwrite', (os) => os.delete(id));

export const getBlob = (id) => get('blobs', id);
export const putBlob = (id, data, mime) => putRaw('blobs', { id, data, mime });
export const delBlob = (id) => delRaw('blobs', id);

export async function getMeta(key, fallback = null) {
  const r = await get('meta', key);
  return r ? r.value : fallback;
}
export const setMeta = (key, value) => putRaw('meta', { key, value });

export async function loadAll() {
  const out = {};
  for (const s of STORES) out[s] = await getAll(s);
  return out;
}
