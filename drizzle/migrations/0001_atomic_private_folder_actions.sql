CREATE OR REPLACE FUNCTION public.set_item_folders(p_kind text, p_item uuid, p_folders uuid[]) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE item_table text; folder_table text; membership_table text; item_column text; owner_id uuid; folder_count integer;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in required'; END IF;
 IF p_kind = 'diary' THEN item_table := 'diary_entries'; folder_table := 'diary_folders'; membership_table := 'diary_entry_folders'; item_column := 'entry_id';
 ELSIF p_kind = 'note' THEN item_table := 'notes'; folder_table := 'note_folders'; membership_table := 'note_folder_memberships'; item_column := 'note_id';
 ELSE RAISE EXCEPTION 'Invalid item type'; END IF;
 IF p_folders IS NULL OR cardinality(p_folders) > 100 THEN RAISE EXCEPTION 'Invalid folders'; END IF;
 EXECUTE format('SELECT user_id FROM public.%I WHERE id = $1 AND user_id = auth.uid() FOR UPDATE', item_table) INTO owner_id USING p_item;
 IF owner_id IS NULL THEN RAISE EXCEPTION 'Item not found'; END IF;
 EXECUTE format('SELECT count(*) FROM public.%I WHERE id = ANY($1) AND user_id = auth.uid()', folder_table) INTO folder_count USING p_folders;
 IF folder_count <> (SELECT count(DISTINCT x) FROM unnest(p_folders) x) THEN RAISE EXCEPTION 'Folder not found'; END IF;
 EXECUTE format('DELETE FROM public.%I WHERE %I = $1 AND user_id = auth.uid()', membership_table, item_column) USING p_item;
 EXECUTE format('INSERT INTO public.%I (user_id, %I, folder_id) SELECT auth.uid(), $1, x FROM (SELECT DISTINCT unnest($2::uuid[]) x) s', membership_table, item_column) USING p_item, p_folders;
 EXECUTE format('UPDATE public.%I SET folder_id = $2 WHERE id = $1 AND user_id = auth.uid()', item_table) USING p_item, p_folders[1];
END $$;
REVOKE ALL ON FUNCTION public.set_item_folders(text, uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_item_folders(text, uuid, uuid[]) TO authenticated;
CREATE OR REPLACE FUNCTION public.delete_owned_folder(p_kind text, p_folder uuid, p_delete_items boolean DEFAULT false) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE item_table text; folder_table text; membership_table text; item_column text; owner_id uuid;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in required'; END IF;
 IF p_kind = 'diary' THEN item_table := 'diary_entries'; folder_table := 'diary_folders'; membership_table := 'diary_entry_folders'; item_column := 'entry_id';
 ELSIF p_kind = 'note' THEN item_table := 'notes'; folder_table := 'note_folders'; membership_table := 'note_folder_memberships'; item_column := 'note_id';
 ELSE RAISE EXCEPTION 'Invalid item type'; END IF;
 EXECUTE format('SELECT user_id FROM public.%I WHERE id = $1 AND user_id = auth.uid() FOR UPDATE', folder_table) INTO owner_id USING p_folder;
 IF owner_id IS NULL THEN RAISE EXCEPTION 'Folder not found'; END IF;
 IF p_delete_items THEN
 EXECUTE format('DELETE FROM public.%I WHERE user_id = auth.uid() AND (folder_id = $1 OR id IN (SELECT %I FROM public.%I WHERE folder_id = $1 AND user_id = auth.uid()))', item_table, item_column, membership_table) USING p_folder;
 ELSE
 EXECUTE format('UPDATE public.%I SET folder_id = NULL WHERE folder_id = $1 AND user_id = auth.uid()', item_table) USING p_folder;
 END IF;
 EXECUTE format('DELETE FROM public.%I WHERE id = $1 AND user_id = auth.uid()', folder_table) USING p_folder;
END $$;
REVOKE ALL ON FUNCTION public.delete_owned_folder(text, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_owned_folder(text, uuid, boolean) TO authenticated;
CREATE OR REPLACE FUNCTION public.validate_private_folder_membership() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
 IF TG_TABLE_NAME = 'diary_entry_folders' THEN
 IF NOT EXISTS (SELECT 1 FROM public.diary_entries WHERE id = NEW.entry_id AND user_id = auth.uid()) OR NOT EXISTS (SELECT 1 FROM public.diary_folders WHERE id = NEW.folder_id AND user_id = auth.uid()) THEN RAISE EXCEPTION 'Invalid folder membership'; END IF;
 ELSE
 IF NOT EXISTS (SELECT 1 FROM public.notes WHERE id = NEW.note_id AND user_id = auth.uid()) OR NOT EXISTS (SELECT 1 FROM public.note_folders WHERE id = NEW.folder_id AND user_id = auth.uid()) THEN RAISE EXCEPTION 'Invalid folder membership'; END IF;
 END IF;
 IF NEW.user_id <> auth.uid() THEN RAISE EXCEPTION 'Invalid owner'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER validate_diary_folder_owner BEFORE INSERT OR UPDATE ON public.diary_entry_folders FOR EACH ROW EXECUTE FUNCTION public.validate_private_folder_membership();
CREATE TRIGGER validate_note_folder_owner BEFORE INSERT OR UPDATE ON public.note_folder_memberships FOR EACH ROW EXECUTE FUNCTION public.validate_private_folder_membership();