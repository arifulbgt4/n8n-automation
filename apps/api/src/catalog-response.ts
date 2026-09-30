import type { CatalogItem, CatalogItemMedia } from "./catalog-lookup.js";

export type CatalogResponseMessage =
  | { type: "text"; text: string }
  | { type: "media"; assetId: string; caption?: string | null };

type BuildCatalogResponseInput = {
  rawMessages: unknown[];
  items: CatalogItem[];
  explicitMediaRequest: boolean;
  specificMediaRequest?: boolean;
  imageLimit: number;
  totalMessageLimit?: number;
};

function orderedCatalogImages(items: CatalogItem[]): Array<{ item: CatalogItem; media: CatalogItemMedia }> {
  const primary: Array<{ item: CatalogItem; media: CatalogItemMedia }> = [];
  const gallery: Array<{ item: CatalogItem; media: CatalogItemMedia }> = [];
  for (const item of items) {
    const images = Array.isArray(item.media) ? item.media : [];
    if (images[0]) primary.push({ item, media: images[0] });
    for (const media of images.slice(1)) gallery.push({ item, media });
  }
  return [...primary, ...gallery];
}

function normalizedCaption(value: unknown, fallback: string | null): string | null {
  const caption = typeof value === "string" ? value.trim() : "";
  if (caption) return caption.slice(0, 2000);
  return fallback?.trim().slice(0, 2000) || null;
}

export function buildGroundedCatalogResponse(input: BuildCatalogResponseInput): CatalogResponseMessage[] {
  const imageLimit = Math.max(1, Math.min(20, Math.floor(input.imageLimit)));
  const totalLimit = Math.max(1, Math.min(20, Math.floor(input.totalMessageLimit ?? 20)));
  const highestRelevance = Math.max(...input.items.map((item) => Number(item.relevance_score ?? 0)),0);
  const selectedItems = input.specificMediaRequest
    ? input.items.filter((item) => Number(item.relevance_score ?? 0) === highestRelevance)
    : input.items;
  const candidates = orderedCatalogImages(selectedItems);
  const allowed = new Map(candidates.map(({ item, media }) => [media.assetId, item]));
  const texts: CatalogResponseMessage[] = [];
  const mediaMessages: CatalogResponseMessage[] = [];
  const seenAssets = new Set<string>();

  for (const value of input.rawMessages.slice(0, 20)) {
    if (!value || typeof value !== "object") continue;
    const message = value as Record<string, unknown>;
    if (message.type === "text" && typeof message.text === "string" && message.text.trim()) {
      texts.push({ type: "text", text: message.text.trim().slice(0, 20_000) });
      continue;
    }
    if (message.type !== "media" || typeof message.assetId !== "string") continue;
    const item = allowed.get(message.assetId);
    if (!item || seenAssets.has(message.assetId) || mediaMessages.length >= imageLimit) continue;
    seenAssets.add(message.assetId);
    mediaMessages.push({
      type: "media",
      assetId: message.assetId,
      caption: normalizedCaption(null, item.title),
    });
  }

  if (input.explicitMediaRequest) {
    for (const { item, media } of candidates) {
      if (mediaMessages.length >= imageLimit) break;
      if (seenAssets.has(media.assetId)) continue;
      seenAssets.add(media.assetId);
      mediaMessages.push({ type: "media", assetId: media.assetId, caption: normalizedCaption(null, item.title) });
    }
    const textLimit = Math.max(0, totalLimit - mediaMessages.length);
    return [...texts.slice(0, textLimit), ...mediaMessages.slice(0, totalLimit)];
  }

  return [...texts, ...mediaMessages].slice(0, totalLimit);
}
