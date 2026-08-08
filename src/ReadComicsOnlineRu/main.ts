/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
  ContentRating,
  CookieStorageInterceptor,
  DiscoverSectionType,
  type Chapter,
  type ChapterDetails,
  type ChapterProviding,
  type CloudflareBypassRequestProviding,
  type Cookie,
  type DiscoverSection,
  type DiscoverSectionItem,
  type DiscoverSectionProviding,
  type Extension,
  type MangaProviding,
  type PagedResults,
  type Request,
  type SearchFilter,
  type SearchQuery,
  type SearchResultItem,
  type SearchResultsProviding,
  type SourceManga,
  type TagSection,
} from "@paperback/types";
import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";

import {
  applyCloudflareCookieUpdate,
  BASE_URL,
  detectCloudflareBrowserUserAgent,
  ReadComicsOnlineRuInterceptor,
  setCloudflareBrowserUserAgent,
} from "./interceptors";
import type { PageMetadata } from "./model";

const FALLBACK_IMAGE_URL =
  "https://lucassynnott.github.io/paperback-extensions/0.9/stable/ReadComicsOnlineRu/static/icon.png";

type ReadComicsOnlineRuImplementation = Extension &
  SearchResultsProviding &
  MangaProviding &
  ChapterProviding &
  CloudflareBypassRequestProviding &
  DiscoverSectionProviding;

export class ReadComicsOnlineRuExtension implements ReadComicsOnlineRuImplementation {
  requestManager = new ReadComicsOnlineRuInterceptor("rco-ru-main");
  cookieStorageInterceptor = new CookieStorageInterceptor({ storage: "stateManager" });

  async initialise(): Promise<void> {
    this.requestManager.registerInterceptor();
    this.cookieStorageInterceptor.registerInterceptor();
    const webViewUserAgent = await detectCloudflareBrowserUserAgent();
    if (webViewUserAgent) setCloudflareBrowserUserAgent(webViewUserAgent);
  }

  async getSearchFilters(): Promise<SearchFilter[]> {
    return [];
  }

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    return [
      {
        id: "hot-comics",
        title: "Hot Comics",
        subtitle: "Trending on readcomicsonline.ru",
        type: DiscoverSectionType.prominentCarousel,
      },
      {
        id: "latest-releases",
        title: "Latest Releases",
        subtitle: "Newest chapter releases",
        type: DiscoverSectionType.chapterUpdates,
      },
      { id: "catalogue", title: "All Comics A–Z", type: DiscoverSectionType.simpleCarousel },
    ];
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: PageMetadata | undefined,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    if (section.id === "hot-comics") return this.getHotComicsSectionItems();
    if (section.id === "latest-releases") return this.getLatestReleaseSectionItems(metadata);
    if (section.id !== "catalogue") return { items: [] };
    return this.getCatalogueSectionItems(metadata);
  }

  async getSearchResults(
    query: SearchQuery,
    metadata?: PageMetadata,
  ): Promise<PagedResults<SearchResultItem>> {
    const page = metadata?.page ?? 1;
    const keyword = query.title.trim();
    const url = keyword
      ? `${BASE_URL}/comic-list?keyword=${encodeURIComponent(keyword)}&page=${page}`
      : `${BASE_URL}/comic-list?sort=az&page=${page}`;
    const $ = await this.fetchCheerio({ url, method: "GET" });
    const parsed = parseCatalogueItems($);
    return {
      items: parsed.items.map((item) => ({
        mangaId: item.mangaId,
        title: item.title,
        imageUrl: item.imageUrl,
      })),
      metadata: parsed.hasNextPage ? { page: page + 1 } : undefined,
    };
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const $ = await this.fetchCheerio({ url: `${BASE_URL}/comic/${mangaId}`, method: "GET" });
    const title = $("h1").first().text().trim() || mangaId;
    const thumbnailUrl = imageUrl(
      pickImageAttr($('img.object-cover, img[class*="object-cover"]').last()),
      coverUrlForManga(mangaId),
    );
    const synopsis =
      $('p[class*="leading-relaxed"][class*="text-slate-300"]').text().trim() || "No synopsis.";
    const author = detailValues($, "Author:").join(", ") || undefined;
    const statusText = $('span[class*="rounded-full"][class*="text-xs"]').text().toLowerCase();
    const status = statusText.includes("ongoing")
      ? "Ongoing"
      : statusText.includes("complete")
        ? "Completed"
        : "Unknown";

    const genres: string[] = [];
    $('div:has(> span):contains("Genres:") a').each((_, element) => {
      const genre = $(element).text().trim();
      if (genre) genres.push(genre);
    });
    const tagGroups: TagSection[] = genres.length
      ? [{ id: "genres", title: "Genres", tags: genres.map((genre) => tagFromTitle(genre)) }]
      : [];

    return {
      mangaId,
      mangaInfo: {
        primaryTitle: title,
        secondaryTitles: [],
        thumbnailUrl,
        synopsis,
        author,
        contentRating: ContentRating.EVERYONE,
        status,
        tagGroups,
        artworkUrls: thumbnailUrl ? [thumbnailUrl] : [],
        shareUrl: `${BASE_URL}/comic/${mangaId}`,
      },
    };
  }

  async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
    const $ = await this.fetchCheerio({
      url: `${BASE_URL}/comic/${sourceManga.mangaId}`,
      method: "GET",
    });
    const chapters: Chapter[] = [];
    $('section.mt-8 a[href*="/comic/"]').each((_, element) => {
      const link = $(element);
      const title = link.find("span").first().text().trim() || link.text().trim();
      const href = link.attr("href") ?? "";
      const chapterId = href
        .replace(/^https?:\/\/readcomicsonline\.ru\/comic\/[^/]+/g, "")
        .replace(/^\/comic\/[^/]+/g, "")
        .trim();
      if (!chapterId) return;
      chapters.push({
        chapterId,
        sourceManga,
        langCode: "EN",
        chapNum: chapterNumberFromTitle(title),
        title,
      });
    });
    return chapters.reverse();
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const $ = await this.fetchCheerio({
      url: `${BASE_URL}/comic/${chapter.sourceManga.mangaId}${chapter.chapterId}`,
      method: "GET",
    });
    const pages: string[] = [];
    $("#reader-all img").each((_, element) => {
      const raw = pickImageAttr($(element));
      const pageUrl = absoluteUrl(raw);
      if (isValidHttpUrl(pageUrl)) pages.push(pageUrl);
    });
    $("#all img, div#all img, .page-chapter img, img.single-page").each((_, element) => {
      const raw = pickImageAttr($(element));
      const pageUrl = absoluteUrl(raw);
      if (isValidHttpUrl(pageUrl)) pages.push(pageUrl);
    });
    $(
      '#reader-all img, #all img, .page-chapter img, img.single-page, img[class*="chapter"], img[class*="page"], img[class*="lazy"]',
    ).each((_, element) => {
      for (const raw of pickAllImageAttrs($(element))) {
        const pageUrl = absoluteUrl(raw);
        if (isValidReaderImageUrl(pageUrl)) pages.push(pageUrl);
      }
    });
    $("#reader-all source[srcset], #reader-all img[srcset], #reader-all img[data-srcset]").each(
      (_, element) => {
        const raw =
          pickSrcsetUrl($(element).attr("srcset") ?? $(element).attr("data-srcset") ?? "") ?? "";
        const pageUrl = absoluteUrl(raw);
        if (isValidHttpUrl(pageUrl)) pages.push(pageUrl);
      },
    );
    pages.push(...parseScriptPageUrls($.html(), chapter.sourceManga.mangaId, chapter.chapterId));
    pages.push(...parseRawImageUrls($.html(), chapter.sourceManga.mangaId, chapter.chapterId));
    pages.push(...parseLooseImageUrls($.html()));
    const uniquePages = [...new Set(pages)];
    if (!uniquePages.length) throw new Error(chapterDebugMessage($, chapter));
    return { id: chapter.chapterId, mangaId: chapter.sourceManga.mangaId, pages: uniquePages };
  }

  getMangaShareUrl(mangaId: string): string {
    return `${BASE_URL}/comic/${mangaId}`;
  }

  async saveCloudflareBypassCookies(cookies: Cookie[]): Promise<void> {
    applyCloudflareCookieUpdate(this.cookieStorageInterceptor, cookies);
  }

  private async getCatalogueSectionItems(
    metadata?: PageMetadata,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    const page = metadata?.page ?? 1;
    const $ = await this.fetchCheerio({
      url: `${BASE_URL}/comic-list?sort=az&page=${page}`,
      method: "GET",
    });
    const parsed = parseCatalogueItems($);
    return { items: parsed.items, metadata: parsed.hasNextPage ? { page: page + 1 } : undefined };
  }

  private async getHotComicsSectionItems(): Promise<PagedResults<DiscoverSectionItem>> {
    const $ = await this.fetchCheerio({ url: BASE_URL, method: "GET" });
    return { items: parseHotComicsItems($) };
  }

  private async getLatestReleaseSectionItems(
    metadata?: PageMetadata,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    const page = metadata?.page ?? 1;
    const $ = await this.fetchCheerio({
      url: `${BASE_URL}/latest-release?page=${page}`,
      method: "GET",
    });
    const items = parseLatestReleaseItems($);
    return { items, metadata: items.length ? { page: page + 1 } : undefined };
  }

  private async fetchCheerio(request: Request): Promise<CheerioAPI> {
    const [response, data] = await Application.scheduleRequest(request);
    if (response.status === 404) throw new Error("Content not found");
    return cheerio.load(Application.arrayBufferToUTF8String(data));
  }
}

interface CatalogueParseResult {
  items: SimpleCatalogueItem[];
  hasNextPage: boolean;
}

interface SimpleCatalogueItem {
  type: "simpleCarouselItem";
  mangaId: string;
  imageUrl: string;
  title: string;
}

type MangaCarouselType = "featuredCarouselItem" | "simpleCarouselItem" | "prominentCarouselItem";

function parseCatalogueItems($: CheerioAPI): CatalogueParseResult {
  const items: SimpleCatalogueItem[] = [];
  $('div.space-y-2.p-3, div[class="space-y-2 p-3"]').each((_, element) => {
    const card = $(element);
    const link = card.find('a[href*="/comic/"]').first();
    const mangaId = mangaIdFromRuHref(link.attr("href") ?? "");
    const title = link.text().trim();
    if (!mangaId || !title) return;
    items.push({
      type: "simpleCarouselItem",
      mangaId,
      title,
      imageUrl: imageUrl(pickImageAttr(card.find("img").first()), coverUrlForManga(mangaId)),
    });
  });

  const currentPage = parseInt($('span[class*="inline-flex"]').first().text()) || 1;
  const hasNextPage =
    $('span[class*="inline-flex"] a').filter((_, element) => {
      const page = parseInt($(element).text());
      return !isNaN(page) && page > currentPage;
    }).length > 0;
  return { items, hasNextPage };
}

function parseHotComicsItems($: CheerioAPI): DiscoverSectionItem[] {
  const heading = $("h1, h2, h3, h4")
    .filter((_, element) => /hot\s+comics/i.test($(element).text()))
    .first();
  const scoped = heading.length
    ? heading.closest("section, main > div, div[class*='container'], div[class*='space-y']")
    : $();
  const items = parseMangaAnchors(
    $,
    scoped.length ? scoped : $("main, body").first(),
    "prominentCarouselItem",
  );
  return items.length
    ? items
    : parseMangaAnchors($, $("main, body").first(), "prominentCarouselItem").slice(0, 20);
}

function parseLatestReleaseItems($: CheerioAPI): DiscoverSectionItem[] {
  const updates: DiscoverSectionItem[] = [];
  const seen = new Set<string>();

  $('a[href*="/comic/"]').each((_, element) => {
    const anchor = $(element);
    const href = anchor.attr("href") ?? "";
    const mangaId = mangaIdFromRuHref(href);
    const chapterId = chapterIdFromRuHref(href);
    if (!mangaId || !chapterId) return;
    const key = `${mangaId}:${chapterId}`;
    if (seen.has(key)) return;
    seen.add(key);

    const container = anchor.closest(
      "article, li, div[class*='space-y'], div[class*='grid'], div[class*='flex']",
    );
    const text = compactWhitespace(container.text() || anchor.text());
    const title = comicTitleFromText(text, anchor.text().trim(), mangaId);
    const subtitle = chapterTitleFromText(text, chapterId);
    updates.push({
      type: "chapterUpdatesCarouselItem",
      mangaId,
      chapterId,
      title,
      subtitle,
      imageUrl: imageUrl(pickImageAttr(container.find("img").first()), coverUrlForManga(mangaId)),
    });
  });

  return updates;
}

function parseMangaAnchors(
  $: CheerioAPI,
  root: cheerio.Cheerio<AnyNode>,
  type: MangaCarouselType,
): DiscoverSectionItem[] {
  const items: DiscoverSectionItem[] = [];
  const seen = new Set<string>();

  root.find('a[href*="/comic/"]').each((_, element) => {
    const anchor = $(element);
    const href = anchor.attr("href") ?? "";
    if (chapterIdFromRuHref(href)) return;
    const mangaId = mangaIdFromRuHref(href);
    if (!mangaId || seen.has(mangaId)) return;
    seen.add(mangaId);

    const container = anchor.closest(
      "article, li, div[class*='space-y'], div[class*='grid'], div[class*='flex']",
    );
    const title = comicTitleFromText(
      compactWhitespace(container.text() || anchor.text()),
      anchor.text().trim() || anchor.attr("title") || "",
      mangaId,
    );
    items.push({
      type,
      mangaId,
      title,
      imageUrl: imageUrl(pickImageAttr(container.find("img").first()), coverUrlForManga(mangaId)),
    });
  });

  return items;
}

function chapterIdFromRuHref(href: string): string {
  return href
    .replace(/^https?:\/\/readcomicsonline\.ru\/comic\/[^/]+/i, "")
    .replace(/^\/comic\/[^/]+/i, "")
    .trim();
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function titleFromMangaId(mangaId: string): string {
  return mangaId
    .split("-")
    .filter((part) => part)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function comicTitleFromText(text: string, anchorText: string, mangaId: string): string {
  const cleaned = compactWhitespace(anchorText || text)
    .replace(/#\s*\d+(?:\.\d+)?\b.*$/i, "")
    .replace(/\bchapter\s+\d+(?:\.\d+)?\b.*$/i, "")
    .replace(/\bissue\s+\d+(?:\.\d+)?\b.*$/i, "")
    .trim();
  return cleaned || titleFromMangaId(mangaId);
}

function chapterTitleFromText(text: string, chapterId: string): string {
  const issue = text.match(/#\s*\d+(?:\.\d+)?\b[^|]*/i)?.[0];
  if (issue) return compactWhitespace(issue);
  const chapter = text.match(/\b(?:chapter|issue)\s+\d+(?:\.\d+)?\b[^|]*/i)?.[0];
  if (chapter) return compactWhitespace(chapter);
  return chapterId.replace(/^\//, "").replace(/-/g, " ");
}

function detailValues($: CheerioAPI, label: string): string[] {
  const values: string[] = [];
  $(`div:has(> span):contains("${label}") a`).each((_, element) => {
    const value = $(element).text().trim();
    if (value) values.push(value);
  });
  return values;
}

function pickImageAttr(image: cheerio.Cheerio<AnyNode>): string {
  return (
    image.attr("data-src") ??
    image.attr("data-original") ??
    image.attr("data-lazy-src") ??
    pickSrcsetUrl(image.attr("data-srcset") ?? image.attr("srcset") ?? "") ??
    image.attr("src") ??
    ""
  ).trim();
}

function pickAllImageAttrs(image: cheerio.Cheerio<AnyNode>): string[] {
  const attrs = [
    "data-src",
    "data-original",
    "data-lazy-src",
    "data-url",
    "data-image",
    "data-full",
    "data-full-size",
    "data-cfsrc",
    "srcset",
    "data-srcset",
    "src",
  ];
  return attrs
    .flatMap((attr) => {
      const value = image.attr(attr) ?? "";
      return attr.includes("srcset") ? [pickSrcsetUrl(value) ?? ""] : [value];
    })
    .map((value) => value.trim())
    .filter((value) => value);
}

function pickSrcsetUrl(srcset: string): string | undefined {
  const first = srcset
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0])
    .find((candidate) => candidate);
  return first || undefined;
}

function absoluteUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return "";
  if (trimmed.startsWith("/")) return `${BASE_URL}${trimmed}`;
  if (/\s/.test(trimmed)) return "";
  return `${BASE_URL}/${trimmed}`;
}

function imageUrl(raw: string, fallback = FALLBACK_IMAGE_URL): string {
  const resolved = absoluteUrl(raw);
  return isValidHttpUrl(resolved) ? resolved : fallback;
}

function coverUrlForManga(mangaId: string): string {
  return `${BASE_URL}/uploads/manga/${mangaId}/cover/cover_250x350.jpg`;
}

function parseScriptPageUrls(html: string, mangaId: string, chapterId: string): string[] {
  const pages: string[] = [];
  const chapterSlug = chapterId.replace(/^\/+/, "").split("/")[0] ?? "";
  const pageScript = html.match(/var\s+pages\s*=\s*(\[[\s\S]*?\])\s*;/)?.[1] ?? "";
  for (const match of pageScript.matchAll(/["']image["']\s*:\s*["']([^"']+)["']/g)) {
    const rawImage = match[1]?.trim();
    if (!rawImage) continue;
    const image = /\.(?:jpe?g|png|webp)(?:\?|$)/i.test(rawImage) ? rawImage : `${rawImage}.jpg`;
    const pageUrl = /^https?:\/\//i.test(image)
      ? image
      : `${BASE_URL}/uploads/manga/${mangaId}/chapters/${chapterSlug}/${image}`;
    if (isValidHttpUrl(pageUrl)) pages.push(pageUrl);
  }
  return pages;
}

function parseRawImageUrls(html: string, mangaId: string, chapterId: string): string[] {
  const pages: string[] = [];
  const chapterSlug = chapterId.replace(/^\/+/, "").split("/")[0] ?? "";
  const decodedHtml = html.replace(/\\\//g, "/").replace(/&amp;/g, "&");

  for (const match of decodedHtml.matchAll(
    /(?:data-src|data-original|data-lazy-src|src|srcset)\s*=\s*["']([^"']+)["']/gi,
  )) {
    const raw = pickSrcsetUrl(match[1] ?? "") ?? match[1] ?? "";
    const pageUrl = absoluteUrl(raw);
    if (isLikelyPageImage(pageUrl, mangaId, chapterSlug)) pages.push(pageUrl);
  }

  for (const match of decodedHtml.matchAll(
    /https?:\/\/[^\s"'<>]+\/(?:uploads\/manga\/[^\s"'<>]+|[^\s"'<>]+\.(?:jpe?g|png|webp)(?:\?[^\s"'<>]*)?)/gi,
  )) {
    const pageUrl = match[0] ?? "";
    if (isLikelyPageImage(pageUrl, mangaId, chapterSlug)) pages.push(pageUrl);
  }

  return pages;
}

function parseLooseImageUrls(html: string): string[] {
  const pages: string[] = [];
  const decodedHtml = html.replace(/\\\//g, "/").replace(/&amp;/g, "&");
  for (const match of decodedHtml.matchAll(
    /(?:data-src|data-original|data-lazy-src|data-url|data-image|data-full|data-full-size|data-cfsrc|src|srcset)\s*=\s*["']([^"']+)["']/gi,
  )) {
    const raw = pickSrcsetUrl(match[1] ?? "") ?? match[1] ?? "";
    const pageUrl = absoluteUrl(raw);
    if (isValidReaderImageUrl(pageUrl)) pages.push(pageUrl);
  }
  return pages;
}

function isValidReaderImageUrl(value: string): boolean {
  if (!isValidHttpUrl(value)) return false;
  const lowered = value.toLowerCase();
  const hasImageExtension = /\.(?:jpe?g|png|webp)(?:\?|$)/i.test(value);
  const isReaderUpload = /\/uploads\/manga\/[^\s"'<>]+\/chapters\//i.test(value);
  if (!hasImageExtension && !isReaderUpload) return false;
  return ![
    "/cover/",
    "/static/icon",
    "favicon",
    "logo",
    "avatar",
    "placeholder",
    "no-image",
    "banner",
    "ads",
    "doubleclick",
    "google",
  ].some((blocked) => lowered.includes(blocked));
}

function isLikelyPageImage(value: string, mangaId: string, chapterSlug: string): boolean {
  if (!isValidReaderImageUrl(value)) return false;
  return (
    value.includes(`/uploads/manga/${mangaId}/chapters/${chapterSlug}/`) ||
    value.includes(`/uploads/manga/${mangaId}/chapters/`) ||
    value.includes("/chapters/")
  );
}

function chapterDebugMessage($: CheerioAPI, chapter: Chapter): string {
  const html = $.html();
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const imageSamples: string[] = [];
  $("img, source").each((_, element) => {
    if (imageSamples.length >= 8) return;
    const node = $(element);
    const attrs = [
      "id",
      "class",
      "src",
      "data-src",
      "data-original",
      "data-lazy-src",
      "data-url",
      "data-image",
      "data-full",
      "data-full-size",
      "data-cfsrc",
      "srcset",
      "data-srcset",
    ]
      .map((name) => attrDebug(node, name))
      .filter((value) => value)
      .join(",");
    imageSamples.push(attrs || "no-attrs");
  });

  const scriptSamples: string[] = [];
  $("script").each((_, element) => {
    if (scriptSamples.length >= 5) return;
    const node = $(element);
    const src = node.attr("src");
    const text = node.text();
    const markers = [
      src ? `src=${compact(src, 90)}` : "inline",
      text.includes("reader") ? "reader" : "",
      text.includes("pages") ? "pages" : "",
      text.includes("uploads/manga") ? "uploads" : "",
      text.includes("chapter") ? "chapter" : "",
    ]
      .filter((value) => value)
      .join("/");
    scriptSamples.push(markers || `inline:${compact(text, 90)}`);
  });

  return [
    "RCO-RU DEBUG 1.0.11: no readable chapter pages",
    `manga=${compact(chapter.sourceManga.mangaId, 80)}`,
    `chapter=${compact(chapter.chapterId, 80)}`,
    `html=${html.length}`,
    `title=${compact($("title").text(), 100)}`,
    `h1=${compact($("h1").first().text(), 80)}`,
    `body=${compact(bodyText, 160)}`,
    `counts(reader-all-img=${$("#reader-all img").length},all-img=${$("#all img").length},page-chapter-img=${$(".page-chapter img").length},img=${$("img").length},source=${$("source").length},script=${$("script").length},uploads=${countMatches(html, "uploads/manga")},pagesVar=${countRegex(html, /var\s+pages\s*=/g)},cf=${cloudflareSignal(html) ? 1 : 0})`,
    `imgs=[${imageSamples.join(" | ") || "none"}]`,
    `scripts=[${scriptSamples.join(" | ") || "none"}]`,
  ].join("; ");
}

function attrDebug(node: cheerio.Cheerio<AnyNode>, name: string): string {
  const value = node.attr(name);
  return value ? `${name}=${compact(value, 90)}` : "";
}

function compact(value: string, maxLength: number): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}

function countMatches(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function countRegex(value: string, regex: RegExp): number {
  return [...value.matchAll(regex)].length;
}

function cloudflareSignal(html: string): boolean {
  return /cloudflare|cf-mitigated|just a moment|checking your browser|are you human/i.test(html);
}

function isValidHttpUrl(value: string): boolean {
  const trimmed = value.trim();
  return /^https?:\/\/[^\s"'<>]+$/i.test(trimmed);
}

function mangaIdFromRuHref(href: string): string {
  return (
    href
      .replace(/^https?:\/\/readcomicsonline\.ru\/comic\//i, "")
      .replace(/^\/comic\//i, "")
      .split(/[?#]/)[0]
      ?.split("/")[0]
      ?.trim() ?? ""
  );
}

function tagFromTitle(title: string) {
  return { id: title.toLowerCase().replace(/[^a-z0-9]/g, ""), title };
}

function chapterNumberFromTitle(title: string): number {
  const regularMatch = title.match(/#(\d+(?:\.\d+)?)/);
  if (regularMatch?.[1]) return parseFloat(regularMatch[1]);
  const annualMatch = title.match(/#(?:-\s*)?Annual\s+(\d+)/i);
  return annualMatch?.[1] ? parseFloat(annualMatch[1]) : 0;
}

export const ReadComicsOnlineRu = new ReadComicsOnlineRuExtension();
