// Per tab settings sessions.
//
// Each tab has a session ID kept in sessionStorage, which survives reloads of that tab but is
// not shared with new tabs, so a new tab always starts fresh. The latest settings of every
// session are kept in localStorage, so any tab can load another tab's settings from the
// Recent sessions list.
//
// Duplicating a tab copies its sessionStorage, which would leave two live tabs writing the
// same session. On startup a tab asks the others over a BroadcastChannel whether its ID is
// taken, and if so starts a new session seeded with the copied settings.

const ID_KEY = "pos2-plotter-session-id";
const STORE_KEY = "pos2-plotter-sessions";
const MAX_SESSIONS = 20;

export interface SessionRecord {
  id: string;
  updated: number;
  summary: string;
  settings: Record<string, unknown>;
}

function readAll(): SessionRecord[] {
  try {
    const list = JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]");
    return Array.isArray(list) ? (list as SessionRecord[]) : [];
  } catch {
    return [];
  }
}

function writeAll(list: SessionRecord[]) {
  list.sort((a, b) => b.updated - a.updated);
  localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, MAX_SESSIONS)));
}

const newId = () => crypto.randomUUID();

const channel = "BroadcastChannel" in self ? new BroadcastChannel("pos2-plotter-sessions") : null;
let myId = "";
let myNonce = "";
channel?.addEventListener("message", (ev: MessageEvent<{ type: string; id: string; nonce: string }>) => {
  const m = ev.data;
  if (m.type === "hello" && myId && m.id === myId && m.nonce !== myNonce) {
    channel.postMessage({ type: "taken", id: m.id, nonce: m.nonce });
  }
});

// Returns this tab's session ID and the settings it should start with: the session's saved
// settings after a reload, the copied settings in a duplicated tab, or none in a new tab.
export async function startSession(): Promise<{ id: string; settings: Record<string, unknown> | null }> {
  myNonce = newId();
  let id = sessionStorage.getItem(ID_KEY);
  if (!id) {
    id = newId();
    sessionStorage.setItem(ID_KEY, id);
    myId = id;
    return { id, settings: null };
  }
  const saved = getSession(id)?.settings ?? null;
  if (channel) {
    const taken = await new Promise<boolean>((resolve) => {
      const nonce = myNonce;
      const onMessage = (ev: MessageEvent<{ type: string; id: string; nonce: string }>) => {
        if (ev.data.type === "taken" && ev.data.id === id && ev.data.nonce === nonce) {
          channel.removeEventListener("message", onMessage);
          resolve(true);
        }
      };
      channel.addEventListener("message", onMessage);
      channel.postMessage({ type: "hello", id, nonce });
      setTimeout(() => {
        channel.removeEventListener("message", onMessage);
        resolve(false);
      }, 150);
    });
    if (taken) {
      id = newId();
      sessionStorage.setItem(ID_KEY, id);
    }
  }
  myId = id;
  return { id, settings: saved };
}

export function getSession(id: string): SessionRecord | undefined {
  return readAll().find((s) => s.id === id);
}

export function listSessions(): SessionRecord[] {
  return readAll().sort((a, b) => b.updated - a.updated);
}

export function saveSession(id: string, settings: Record<string, unknown>, summary: string) {
  const list = readAll().filter((s) => s.id !== id);
  list.push({ id, updated: Date.now(), summary, settings });
  writeAll(list);
}

export function deleteSession(id: string) {
  writeAll(readAll().filter((s) => s.id !== id));
}
