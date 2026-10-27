// Plots kept in the origin private file system (OPFS) until downloaded.
//
// Each tab writes into a folder of its own, named after its session, and holds a Web Lock
// with the same name for as long as it is open. On startup a tab clears its own folder
// (left over from before a reload) and every folder whose tab is gone, which it can tell
// because nobody holds that folder's lock. Folders of other open tabs are left alone, so
// their plots stay downloadable.

const FOLDER_PREFIX = "session-";
const lockName = (folder: string) => `pos2-plot-storage:${folder}`;

export interface PlotStorage {
  folder: string;
  // Keeps a finished plot until the next one is kept. Older plots are removed then, once
  // their check is done, by which time their download has long completed.
  keep(name: string, link: HTMLAnchorElement, checked: Promise<unknown>): Promise<void>;
}

export async function claimPlotStorage(sessionId: string): Promise<PlotStorage> {
  const folder = `${FOLDER_PREFIX}${sessionId}`;
  const root = await navigator.storage.getDirectory();
  // Held until the tab closes. The callback's promise never settles.
  await new Promise<void>((resolve) => {
    void navigator.locks.request(lockName(folder), () => {
      resolve();
      return new Promise(() => {});
    });
  });
  const held = new Set((await navigator.locks.query()).held?.map((l) => l.name));
  for await (const [name, handle] of (root as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
    const stale =
      // Plots from versions of the page that wrote into the root.
      (handle.kind === "file" && name.endsWith(".plot2")) ||
      (handle.kind === "directory" && name.startsWith(FOLDER_PREFIX) && (name === folder || !held.has(lockName(name))));
    if (stale) await root.removeEntry(name, { recursive: true }).catch(() => {});
  }
  const dir = await root.getDirectoryHandle(folder, { create: true });

  let kept: { name: string; link: HTMLAnchorElement; checked: Promise<unknown> }[] = [];
  return {
    folder,
    keep: async (name, link, checked) => {
      const old = kept;
      kept = [{ name, link, checked }];
      for (const p of old) {
        // A check never settles only if its worker hangs. Do not hold the next plot for it.
        await Promise.race([p.checked, new Promise((r) => setTimeout(r, 60_000))]);
        await dir.removeEntry(p.name).catch(() => {});
        URL.revokeObjectURL(p.link.href);
        p.link.replaceWith("Downloaded");
      }
    },
  };
}
