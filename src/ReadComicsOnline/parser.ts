/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
  ContentRating,
  type Chapter,
  type DiscoverSectionItem,
  type SearchResultItem,
  type SourceManga,
  type Tag,
  type TagSection,
} from "@paperback/types";
import * as cheerio from "cheerio";

import { BASE_URL } from "./network";

type CarouselType = "featuredCarouselItem" | "simpleCarouselItem" | "prominentCarouselItem";

function absoluteUrl(url: string | undefined): string {
  if (!url) return "";
  const trimmed = url.trim();
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  if (trimmed.startsWith("/")) return `${BASE_URL}${trimmed}`;
  return trimmed;
}

function slugFromUrl(url: string): string {
  const m = url.match(/\/comic\/([^/?#]+)/i);
  return m?.[1] ?? "";
}

function chapterIdFromUrl(url: string): string {
  const m = url.match(/\/comic\/[^/]+\/([^#]+)/i);
  return m?.[1] ?? "";
}

function chapterNumberFromId(id: string): number {
  const m = id.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]!) : 0;
}

function decodedBase64(value: string): string {
  return Application.base64Decode(value) as string;
}

function obfuscateImagePath(url: string): string {
  return url
    .replace(/(?:Q3__swREYT_|cK__Od24cS_)/g, "d")
    .replace(/b/g, "pw_.g28x")
    .replace(/h/g, "d2pr.x_27");
}

function decodeReadComicImageUrl(url: string): string {
  let working = url.replace(/pw_\.g28x/g, "b").replace(/d2pr\.x_27/g, "h");
  if (working.startsWith("https")) return working;

  const queryIndex = working.indexOf("?");
  const query = queryIndex >= 0 ? working.substring(queryIndex) : "";
  const base = working.includes("=s0?")
    ? working.substring(0, working.indexOf("=s0?"))
    : working.substring(0, working.indexOf("=s1600?"));
  const step1 = base.substring(15, 33) + base.substring(50);
  const step2 =
    step1.substring(0, step1.length - 11) + step1[step1.length - 2] + step1[step1.length - 1];
  let decoded = decodedBase64(step2);
  decoded = decoded.substring(0, 13) + decoded.substring(17);
  decoded = decoded.substring(0, decoded.length - 2) + (working.includes("=s0") ? "=s0" : "=s1600");
  return `https://2.bp.blogspot.com/${decoded}${query}`;
}

export function parseHomeDiscover(
  html: string,
  sectionId: string,
  type: CarouselType,
): DiscoverSectionItem[] {
  if (sectionId === "most-viewed") return parseListPage(html, type);

  const $ = cheerio.load(html);
  const items: DiscoverSectionItem[] = [];
  $(".rightBox li a[href*='/Comic/'], li.schedule-item a[href*='/comic/']").each((_, el) => {
    const anchor = $(el);
    const href = anchor.attr("href") ?? "";
    const mangaId = slugFromUrl(href);
    if (!mangaId) return;
    const container = anchor.closest("li, .schedule-item");
    const title = anchor.text().trim() || container.text().trim() || "Unknown Title";
    const imageUrl = absoluteUrl(container.find("img").first().attr("src") ?? "");
    items.push({ mangaId, title, imageUrl, type });
  });

  const seen = new Set<string>();
  return items.filter((item) => {
    const id = "mangaId" in item ? item.mangaId : undefined;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function parseListPage(html: string, type: CarouselType): DiscoverSectionItem[] {
  const $ = cheerio.load(html);
  const items: DiscoverSectionItem[] = [];
  const seen = new Set<string>();

  $(".item-list .list, .list-comic .item, a[href*='/comic/'], a[href*='/Comic/']").each((_, el) => {
    const node = $(el);
    const anchor = node.is("a") ? node : node.find("a[href*='/Comic/'], a[href*='/comic/']").last();
    const href = anchor.attr("href") ?? "";
    if (/\/Comic\/[^/]+\//i.test(href)) return;
    const mangaId = slugFromUrl(href);
    if (!mangaId || seen.has(mangaId)) return;
    seen.add(mangaId);

    const container = node.is("a") ? anchor.closest(".list, .item, li") : node;
    const title =
      container.find(".title, h3, h4").first().text().trim() ||
      anchor.text().trim() ||
      anchor.attr("title") ||
      "Unknown Title";
    const imageUrl = absoluteUrl(
      container.find("img").first().attr("src") ?? anchor.find("img").first().attr("src") ?? "",
    );
    items.push({ mangaId, title, imageUrl, type });
  });

  return items;
}

interface SearchSuggestion {
  value: string;
  data: string;
}

export function parseSearchSuggestions(body: string): SearchResultItem[] {
  if (!body.trim().startsWith("{")) return parseCategoryPage(body);

  let parsed: { suggestions?: SearchSuggestion[] };
  try {
    parsed = JSON.parse(body) as { suggestions?: SearchSuggestion[] };
  } catch {
    return [];
  }
  const suggestions = parsed.suggestions ?? [];
  return suggestions.map((s) => ({
    mangaId: s.data,
    title: s.value,
    imageUrl: "",
  }));
}

export function parseMangaDetails(html: string, mangaId: string): SourceManga {
  const $ = cheerio.load(html);

  const primaryTitle = (
    $("h1, h2.listmanga-header, .heading h1").first().text().trim() ||
    $("title").text().split("|")[0]?.trim() ||
    "Unknown Title"
  ).replace(/\s+comic$/i, "");

  const thumbnailUrl = absoluteUrl(
    $(".cover img, .boxed img, .rightBox img").first().attr("src") ?? "",
  );

  let synopsis = "";
  $(".manga.well p, .info p:not(:has(span))").each((_, el) => {
    synopsis += $(el).text().trim() + "\n\n";
  });
  synopsis = Application.decodeHTMLEntities(synopsis.trim() || "No synopsis.");

  const meta: Record<string, string> = {};
  $("dl.dl-horizontal dt").each((_, el) => {
    const key = $(el)
      .text()
      .trim()
      .replace(/[:\s]+$/, "");
    const value = $(el).next("dd").text().trim();
    meta[key.toLowerCase()] = value;
  });
  $(".info p:has(span)").each((_, el) => {
    const key = $(el)
      .find("span")
      .first()
      .text()
      .trim()
      .replace(/[:\s]+$/, "")
      .toLowerCase();
    const value = $(el).clone().children("span").remove().end().text().trim();
    if (key) meta[key] = value;
  });

  const statusRaw = (meta["status"] ?? "").toLowerCase();
  const status = statusRaw.includes("complete")
    ? "Completed"
    : statusRaw.includes("ongoing")
      ? "Ongoing"
      : statusRaw || "Unknown";

  const author = meta["author(s)"] ?? meta["author"] ?? meta["writer"];

  const categoryTags: Tag[] = [];
  $(
    'dl.dl-horizontal dd a[href*="/comic-list/category/"], .info p:has(span:contains("Genres")) a',
  ).each((_, el) => {
    const id = $(el).attr("href")?.split("/").pop() ?? "";
    const title = $(el).text().trim();
    if (id && title) categoryTags.push({ id, title });
  });

  const tagTags: Tag[] = [];
  $("dl.dl-horizontal dd.tag-links a").each((_, el) => {
    const id = $(el).attr("href")?.split("/").pop() ?? "";
    const title = $(el).text().trim();
    if (id && title) tagTags.push({ id, title });
  });

  const tagGroups: TagSection[] = [];
  if (categoryTags.length)
    tagGroups.push({ id: "categories", title: "Categories", tags: categoryTags });
  if (tagTags.length) tagGroups.push({ id: "tags", title: "Tags", tags: tagTags });

  return {
    mangaId,
    mangaInfo: {
      thumbnailUrl,
      synopsis,
      primaryTitle,
      secondaryTitles: [],
      contentRating: ContentRating.EVERYONE,
      status,
      author,
      tagGroups,
      artworkUrls: thumbnailUrl ? [thumbnailUrl] : [],
      shareUrl: `${BASE_URL}/Comic/${mangaId}`,
    },
  };
}

export function parseChapters(html: string, sourceManga: SourceManga): Chapter[] {
  const $ = cheerio.load(html);
  const chapters: Chapter[] = [];

  $("ul.chapters li").each((_, el) => {
    const $el = $(el);
    const link = $el.find("a").first();
    const href = link.attr("href") ?? "";
    const chapterId = chapterIdFromUrl(href);
    if (!chapterId) return;

    const title = link.text().trim();
    const dateText = $el.find(".date-chapter-title-rtl").text().trim();
    const publishDate = dateText ? new Date(dateText) : undefined;

    chapters.push({
      chapterId,
      sourceManga,
      langCode: "EN",
      chapNum: chapterNumberFromId(chapterId),
      title,
      publishDate: publishDate && !isNaN(publishDate.getTime()) ? publishDate : undefined,
    });
  });

  $(".list a[href*='/Issue-'], table.listing a[href*='/Issue-']").each((_, el) => {
    const link = $(el);
    const href = link.attr("href") ?? "";
    const chapterId = chapterIdFromUrl(href);
    if (!chapterId) return;
    const row = link.closest(".list, tr");
    const dateText = row.find(".col-2, td").last().text().trim();
    const publishDate = dateText ? new Date(dateText) : undefined;
    chapters.push({
      chapterId,
      sourceManga,
      langCode: "EN",
      chapNum: chapterNumberFromId(chapterId),
      title: link.text().trim(),
      publishDate: publishDate && !isNaN(publishDate.getTime()) ? publishDate : undefined,
    });
  });

  return chapters;
}

export function parseCategoryPage(html: string): SearchResultItem[] {
  const $ = cheerio.load(html);
  const results: SearchResultItem[] = [];
  const seen = new Set<string>();

  $("div.list-container div.media, .item-list .list, .list-comic .item").each((_, el) => {
    const $el = $(el);
    const link = $el
      .find("h5.media-heading a.chart-title, a[href*='/Comic/'], a[href*='/comic/']")
      .last();
    const href = link.attr("href") ?? "";
    const mangaId = (href.match(/\/comic\/([^/?#]+)/i) ?? [])[1] ?? "";
    if (!mangaId || seen.has(mangaId)) return;
    seen.add(mangaId);
    const title =
      $el.find(".title, h3, h4").first().text().trim() || link.text().trim() || "Unknown Title";
    const imageUrl = absoluteUrl($el.find("img").first().attr("src") ?? "");
    results.push({ mangaId, title, imageUrl });
  });

  return results;
}

export function parseChapterPages(html: string): string[] {
  const $ = cheerio.load(html);
  const pages: string[] = [];

  $("img[data-src]").each((_, el) => {
    const raw = $(el).attr("data-src")?.trim();
    if (!raw) return;
    if (!/uploads\/manga\/.*\/chapters\//.test(raw)) return;
    pages.push(absoluteUrl(raw));
  });

  if (pages.length === 0) {
    $("img.scan-page").each((_, el) => {
      const raw = $(el).attr("src")?.trim();
      if (raw) pages.push(absoluteUrl(raw));
    });
  }

  if (pages.length === 0) {
    const script = $("script")
      .filter((_, el) => ($(el).html() ?? "").includes("#divImage"))
      .first()
      .html();
    if (script) {
      const calledVars = [...script.matchAll(/func\w+\(([_c]\w+),\s*''\)/g)].map((m) => m[1]);
      const targetVar = calledVars.find((name) => name?.startsWith("_"));
      if (targetVar) {
        const escapedVar = targetVar.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&");
        const pthRe = new RegExp(
          `pth\\s*=\\s*'([^']+)'[\\s\\S]*?${escapedVar}\\.push\\(pth\\)`,
          "g",
        );
        for (const match of script.matchAll(pthRe))
          pages.push(decodeReadComicImageUrl(obfuscateImagePath(match[1]!)));
      }
    }
  }

  return pages;
}
