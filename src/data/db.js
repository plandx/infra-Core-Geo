const DB_NAME = 'infracore-geo';
const DB_VERSION = 1;
let _db = null;

async function open() {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      if (!e.target.result.objectStoreNames.contains('datasets')) {
        e.target.result.createObjectStore('datasets', { keyPath: 'key' });
      }
    };
    req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function saveDataset(key, rows, source = 'user') {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('datasets', 'readwrite');
    tx.objectStore('datasets').put({ key, rows, source, savedAt: Date.now() });
    tx.oncomplete = resolve;
    tx.onerror = (e) => reject(e.target.error);
  });
}

export async function loadDataset(key) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('datasets', 'readonly');
    const req = tx.objectStore('datasets').get(key);
    req.onsuccess = (e) => resolve(e.target.result ?? null);
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function clearAll() {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('datasets', 'readwrite');
    tx.objectStore('datasets').clear();
    tx.oncomplete = resolve;
    tx.onerror = (e) => reject(e.target.error);
  });
}

export async function loadAllCached() {
  try {
    const keys = ['collar', 'survey', 'geology', 'colorFiles'];
    const results = await Promise.all(keys.map((k) => loadDataset(k)));
    return Object.fromEntries(keys.map((k, i) => [k, results[i]]));
  } catch {
    return { collar: null, survey: null, geology: null, colorFiles: null };
  }
}
