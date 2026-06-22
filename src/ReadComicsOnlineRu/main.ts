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

import { ReadComicsOnlineRuInterceptor } from "./interceptors";
import type { PageMetadata } from "./model";

const BASE_URL = "https://readcomicsonline.ru";
const FALLBACK_IMAGE_URL = `${BASE_URL}/favicon.ico`;

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
  }

  async getSearchFilters(): Promise<SearchFilter[]> {
    return [];
  }

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    return [{ id: "catalogue", title: "Catalogue", type: DiscoverSectionType.simpleCarousel }];
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: PageMetadata | undefined,
  ): Promise<PagedResults<DiscoverSectionItem>> {
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
      $('img.object-cover, img[class*="object-cover"]').last().attr("src") ?? "",
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
    $("#reader-all img[src], #reader-all img[data-src]").each((_, element) => {
      const raw = ($(element).attr("src") ?? $(element).attr("data-src") ?? "").trim();
      const pageUrl = absoluteUrl(raw);
      if (isValidHttpUrl(pageUrl)) pages.push(pageUrl);
    });
    return { id: chapter.chapterId, mangaId: chapter.sourceManga.mangaId, pages };
  }

  getMangaShareUrl(mangaId: string): string {
    return `${BASE_URL}/comic/${mangaId}`;
  }

  async saveCloudflareBypassCookies(cookies: Cookie[]): Promise<void> {
    for (const cookie of this.cookieStorageInterceptor.cookies)
      this.cookieStorageInterceptor.deleteCookie(cookie);
    for (const cookie of cookies) {
      if (cookie.expires && cookie.expires.getTime() <= Date.now()) continue;
      this.cookieStorageInterceptor.setCookie(cookie);
    }
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
      imageUrl: imageUrl(
        card.find("img").first().attr("src") ?? card.find("img").first().attr("data-src") ?? "",
      ),
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

function detailValues($: CheerioAPI, label: string): string[] {
  const values: string[] = [];
  $(`div:has(> span):contains("${label}") a`).each((_, element) => {
    const value = $(element).text().trim();
    if (value) values.push(value);
  });
  return values;
}

function absoluteUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("/")) return `${BASE_URL}${trimmed}`;
  return `${BASE_URL}/${trimmed}`;
}

function imageUrl(raw: string): string {
  const resolved = absoluteUrl(raw);
  return isValidHttpUrl(resolved) ? resolved : FALLBACK_IMAGE_URL;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function mangaIdFromRuHref(href: string): string {
  return href
    .replace(/^https?:\/\/readcomicsonline\.ru\/comic\//, "")
    .replace(/^\/comic\//, "")
    .trim();
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
