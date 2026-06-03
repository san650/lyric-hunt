const DB_NAME = 'lyrics';
const DB_VERSION = 1;
const STORE = 'state';
const DOC_KEY = 'app';

let dbPromise = null;

const openDb = () => {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
};

const tx = async (mode) => {
  const db = await openDb();
  return db.transaction(STORE, mode).objectStore(STORE);
};

export const loadState = async () => {
  const s = await tx('readonly');
  return new Promise((res, rej) => {
    const r = s.get(DOC_KEY);
    r.onsuccess = () => res(r.result ?? null);
    r.onerror = () => rej(r.error);
  });
};

export const saveState = async (state) => {
  const s = await tx('readwrite');
  return new Promise((res, rej) => {
    const r = s.put(state, DOC_KEY);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  });
};

export const requestPersistence = async () => {
  if (navigator.storage?.persist) {
    try { await navigator.storage.persist(); } catch {}
  }
};
