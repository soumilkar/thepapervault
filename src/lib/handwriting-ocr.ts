import { supabase } from "@/integrations/supabase/client";

const MAX_DIM = 2048;

export async function fileToOptimizedBase64(
  file: File,
): Promise<{ base64: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const img = new Image();
      img.onerror = () => {
        const comma = dataUrl.indexOf(",");
        resolve({
          base64: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl,
          mimeType: file.type || "image/jpeg",
        });
      };
      img.onload = () => {
        let { width, height } = img;
        if (width <= MAX_DIM && height <= MAX_DIM && file.size < 2 * 1024 * 1024) {
          const comma = dataUrl.indexOf(",");
          resolve({
            base64: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl,
            mimeType: file.type || "image/jpeg",
          });
          return;
        }
        const scale = Math.min(MAX_DIM / width, MAX_DIM / height, 1);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          const comma = dataUrl.indexOf(",");
          resolve({
            base64: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl,
            mimeType: file.type || "image/jpeg",
          });
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        const compressedUrl = canvas.toDataURL("image/jpeg", 0.88);
        const comma = compressedUrl.indexOf(",");
        resolve({
          base64: comma >= 0 ? compressedUrl.slice(comma + 1) : compressedUrl,
          mimeType: "image/jpeg",
        });
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

export async function transcribeHandwritingFile(file: File): Promise<string> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token ?? "";
  const { base64, mimeType } = await fileToOptimizedBase64(file);

  const res = await fetch("/api/handwriting-ocr", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      imageBase64: base64,
      mimeType,
    }),
  });

  const payload = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
  if (!res.ok) {
    throw new Error(payload.error || "Failed to transcribe handwriting from image.");
  }
  return (payload.text ?? "").trim();
}
