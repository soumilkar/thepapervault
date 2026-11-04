import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  Trash2,
  Pencil,
  X,
  Check,
  BookOpen,
  Users,
  Heart,
  MessageCircle,
  Bell,
  BellOff,
  ArrowUp,
  ArrowDown,
  CornerDownRight,
  Download,
  ImagePlus,
} from "lucide-react";
import { MusicSearch, MusicPlayer, type SelectedTrack } from "@/components/MusicSearch";
import { Markdown } from "@/components/Markdown";
import { downloadTextFile } from "@/lib/download";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useBrowserDraft } from "@/lib/browser-drafts";

export const Route = createFileRoute("/app/blog")({
  component: BlogPage,
});

type Tab = "mine" | "community";

const MEDIA_BUCKET = "media";

async function uploadMedia(userId: string, file: File): Promise<string> {
  const ALLOWED: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
  };
  const ext = ALLOWED[file.type];
  if (!ext) throw new Error("Only JPEG, PNG, WebP, or GIF images are allowed");
  if (file.size > 5 * 1024 * 1024) throw new Error("Image must be smaller than 5 MB");
  const path = `${userId}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage
    .from(MEDIA_BUCKET)
    .upload(path, file, { contentType: file.type });
  if (error) throw error;
  return path;
}

async function getMediaUrl(path: string | null): Promise<string | null> {
  if (!path) return null;
  const { data } = await supabase.storage.from(MEDIA_BUCKET).createSignedUrl(path, 60 * 60);
  return data?.signedUrl ?? null;
}

function BlogPage() {
  const { user } = Route.useRouteContext();
  const qc = useQueryClient();
  type BlogDraft = {
    title: string;
    content: string;
    tags: string;
    music: SelectedTrack | null;
    notify: boolean;
  };
  const [draft, setDraft, clearDraft, draftReady] = useBrowserDraft<BlogDraft>(
    `papervault:blog-draft:${user.id}`,
    {
      title: "",
      content: "",
      tags: "",
      music: null,
      notify: true,
    },
  );
  const { title, content, tags, music, notify } = draft;
  const setTitle = (value: string) => setDraft((current) => ({ ...current, title: value }));
  const setContent = (value: string) => setDraft((current) => ({ ...current, content: value }));
  const setTags = (value: string) => setDraft((current) => ({ ...current, tags: value }));
  const setMusic = (value: SelectedTrack | null) =>
    setDraft((current) => ({ ...current, music: value }));
  const setNotify = (value: boolean) => setDraft((current) => ({ ...current, notify: value }));
  const [image, setImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("mine");

  useEffect(() => {
    if (draftReady && (title.trim() || content.trim() || tags.trim())) setOpen(true);
  }, [draftReady]);

  useEffect(() => {
    if (!image) {
      setImagePreview(null);
      return;
    }
    const url = URL.createObjectURL(image);
    setImagePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);

  const mine = useQuery({
    queryKey: ["blog", "mine", user.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("blog_posts")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const community = useQuery({
    queryKey: ["blog", "community", user.id],
    enabled: tab === "community",
    queryFn: async () => {
      const { data: posts, error } = await supabase
        .from("blog_posts")
        .select("*")
        .neq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      const ids = Array.from(new Set((posts ?? []).map((p) => p.user_id)));
      const nameMap = new Map<string, string>();
      if (ids.length) {
        const { data: profs } = await supabase
          .from("profiles")
          .select("id, display_name")
          .in("id", ids);
        (profs ?? []).forEach((p) => nameMap.set(p.id, p.display_name || "someone"));
      }
      return (posts ?? []).map((p) => ({ ...p, author: nameMap.get(p.user_id) || "someone" }));
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const tagArr = tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      let imagePath: string | null = null;
      if (image) imagePath = await uploadMedia(user.id, image);
      const { error } = await supabase.from("blog_posts").insert({
        user_id: user.id,
        title,
        content,
        tags: tagArr.length ? tagArr : null,
        notify_on_comment: notify,
        image_url: imagePath,
        music_track_id: music?.music_track_id ?? null,
        music_track_name: music?.music_track_name ?? null,
        music_artist: music?.music_artist ?? null,
        music_preview_url: music?.music_preview_url ?? null,
        music_artwork_url: music?.music_artwork_url ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      clearDraft();
      setImage(null);
      setOpen(false);
      toast.success("Blog published");
      qc.invalidateQueries({ queryKey: ["blog"] });
      qc.invalidateQueries({ queryKey: ["dashboard-counts"] });
      qc.invalidateQueries({ queryKey: ["heatmap-activity"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (post: { id: string; image_url?: string | null }) => {
      if (post.image_url) {
        await supabase.storage.from(MEDIA_BUCKET).remove([post.image_url]);
      }
      const { error } = await supabase.from("blog_posts").delete().eq("id", post.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["blog"] });
      qc.invalidateQueries({ queryKey: ["dashboard-counts"] });
      qc.invalidateQueries({ queryKey: ["heatmap-activity"] });
    },
  });

  const update = useMutation({
    mutationFn: async (vars: {
      id: string;
      oldImageUrl?: string | null;
      title: string;
      content: string;
      tags: string;
      newImage?: File | null;
      clearImage?: boolean;
    }) => {
      const tagArr = vars.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const patch: Record<string, unknown> = {
        title: vars.title,
        content: vars.content,
        tags: tagArr.length ? tagArr : null,
      };
      if (vars.newImage) {
        if (vars.oldImageUrl) {
          await supabase.storage.from(MEDIA_BUCKET).remove([vars.oldImageUrl]);
        }
        patch.image_url = await uploadMedia(user.id, vars.newImage);
      } else if (vars.clearImage) {
        if (vars.oldImageUrl) {
          await supabase.storage.from(MEDIA_BUCKET).remove([vars.oldImageUrl]);
        }
        patch.image_url = null;
      }
      const { error } = await supabase
        .from("blog_posts")
        .update(patch as never)
        .eq("id", vars.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Post updated");
      qc.invalidateQueries({ queryKey: ["blog"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const exportMine = () => {
    const rows = mine.data ?? [];
    if (!rows.length) {
      toast.error("No posts to export yet");
      return;
    }
    const txt = rows
      .map(
        (p: any) =>
          `${new Date(p.created_at).toISOString().slice(0, 10)} — ${p.title}${p.tags?.length ? `  [${p.tags.join(", ")}]` : ""}\n${"=".repeat(60)}\n${p.content}\n`,
      )
      .join("\n\n");
    downloadTextFile(`blog-${new Date().toISOString().slice(0, 10)}.txt`, txt);
  };

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
        <div className="min-w-0">
          <p className="font-hand text-2xl text-sepia">your thoughts, published</p>
          <h1 className="font-serif text-4xl text-primary">Blog</h1>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            onClick={exportMine}
            className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm text-primary hover:bg-secondary"
          >
            <Download className="size-4" /> Export
          </button>
          <button
            onClick={() => setOpen(!open)}
            className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
          >
            {open ? "Cancel" : "Write new post"}
          </button>
        </div>
      </div>

      {open && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim() && content.trim()) create.mutate();
          }}
          className="paper-card space-y-3 p-6"
        >
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Post title"
            required
            className="w-full bg-transparent font-serif text-3xl outline-none placeholder:text-muted-foreground/60"
          />
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="tags, separated, by, commas"
            className="w-full bg-transparent text-sm text-accent outline-none placeholder:text-muted-foreground/60"
          />
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Write your story... (markdown supported: **bold**, _italic_, # heading, lists, links)"
            rows={12}
            required
            className="w-full resize-none bg-transparent leading-relaxed outline-none placeholder:text-muted-foreground/60"
          />
          {imagePreview && (
            <div className="relative inline-block">
              <img
                src={imagePreview}
                alt="preview"
                className="max-h-56 rounded-md border border-border"
              />
              <button
                type="button"
                onClick={() => setImage(null)}
                className="absolute -right-2 -top-2 rounded-full bg-background p-1 shadow"
              >
                <X className="size-4" />
              </button>
            </div>
          )}
          <div className="flex flex-wrap gap-4">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-accent hover:text-primary">
              <ImagePlus className="size-4" />
              <span>{image ? "Change image" : "Attach an image"}</span>
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) {
                    if (f.size > 5 * 1024 * 1024) toast.error("Image must be smaller than 5 MB");
                    else setImage(f);
                  }
                  e.currentTarget.value = "";
                }}
              />
            </label>
          </div>
          <MusicSearch selected={music} onChange={setMusic} />
          <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={notify}
              onChange={(e) => setNotify(e.target.checked)}
              className="size-4 accent-primary"
            />
            <span className="flex items-center gap-1">
              {notify ? (
                <Bell className="size-3.5 text-accent" />
              ) : (
                <BellOff className="size-3.5" />
              )}
              Email me when someone comments on this post
            </span>
          </label>
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={create.isPending}
              className="rounded-md bg-primary px-5 py-2 text-sm text-primary-foreground disabled:opacity-50"
            >
              {create.isPending ? "Publishing..." : "Publish"}
            </button>
          </div>
        </form>
      )}

      <div className="flex gap-2 border-b border-border">
        <TabBtn
          active={tab === "mine"}
          onClick={() => setTab("mine")}
          icon={<BookOpen className="size-4" />}
          label="My Blogs"
        />
        <TabBtn
          active={tab === "community"}
          onClick={() => setTab("community")}
          icon={<Users className="size-4" />}
          label="Community"
        />
      </div>

      {tab === "mine" ? (
        <div className="space-y-4">
          {mine.isLoading && <p className="text-muted-foreground">Loading...</p>}
          {mine.data?.length === 0 && <p className="text-muted-foreground">No blog posts yet.</p>}
          {mine.data?.map((p) => (
            <BlogCard
              key={p.id}
              post={p}
              currentUserId={user.id}
              isOwner
              onDelete={() => remove.mutate({ id: p.id, image_url: p.image_url })}
              onSave={(vals) => update.mutate({ id: p.id, oldImageUrl: p.image_url, ...vals })}
            />
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {community.isLoading && (
            <p className="text-muted-foreground">Loading community stories...</p>
          )}
          {community.data?.length === 0 && (
            <p className="text-muted-foreground">No posts from others yet.</p>
          )}
          {community.data?.map((p) => (
            <BlogCard
              key={p.id}
              post={p}
              currentUserId={user.id}
              isOwner={false}
              author={p.author}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 border-b-2 px-4 py-2 text-sm transition ${
        active
          ? "border-primary text-primary"
          : "border-transparent text-muted-foreground hover:text-primary"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function BlogImage({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getMediaUrl(path).then((u) => {
      if (!cancelled) setSrc(u);
    });
    return () => {
      cancelled = true;
    };
  }, [path]);
  if (!src) return null;
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      className="mt-4 max-h-[28rem] w-full rounded-md border border-border object-contain"
    />
  );
}

const BlogCard = memo(function BlogCard({
  post: p,
  isOwner,
  author,
  currentUserId,
  onDelete,
  onSave,
}: {
  post: any;
  isOwner: boolean;
  author?: string;
  currentUserId: string;
  onDelete?: () => void;
  onSave?: (vals: {
    title: string;
    content: string;
    tags: string;
    newImage?: File | null;
    clearImage?: boolean;
  }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [eTitle, setETitle] = useState(p.title);
  const [eContent, setEContent] = useState(p.content);
  const [eTags, setETags] = useState((p.tags ?? []).join(", "));
  const [eImage, setEImage] = useState<File | null>(null);
  const [eImagePreview, setEImagePreview] = useState<string | null>(null);
  const [eClearImage, setEClearImage] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  useEffect(() => {
    if (!eImage) {
      setEImagePreview(null);
      return;
    }
    const url = URL.createObjectURL(eImage);
    setEImagePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [eImage]);

  const preview = p.content.length > 220 ? p.content.slice(0, 220).trimEnd() + "…" : p.content;

  const startEdit = () => {
    setETitle(p.title);
    setEContent(p.content);
    setETags((p.tags ?? []).join(", "));
    setEImage(null);
    setEClearImage(false);
    setEditing(true);
    setOpen(true);
  };

  if (editing) {
    return (
      <article className="paper-card space-y-3 p-6">
        <input
          value={eTitle}
          onChange={(e) => setETitle(e.target.value)}
          className="w-full bg-transparent font-serif text-2xl outline-none"
        />
        <input
          value={eTags}
          onChange={(e) => setETags(e.target.value)}
          placeholder="tags, separated, by, commas"
          className="w-full bg-transparent text-sm text-accent outline-none"
        />
        <textarea
          value={eContent}
          onChange={(e) => setEContent(e.target.value)}
          rows={10}
          className="w-full resize-none bg-transparent leading-relaxed outline-none"
        />

        {eImagePreview ? (
          <div className="relative inline-block">
            <img src={eImagePreview} className="max-h-48 rounded-md border border-border" alt="" />
            <button
              type="button"
              onClick={() => setEImage(null)}
              className="absolute -right-2 -top-2 rounded-full bg-background p-1 shadow"
            >
              <X className="size-4" />
            </button>
          </div>
        ) : p.image_url && !eClearImage ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>Current image kept.</span>
            <button
              type="button"
              onClick={() => setEClearImage(true)}
              className="text-destructive hover:underline"
            >
              Remove
            </button>
          </div>
        ) : null}

        <label className="flex cursor-pointer items-center gap-2 text-sm text-accent hover:text-primary">
          <ImagePlus className="size-4" />
          <span>
            {eImage
              ? "Change image"
              : p.image_url && !eClearImage
                ? "Replace image"
                : "Attach image"}
          </span>
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) {
                if (f.size > 5 * 1024 * 1024) toast.error("Image must be smaller than 5 MB");
                else {
                  setEImage(f);
                  setEClearImage(false);
                }
              }
              e.currentTarget.value = "";
            }}
          />
        </label>

        <div className="flex justify-end gap-2">
          <button
            onClick={() => setEditing(false)}
            className="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm"
          >
            <X className="size-4" /> Cancel
          </button>
          <button
            onClick={() => {
              onSave?.({
                title: eTitle,
                content: eContent,
                tags: eTags,
                newImage: eImage,
                clearImage: eClearImage,
              });
              setEditing(false);
            }}
            className="flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
          >
            <Check className="size-4" /> Save
          </button>
        </div>
      </article>
    );
  }

  return (
    <article className="paper-card p-6">
      <header className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3">
        <button
          onClick={() => setOpen((o) => !o)}
          className="min-w-0 text-left font-serif text-2xl text-primary hover:underline underline-offset-4"
        >
          <span className="break-words">{p.title}</span>
        </button>
        <div className="flex shrink-0 items-center gap-3">
          <span className="font-hand text-sepia">
            {new Date(p.created_at).toLocaleDateString()}
          </span>
          {isOwner && (
            <>
              <button
                onClick={startEdit}
                className="text-muted-foreground hover:text-primary"
                aria-label="Edit"
              >
                <Pencil className="size-4" />
              </button>
              <button
                onClick={() => setConfirmDel(true)}
                className="text-muted-foreground hover:text-destructive"
                aria-label="Delete"
              >
                <Trash2 className="size-4" />
              </button>
            </>
          )}
        </div>
      </header>
      {author && <p className="mt-1 text-sm text-accent">by {author}</p>}
      {p.tags && p.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {p.tags.map((t: string) => (
            <span
              key={t}
              className="rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
            >
              #{t}
            </span>
          ))}
        </div>
      )}
      <div className="mt-3">
        {open ? (
          <Markdown>{p.content}</Markdown>
        ) : (
          <p className="whitespace-pre-wrap leading-relaxed">{preview}</p>
        )}
      </div>
      {open && p.image_url && <BlogImage path={p.image_url} />}
      {p.content.length > 220 && (
        <button
          onClick={() => setOpen((o) => !o)}
          className="mt-2 text-sm text-accent hover:text-primary"
        >
          {open ? "Show less" : "Read more"}
        </button>
      )}
      {p.music_preview_url && <MusicPlayer track={p} />}

      <div className="mt-4 flex items-center gap-4 border-t border-border/60 pt-3">
        <LikeButton postId={p.id} currentUserId={currentUserId} />
        <button
          onClick={() => setShowComments((s) => !s)}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary"
        >
          <MessageCircle className="size-4" /> Comments
        </button>
      </div>

      {showComments && (
        <Comments postId={p.id} postAuthorId={p.user_id} currentUserId={currentUserId} />
      )}

      <ConfirmDialog
        open={confirmDel}
        onOpenChange={setConfirmDel}
        title="Delete this blog post?"
        description="This can't be undone. Comments and likes on it will also be removed."
        confirmText="Delete post"
        onConfirm={() => {
          onDelete?.();
          setConfirmDel(false);
        }}
      />
    </article>
  );
});

function LikeButton({ postId, currentUserId }: { postId: string; currentUserId: string }) {
  const qc = useQueryClient();
  const likes = useQuery({
    queryKey: ["likes", postId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("blog_likes")
        .select("user_id")
        .eq("post_id", postId);
      if (error) throw error;
      const rows = data ?? [];
      return {
        count: rows.length,
        liked: rows.some((r) => r.user_id === currentUserId),
      };
    },
  });

  const toggle = useMutation({
    mutationFn: async () => {
      if (likes.data?.liked) {
        const { error } = await supabase
          .from("blog_likes")
          .delete()
          .eq("post_id", postId)
          .eq("user_id", currentUserId);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("blog_likes")
          .insert({ post_id: postId, user_id: currentUserId });
        if (error) throw error;
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["likes", postId] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const liked = likes.data?.liked;
  return (
    <button
      onClick={() => toggle.mutate()}
      className={`flex items-center gap-1.5 text-sm transition ${
        liked ? "text-destructive" : "text-muted-foreground hover:text-destructive"
      }`}
    >
      <Heart className={`size-4 ${liked ? "fill-current" : ""}`} />
      {likes.data?.count ?? 0}
    </button>
  );
}

type CommentNode = {
  id: string;
  user_id: string;
  content: string;
  created_at: string;
  updated_at?: string;
  parent_id: string | null;
  author: string;
  children: CommentNode[];
};

function Comments({
  postId,
  postAuthorId,
  currentUserId,
}: {
  postId: string;
  postAuthorId: string;
  currentUserId: string;
}) {
  const qc = useQueryClient();
  const [text, setText] = useState("");

  const comments = useQuery({
    queryKey: ["comments", postId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("blog_comments")
        .select("*")
        .eq("post_id", postId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      const ids = Array.from(new Set((data ?? []).map((c) => c.user_id)));
      const nameMap = new Map<string, string>();
      if (ids.length) {
        const { data: profs } = await supabase
          .from("profiles")
          .select("id, display_name")
          .in("id", ids);
        (profs ?? []).forEach((p) => nameMap.set(p.id, p.display_name || "someone"));
      }
      return (data ?? []).map((c: any) => ({ ...c, author: nameMap.get(c.user_id) || "someone" }));
    },
  });

  const tree = useMemo<CommentNode[]>(() => {
    const rows = comments.data ?? [];
    const map = new Map<string, CommentNode>();
    rows.forEach((r: any) => map.set(r.id, { ...r, children: [] }));
    const roots: CommentNode[] = [];
    map.forEach((n) => {
      if (n.parent_id && map.has(n.parent_id)) map.get(n.parent_id)!.children.push(n);
      else roots.push(n);
    });
    return roots;
  }, [comments.data]);

  const add = useMutation({
    mutationFn: async (vars: { content: string; parent_id: string | null }) => {
      const { error } = await supabase.from("blog_comments").insert({
        post_id: postId,
        user_id: currentUserId,
        content: vars.content.trim(),
        parent_id: vars.parent_id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setText("");
      qc.invalidateQueries({ queryKey: ["comments", postId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const edit = useMutation({
    mutationFn: async (vars: { id: string; content: string }) => {
      const { error } = await supabase
        .from("blog_comments")
        .update({ content: vars.content.trim() })
        .eq("id", vars.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["comments", postId] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("blog_comments").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["comments", postId] }),
  });

  return (
    <div className="mt-3 space-y-3 border-t border-border/60 pt-3">
      {tree.length === 0 && (
        <p className="text-sm text-muted-foreground">Be the first to comment.</p>
      )}
      {tree.map((c) => (
        <CommentItem
          key={c.id}
          node={c}
          postAuthorId={postAuthorId}
          currentUserId={currentUserId}
          depth={0}
          onReply={(parentId, content) => add.mutate({ content, parent_id: parentId })}
          onEdit={(id, content) => edit.mutate({ id, content })}
          onDelete={(id) => del.mutate(id)}
        />
      ))}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) add.mutate({ content: text, parent_id: null });
        }}
        className="flex gap-2"
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Write a comment..."
          className="flex-1 rounded-md border border-input bg-card px-3 py-1.5 text-sm outline-none focus:border-ring"
        />
        <button
          type="submit"
          disabled={!text.trim() || add.isPending}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
        >
          Post
        </button>
      </form>
    </div>
  );
}

function CommentItem({
  node: c,
  postAuthorId,
  currentUserId,
  depth,
  onReply,
  onEdit,
  onDelete,
}: {
  node: CommentNode;
  postAuthorId: string;
  currentUserId: string;
  depth: number;
  onReply: (parentId: string, content: string) => void;
  onEdit: (id: string, content: string) => void;
  onDelete: (id: string) => void;
}) {
  const [replying, setReplying] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(c.content);
  const [confirmDel, setConfirmDel] = useState(false);
  const isAuthor = c.user_id === postAuthorId;
  const isMine = c.user_id === currentUserId;
  const indent = Math.min(depth, 4) * 16;
  const edited = c.updated_at && c.updated_at !== c.created_at;

  return (
    <div style={{ marginLeft: indent }} className="rounded-md bg-secondary/40 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-primary">
          {c.author}
          {isAuthor && <span className="text-accent">/Author</span>}
          <span className="ml-2 font-normal text-muted-foreground">
            {new Date(c.created_at).toLocaleDateString()}
            {edited && " · edited"}
          </span>
        </p>
        {isMine && !editing && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setEditText(c.content);
                setEditing(true);
              }}
              className="text-muted-foreground hover:text-primary"
              aria-label="Edit comment"
            >
              <Pencil className="size-3.5" />
            </button>
            <button
              onClick={() => setConfirmDel(true)}
              className="text-muted-foreground hover:text-destructive"
              aria-label="Delete comment"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        )}
      </div>
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (editText.trim()) {
              onEdit(c.id, editText);
              setEditing(false);
            }
          }}
          className="mt-1 space-y-2"
        >
          <textarea
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            rows={2}
            className="w-full resize-none rounded-md border border-input bg-card px-2 py-1 text-sm outline-none focus:border-ring"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="rounded-md border border-border px-2.5 py-1 text-xs"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground"
            >
              Save
            </button>
          </div>
        </form>
      ) : (
        <div className="mt-1 text-sm">
          <Markdown>{c.content}</Markdown>
        </div>
      )}
      <div className="mt-1.5 flex items-center gap-3">
        <CommentVotes commentId={c.id} currentUserId={currentUserId} />
        <button
          onClick={() => setReplying((r) => !r)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
        >
          <CornerDownRight className="size-3" /> Reply
        </button>
      </div>
      {replying && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!replyText.trim()) return;
            onReply(c.id, replyText);
            setReplyText("");
            setReplying(false);
          }}
          className="mt-2 flex gap-2"
        >
          <input
            autoFocus
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            placeholder={`Reply to ${c.author}...`}
            className="flex-1 rounded-md border border-input bg-card px-2 py-1 text-xs outline-none focus:border-ring"
          />
          <button
            type="submit"
            className="rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground"
          >
            Send
          </button>
        </form>
      )}
      {c.children.length > 0 && (
        <div className="mt-2 space-y-2">
          {c.children.map((child) => (
            <CommentItem
              key={child.id}
              node={child}
              postAuthorId={postAuthorId}
              currentUserId={currentUserId}
              depth={depth + 1}
              onReply={onReply}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
      <ConfirmDialog
        open={confirmDel}
        onOpenChange={setConfirmDel}
        title="Delete this comment?"
        description="This can't be undone."
        confirmText="Delete"
        onConfirm={() => {
          onDelete(c.id);
          setConfirmDel(false);
        }}
      />
    </div>
  );
}

function CommentVotes({ commentId, currentUserId }: { commentId: string; currentUserId: string }) {
  const qc = useQueryClient();
  const votes = useQuery({
    queryKey: ["cvotes", commentId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("comment_votes")
        .select("user_id,value")
        .eq("comment_id", commentId);
      if (error) throw error;
      const rows = data ?? [];
      const score = rows.reduce((s, v: any) => s + v.value, 0);
      const mineRow = rows.find((v: any) => v.user_id === currentUserId);
      return { score, mine: (mineRow?.value as 1 | -1 | undefined) ?? 0 };
    },
  });

  const cast = useMutation({
    mutationFn: async (v: 1 | -1) => {
      const current = votes.data?.mine ?? 0;
      if (current === v) {
        const { error } = await supabase
          .from("comment_votes")
          .delete()
          .eq("comment_id", commentId)
          .eq("user_id", currentUserId);
        if (error) throw error;
      } else if (current === 0) {
        const { error } = await supabase
          .from("comment_votes")
          .insert({ comment_id: commentId, user_id: currentUserId, value: v });
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("comment_votes")
          .update({ value: v })
          .eq("comment_id", commentId)
          .eq("user_id", currentUserId);
        if (error) throw error;
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cvotes", commentId] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const mine = votes.data?.mine ?? 0;
  return (
    <div className="flex items-center gap-0.5 text-xs">
      <button
        onClick={() => cast.mutate(1)}
        className={`rounded p-0.5 transition ${mine === 1 ? "text-accent" : "text-muted-foreground hover:text-accent"}`}
        aria-label="Upvote"
      >
        <ArrowUp className="size-3.5" />
      </button>
      <span className="min-w-4 text-center tabular-nums">{votes.data?.score ?? 0}</span>
      <button
        onClick={() => cast.mutate(-1)}
        className={`rounded p-0.5 transition ${
          mine === -1 ? "text-destructive" : "text-muted-foreground hover:text-destructive"
        }`}
        aria-label="Downvote"
      >
        <ArrowDown className="size-3.5" />
      </button>
    </div>
  );
}
