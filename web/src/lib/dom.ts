// DOM helpers for the page.

// The element for a selector that the page's markup always has. Throws if it is missing,
// which means the markup and the script disagree.
export function $<T extends Element>(sel: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
}

interface DirectoryPicker {
  showDirectoryPicker(options: { id?: string; mode: "read" | "readwrite"; startIn?: FileSystemHandle | string }): Promise<FileSystemDirectoryHandle>;
}

export const canPickDirectories = () => "showDirectoryPicker" in window;

// Asks the user for a folder. Returns null if they close the picker.
export async function pickDirectory(
  mode: "read" | "readwrite", startIn?: FileSystemHandle | string,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await (window as unknown as DirectoryPicker).showDirectoryPicker({ id: "plots", mode, startIn });
  } catch {
    // Closed, or picked a folder the browser refuses and then cancelled.
    return null;
  }
}

// Buttons with data-opens="<input id>" open that hidden file input. A real button keeps the
// file choosers reachable by keyboard, which a label around a hidden input is not.
export function wireFileButtons(root: ParentNode = document) {
  root.querySelectorAll<HTMLButtonElement>("button[data-opens]").forEach((btn) => {
    btn.addEventListener("click", () => $<HTMLInputElement>(`#${btn.dataset.opens}`).click());
  });
}
