// Tiny promise-based IndexedDB wrapper. Replaces AutoReview's server-side
// SQLite history + per-user config/uploads files with browser-local storage.
const DB_NAME = "autoscopai";
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("runs")) db.createObjectStore("runs", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

let dbPromise = null;
function getDb() {
  if (!dbPromise) dbPromise = openDb();
  return dbPromise;
}

async function kvGet(key) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readonly");
    const req = tx.objectStore("kv").get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function kvSet(key, value) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function saveRun(run) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("runs", "readwrite");
    tx.objectStore("runs").put(run);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function listRuns() {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("runs", "readonly");
    const req = tx.objectStore("runs").getAll();
    req.onsuccess = () => resolve((req.result || []).sort((a, b) => (b.started || 0) - (a.started || 0)));
    req.onerror = () => reject(req.error);
  });
}

async function getRun(id) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("runs", "readonly");
    const req = tx.objectStore("runs").get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function deleteRun(id) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("runs", "readwrite");
    tx.objectStore("runs").delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

window.AutoscopDB = { kvGet, kvSet, saveRun, listRuns, getRun, deleteRun };
