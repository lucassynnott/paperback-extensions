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
    return [
      { id: "popular", title: "Popular", type: DiscoverSectionType.featured },
      { id: "hot", title: "Hot Comic Updates", type: DiscoverSectionType.simpleCarousel },
      { id: "latest", title: "Latest Comic Updates", type: DiscoverSectionType.simpleCarousel },
    ];
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: PageMetadata | undefined,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    switch (section.id) {
      case "popular":
        return this.getPopularSectionItems();
      case "hot":
        return this.getHotSectionItems(metadata);
      case "latest":
        return this.getLatestSectionItems(metadata);
      default:
        return { items: [] };
    }
  }

  async getSearchResults(
    query: SearchQuery,
    metadata?: PageMetadata,
  ): Promise<PagedResults<SearchResultItem>> {
    const page = metadata?.page ?? 1;
    const [, data] = await Application.scheduleRequest({
      url: `${BASE_URL}/search?query=${encodeURIComponent(query.title.trim())}`,
      method: "GET",
    });
    const responseText = Application.arrayBufferToUTF8String(data);
    let allItems: SearchResultItem[] = [];
    try {
      const parsed = JSON.parse(responseText) as {
        suggestions?: { value: string; data: string }[];
      };
      allItems = (parsed.suggestions ?? []).map((item) => ({
        mangaId: item.data,
        title: item.value,
        imageUrl: `${BASE_URL}/uploads/manga/${item.data}/cover/cover_250x350.jpg`,
      }));
    } catch {
      allItems = this.parseMediaSearchResults(cheerio.load(responseText));
    }
    const start = (page - 1) * 10;
    const items = allItems.slice(start, start + 10);
    return { items, metadata: start + 10 < allItems.length ? { page: page + 1 } : undefined };
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const $ = await this.fetchCheerio({ url: `${BASE_URL}/comic/${mangaId}`, method: "GET" });
    const title = $("h2.listmanga-header").first().text().trim() || mangaId;
    const rawImage = $(".boxed img").attr("src") ?? "";
    const thumbnailUrl = absoluteUrl(rawImage);
    const synopsis = $(".manga.well p").text().trim() || "No synopsis.";
    const author = $("dt:contains('Author') + dd a").text().trim() || undefined;
    const ratingMatch = $(".rating")
      .text()
      .match(/Average\s*([\d.]+)/);
    const rating = ratingMatch?.[1] ? parseFloat(ratingMatch[1]) * 20 : undefined;
    const statusText = $("dt:contains('Status') + dd span").text().toLowerCase();
    const status = statusText.includes("ongoing")
      ? "Ongoing"
      : statusText.includes("complete")
        ? "Completed"
        : "Unknown";
    const tags: TagSection[] = [];
    const genres: string[] = [];
    $("dd.tag-links a").each((_, element) => {
      const genre = $(element).text().trim();
      if (genre) genres.push(genre);
    });
    if (genres.length)
      tags.push({ id: "genres", title: "Tags", tags: genres.map((genre) => tagFromTitle(genre)) });
    return {
      mangaId,
      mangaInfo: {
        primaryTitle: title,
        secondaryTitles: [],
        thumbnailUrl,
        synopsis,
        author,
        rating,
        contentRating: ContentRating.EVERYONE,
        status,
        tagGroups: tags,
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
    $(".chapters li").each((_, element) => {
      const chapterElement = $(element);
      const link = chapterElement.find("h5.chapter-title-rtl a");
      const title = link.text().trim();
      const href = link.attr("href") ?? "";
      const chapterId = href.replace(/^https?:\/\/readcomicsonline\.ru\/comic\/[^/]+/g, "").trim();
      if (!chapterId) return;
      chapters.push({
        chapterId,
        sourceManga,
        langCode: "EN",
        chapNum: chapterNumberFromTitle(title),
        title,
        publishDate: parseRuDate(chapterElement.find(".date-chapter-title-rtl").text().trim()),
      });
    });
    return chapters.sort(
      (a, b) => (a.publishDate?.getTime() ?? 0) - (b.publishDate?.getTime() ?? 0),
    );
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const $ = await this.fetchCheerio({
      url: `${BASE_URL}/comic/${chapter.sourceManga.mangaId}${chapter.chapterId}`,
      method: "GET",
    });
    const pages: string[] = [];
    $("#all img").each((_, element) => {
      const dataSrc = $(element).attr("data-src")?.trim();
      if (dataSrc) pages.push(absoluteUrl(dataSrc));
    });
    if (!pages.length) {
      const single = $("#ppp img").attr("src")?.trim();
      if (single) pages.push(absoluteUrl(single));
    }
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

  private async getHotSectionItems(
    _metadata?: PageMetadata,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    const $ = await this.fetchCheerio({ url: BASE_URL, method: "GET" });
    return { items: parseScheduleItems($) };
  }

  private async getPopularSectionItems(): Promise<PagedResults<DiscoverSectionItem>> {
    const $ = await this.fetchCheerio({ url: BASE_URL, method: "GET" });
    const items: DiscoverSectionItem[] = [];
    $(".list-group-item").each((_, element) => {
      const unit = $(element);
      const link = unit.find(".chart-title");
      const mangaId = mangaIdFromRuHref(link.attr("href") ?? "");
      const title = link.text().trim();
      if (!mangaId || !title) return;
      items.push({
        type: "featuredCarouselItem",
        mangaId,
        imageUrl: absoluteUrl(
          (unit.find("img").attr("src") ?? "").replace("cover_thumb.jpg", "cover_250x350.jpg"),
        ),
        title,
        supertitle: unit.find(".fa-eye").parent().text().trim() || undefined,
      });
    });
    return { items };
  }

  private async getLatestSectionItems(
    _metadata?: PageMetadata,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    const $ = await this.fetchCheerio({ url: BASE_URL, method: "GET" });
    const items: DiscoverSectionItem[] = [];
    $(".col-sm-6 .media").each((_, element) => {
      const unit = $(element);
      const link = unit.find(".media-heading a");
      const mangaId = mangaIdFromRuHref(link.attr("href") ?? "");
      const title = link.text().trim();
      if (!mangaId || !title) return;
      items.push({
        type: "simpleCarouselItem",
        mangaId,
        imageUrl: absoluteUrl(
          (unit.find(".media-left img").attr("src") ?? "").replace(
            "cover_thumb.jpg",
            "cover_250x350.jpg",
          ),
        ),
        title,
        subtitle:
          unit.find(".media-body div a[href*='/comic/']").first().text().trim() || undefined,
      });
    });
    return { items };
  }

  private parseMediaSearchResults($: CheerioAPI): SearchResultItem[] {
    const items: SearchResultItem[] = [];
    $(".media").each((_, element) => {
      const unit = $(element);
      const link = unit.find(".media-heading a");
      const mangaId = mangaIdFromRuHref(link.attr("href") ?? "");
      const title = link.text().trim();
      if (!mangaId || !title) return;
      items.push({
        mangaId,
        title,
        imageUrl: absoluteUrl(unit.find(".media-left img").attr("src") ?? ""),
        subtitle:
          unit.find(".media-body div a[href*='/comic/']").first().text().trim() || undefined,
      });
    });
    return items;
  }

  private async fetchCheerio(request: Request): Promise<CheerioAPI> {
    const [response, data] = await Application.scheduleRequest(request);
    if (response.status === 404) throw new Error("Content not found");
    return cheerio.load(Application.arrayBufferToUTF8String(data));
  }
}

function parseScheduleItems($: CheerioAPI): DiscoverSectionItem[] {
  const items: DiscoverSectionItem[] = [];
  $("#schedule .schedule-item").each((_, element) => {
    const unit = $(element);
    const link = unit.find(".schedule-name a");
    const mangaId = mangaIdFromRuHref(link.attr("href") ?? "");
    const title = link.text().trim();
    if (!mangaId || !title) return;
    items.push({
      type: "simpleCarouselItem",
      mangaId,
      imageUrl: absoluteUrl(unit.find(".schedule-avatar img").attr("src") ?? ""),
      title,
      subtitle: unit.find(".schedule-date a").text().trim() || undefined,
    });
  });
  return items;
}

function absoluteUrl(raw: string): string {
  if (!raw) return "";
  if (raw.startsWith("//")) return `https:${raw}`;
  if (raw.startsWith("/")) return `${BASE_URL}${raw}`;
  return raw;
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

function parseRuDate(value: string): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? undefined : parsed;
}

export const ReadComicsOnlineRu = new ReadComicsOnlineRuExtension();
