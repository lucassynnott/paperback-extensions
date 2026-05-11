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
  const m = url.match(/\/comic\/([^/?#]+)/);
  return m?.[1] ?? "";
}

function chapterIdFromUrl(url: string): string {
  const m = url.match(/\/comic\/[^/]+\/([^/?#]+)/);
  return m?.[1] ?? "";
}

function chapterNumberFromId(id: string): number {
  const m = id.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]!) : 0;
}

export function parseHomeDiscover(
  html: string,
  sectionId: string,
  type: CarouselType,
): DiscoverSectionItem[] {
  const $ = cheerio.load(html);
  const items: DiscoverSectionItem[] = [];

  if (sectionId === "most-viewed") {
    $("li.list-group-item").each((_, el) => {
      const $el = $(el);
      const titleLink = $el.find("h5.media-heading a.chart-title").first();
      const href = titleLink.attr("href") ?? "";
      const mangaId = slugFromUrl(href);
      if (!mangaId) return;
      const title = titleLink.text().trim() || "Unknown Title";
      const img = $el.find("img").first();
      const imageUrl = absoluteUrl(img.attr("src") ?? img.attr("data-src") ?? "");
      items.push({ mangaId, title, imageUrl, type });
    });
  } else if (sectionId === "hot-updates") {
    $("li.schedule-item").each((_, el) => {
      const $el = $(el);
      const nameLink = $el.find(".schedule-name a").first();
      const href = nameLink.attr("href") ?? "";
      const mangaId = slugFromUrl(href);
      if (!mangaId) return;
      const title = nameLink.text().trim() || "Unknown Title";
      const img = $el.find(".schedule-avatar img").first();
      const imageUrl = absoluteUrl(img.attr("src") ?? img.attr("data-src") ?? "");
      items.push({ mangaId, title, imageUrl, type });
    });
  }

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

  $('a[href*="/comic/"]').each((_, el) => {
    const href = $(el).attr("href") ?? "";
    if (!/\/comic\/[^/]+$/.test(href)) return;
    const mangaId = slugFromUrl(href);
    if (!mangaId || seen.has(mangaId)) return;
    seen.add(mangaId);
    const title = $(el).text().trim() || $(el).attr("title") || "Unknown Title";
    const imageUrl = `${BASE_URL}/uploads/manga/${mangaId}/cover/cover_250x350.jpg`;
    items.push({ mangaId, title, imageUrl, type });
  });

  return items;
}

interface SearchSuggestion {
  value: string;
  data: string;
}

export function parseSearchSuggestions(json: string): SearchResultItem[] {
  let parsed: { suggestions?: SearchSuggestion[] };
  try {
    parsed = JSON.parse(json) as { suggestions?: SearchSuggestion[] };
  } catch {
    return [];
  }
  const suggestions = parsed.suggestions ?? [];
  return suggestions.map((s) => ({
    mangaId: s.data,
    title: s.value,
    imageUrl: `${BASE_URL}/uploads/manga/${s.data}/cover/cover_250x350.jpg`,
  }));
}

export function parseMangaDetails(html: string, mangaId: string): SourceManga {
  const $ = cheerio.load(html);

  const primaryTitle =
    $("h2.listmanga-header").first().text().trim() ||
    $("h1, h2").first().text().trim() ||
    "Unknown Title";

  const thumbnailUrl = absoluteUrl(
    $(".boxed img").first().attr("src") ??
      `//readcomicsonline.ru/uploads/manga/${mangaId}/cover/cover_250x350.jpg`,
  );

  let synopsis = "";
  $(".manga.well p").each((_, el) => {
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

  const statusRaw = (meta["status"] ?? "").toLowerCase();
  const status = statusRaw.includes("complete")
    ? "Completed"
    : statusRaw.includes("ongoing")
      ? "Ongoing"
      : statusRaw || "Unknown";

  const author = meta["author(s)"] ?? meta["author"];

  const categoryTags: Tag[] = [];
  $('dl.dl-horizontal dd a[href*="/comic-list/category/"]').each((_, el) => {
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
      artworkUrls: [thumbnailUrl],
      shareUrl: `${BASE_URL}/comic/${mangaId}`,
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

  return chapters;
}

export function parseCategoryPage(html: string): SearchResultItem[] {
  const $ = cheerio.load(html);
  const results: SearchResultItem[] = [];
  const seen = new Set<string>();

  $("div.list-container div.media").each((_, el) => {
    const $el = $(el);
    const link = $el.find("h5.media-heading a.chart-title").first();
    const href = link.attr("href") ?? "";
    const mangaId = (href.match(/\/comic\/([^/?#]+)/) ?? [])[1] ?? "";
    if (!mangaId || seen.has(mangaId)) return;
    seen.add(mangaId);
    const title = link.text().trim() || "Unknown Title";
    const imageUrl = `${BASE_URL}/uploads/manga/${mangaId}/cover/cover_250x350.jpg`;
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

  return pages;
}
