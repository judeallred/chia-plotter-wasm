// Remembers each session's output folder. Directory handles can be stored in IndexedDB,
// and the browser asks for permission again before the page can write.

const DB = "pos2-plotter";
const STORE = "handles";
const key = (session: string) => `output-dir:${session}`;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadDir(session: string): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await open();
    return await new Promise((resolve) => {
      const req = db.transaction(STORE).objectStore(STORE).get(key(session));
      req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function saveDir(session: string, dir: FileSystemDirectoryHandle): Promise<void> {
  try {
    const db = await open();
    db.transaction(STORE, "readwrite").objectStore(STORE).put(dir, key(session));
  } catch {
    // Not remembering the folder is fine.
  }
}
