export function pageMeta(title: string, description: string) {
  return { meta: [
    { title: `${title} · The PaperVault` },
    { name: "description", content: description },
    { property: "og:title", content: `${title} · The PaperVault` },
    { property: "og:description", content: description },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary_large_image" },
  ] };
}