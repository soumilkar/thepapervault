import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Folder, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

export type FolderKind = "diary" | "note";
export type FolderRow = { id: string; name: string };
export function useFolderMemberships(kind: FolderKind, userId: string) {
  return useQuery({ queryKey: ["folder-memberships", kind, userId], queryFn: async () => {
    const { data, error } = await supabase.from(kind === "diary" ? "diary_entry_folders" : "note_folder_memberships").select("*").eq("user_id", userId);
    if (error) throw error;
    return (data ?? []).map((row) => ({ itemId: "entry_id" in row ? row.entry_id : row.note_id, folderId: row.folder_id }));
  } });
}
export function itemFolders(itemId: string, legacy: string | null, rows: { itemId: string; folderId: string }[] = []) {
  return [...new Set([...rows.filter((row) => row.itemId === itemId).map((row) => row.folderId), ...(legacy ? [legacy] : [])])];
}
export async function saveItemFolders(kind: FolderKind, itemId: string, folderIds: string[]) {
  const { error } = await supabase.rpc("set_item_folders", { p_kind: kind, p_item: itemId, p_folders: folderIds });
  if (error) throw error;
}
export function FolderPicker({ folders, selected, onChange, disabled = false }: { folders: FolderRow[]; selected: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  return <Popover><PopoverTrigger asChild><Button type="button" variant="outline" size="sm" disabled={disabled}><Folder />{selected.length ? `${selected.length} folder${selected.length > 1 ? "s" : ""}` : "Folders"}</Button></PopoverTrigger>
    <PopoverContent className="w-64 max-h-72 overflow-y-auto" align="start">
      {folders.length ? folders.map((folder) => <label key={folder.id} className="flex cursor-pointer items-center gap-2 py-2 text-sm"><Checkbox checked={selected.includes(folder.id)} disabled={disabled} onCheckedChange={(checked) => onChange(checked ? [...selected, folder.id] : selected.filter((id) => id !== folder.id))} /><span className="break-words">{folder.name}</span></label>) : <p className="text-sm text-muted-foreground">No folders yet.</p>}
    </PopoverContent></Popover>;
}
export function ItemFolderPicker({ kind, itemId, selected, folders }: { kind: FolderKind; itemId: string; selected: string[]; folders: FolderRow[] }) {
  const qc = useQueryClient();
  const mutation = useMutation({ mutationFn: (ids: string[]) => saveItemFolders(kind, itemId, ids), onSuccess: () => {
    void qc.invalidateQueries({ queryKey: ["folder-memberships", kind] });
    void qc.invalidateQueries({ queryKey: [kind === "diary" ? "diary" : "notes"] });
  }, onError: (e: Error) => toast.error(e.message) });
  return <FolderPicker folders={folders} selected={selected} onChange={(ids) => mutation.mutate(ids)} disabled={mutation.isPending} />;
}
export function OpenFolderActions({ kind, folder, onDeleted }: { kind: FolderKind; folder: FolderRow; onDeleted: () => void }) {
  const qc = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [name, setName] = useState(folder.name);
  useEffect(() => { setName(folder.name); setRenaming(false); setDeleting(false); }, [folder.id, folder.name]);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: [kind === "diary" ? "diary-folders" : "note-folders"] });
    void qc.invalidateQueries({ queryKey: ["folder-memberships", kind] });
    void qc.invalidateQueries({ queryKey: [kind === "diary" ? "diary" : "notes"] });
    void qc.invalidateQueries({ queryKey: ["dashboard-counts"] });
    void qc.invalidateQueries({ queryKey: ["public-diary-feed"] });
  };
  const rename = useMutation({ mutationFn: async () => {
    const { error } = await supabase.from(kind === "diary" ? "diary_folders" : "note_folders").update({ name: name.trim() }).eq("id", folder.id);
    if (error) throw error;
  }, onSuccess: () => { setRenaming(false); refresh(); }, onError: (e: Error) => toast.error(e.message) });
  const remove = useMutation({ mutationFn: async (deleteItems: boolean) => {
    const { error } = await supabase.rpc("delete_owned_folder", { p_kind: kind, p_folder: folder.id, p_delete_items: deleteItems });
    if (error) throw error;
  }, onSuccess: () => { setDeleting(false); onDeleted(); refresh(); toast.success("Folder deleted"); }, onError: (e: Error) => toast.error(e.message) });
  return <>
    <Button variant="ghost" size="icon" title="Rename open folder" aria-label="Rename open folder" onClick={() => setRenaming(true)}><Pencil /></Button>
    <Button variant="ghost" size="icon" title="Delete open folder" aria-label="Delete open folder" onClick={() => setDeleting(true)}><Trash2 /></Button>
    <Dialog open={renaming} onOpenChange={setRenaming}><DialogContent><DialogHeader><DialogTitle>Rename folder</DialogTitle><DialogDescription>{folder.name}</DialogDescription></DialogHeader><form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (name.trim()) rename.mutate(); }}><Input aria-label="Folder name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /><Button type="submit" disabled={!name.trim() || rename.isPending}>Save name</Button></form></DialogContent></Dialog>
    <Dialog open={deleting} onOpenChange={setDeleting}><DialogContent><DialogHeader><DialogTitle>Delete {folder.name}?</DialogTitle><DialogDescription>Keep its {kind === "diary" ? "entries" : "notes"} in All and their other folders, or permanently delete them everywhere. This cannot be undone.</DialogDescription></DialogHeader><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={remove.isPending} onClick={() => remove.mutate(false)}>Keep {kind === "diary" ? "entries" : "notes"}</Button><Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate(true)}>Delete {kind === "diary" ? "entries" : "notes"} too</Button></div></DialogContent></Dialog>
  </>;
}