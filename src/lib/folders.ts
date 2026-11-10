export type FolderRow = { id: string; name: string; parent_id: string | null };

// Flattens folders into a depth-first list with display labels like "Trips / Goa".
export function folderOptions(folders: FolderRow[]) {
  const byParent = new Map<string | null, FolderRow[]>();
  for (const f of folders) {
    const p = f.parent_id && folders.some((x) => x.id === f.parent_id) ? f.parent_id : null;
    byParent.set(p, [...(byParent.get(p) ?? []), f]);
  }
  const out: { value: string; label: string }[] = [];
  const walk = (parent: string | null, prefix: string, depth: number) => {
    if (depth > 10) return;
    for (const f of (byParent.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
      const label = prefix ? `${prefix} / ${f.name}` : f.name;
      out.push({ value: f.id, label });
      walk(f.id, label, depth + 1);
    }
  };
  walk(null, "", 0);
  return out;
}

// A folder plus all of its sub-folders.
export function folderWithDescendants(folders: FolderRow[], id: string) {
  const ids = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) {
      if (f.parent_id && ids.has(f.parent_id) && !ids.has(f.id)) {
        ids.add(f.id);
        grew = true;
      }
    }
  }
  return ids;
}

export type FolderTreeItem = {
  id: string;
  name: string;
  fullPath: string;
  depth: number;
  parent_id: string | null;
  hasChildren: boolean;
};

// Produces a depth-first hierarchical list of folders with depth and child metadata for sidebar trees.
export function folderTreeItems(folders: FolderRow[]): FolderTreeItem[] {
  const byParent = new Map<string | null, FolderRow[]>();
  for (const f of folders) {
    const p = f.parent_id && folders.some((x) => x.id === f.parent_id) ? f.parent_id : null;
    byParent.set(p, [...(byParent.get(p) ?? []), f]);
  }
  const out: FolderTreeItem[] = [];
  const walk = (parent: string | null, prefix: string, depth: number) => {
    if (depth > 10) return;
    for (const f of (byParent.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
      const fullPath = prefix ? `${prefix} / ${f.name}` : f.name;
      const children = byParent.get(f.id) ?? [];
      out.push({
        id: f.id,
        name: f.name,
        fullPath,
        depth,
        parent_id: parent,
        hasChildren: children.length > 0,
      });
      walk(f.id, fullPath, depth + 1);
    }
  };
  walk(null, "", 0);
  return out;
}
