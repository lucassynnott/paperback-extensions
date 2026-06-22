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

import { URLBuilder } from "../utils/url-builder/base";
import { CaveInterceptor } from "./interceptors";
import type { PageMetadata } from "./model";

const BASE_URL = "https://batcave.biz";

type BatcaveImplementation = Extension &
  SearchResultsProviding &
  MangaProviding &
  ChapterProviding &
  CloudflareBypassRequestProviding &
  DiscoverSectionProviding;

export class BatcaveExtension implements BatcaveImplementation {
  requestManager = new CaveInterceptor("batcave-main");
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
      { id: "latest", title: "New Comics", type: DiscoverSectionType.simpleCarousel },
      { id: "catalogue", title: "Catalogue", type: DiscoverSectionType.simpleCarousel },
      { id: "genres", title: "Genres", type: DiscoverSectionType.genres },
    ];
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: PageMetadata | undefined,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    switch (section.id) {
      case "popular":
        return this.getPopularSectionItems();
      case "latest":
        return this.getLatestSectionItems(metadata);
      case "catalogue":
        return this.getCatalogueSectionItems(metadata);
      case "genres":
        return this.getGenreSectionItems();
      default:
        return { items: [] };
    }
  }

  async getSearchResults(
    query: SearchQuery,
    metadata?: PageMetadata,
  ): Promise<PagedResults<SearchResultItem>> {
    const page = metadata?.page ?? 1;
    if (!query.title.trim()) {
      const catalogue = await this.getCatalogueSectionItems(metadata);
      return {
        items: catalogue.items.flatMap((item) =>
          item.type === "simpleCarouselItem"
            ? [
                {
                  mangaId: item.mangaId,
                  title: item.title,
                  imageUrl: item.imageUrl,
                  subtitle: item.subtitle,
                },
              ]
            : [],
        ),
        metadata: catalogue.metadata,
      };
    }

    const urlBuilder = new URLBuilder(BASE_URL).addPath("search").addPath(query.title.trim());
    if (page > 1) urlBuilder.addPath("page").addPath(String(page));

    const $ = await this.fetchCheerio({ url: urlBuilder.build(), method: "GET" });
    return this.parseReadedSearchResults($, page);
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const $ = await this.fetchCheerio({ url: `${BASE_URL}/${mangaId}.html`, method: "GET" });
    const title = $("h1").first().text().trim() || mangaId;
    const rawImage = $(".page__poster img").attr("src") ?? "";
    const thumbnailUrl = absoluteUrl(rawImage);
    const synopsis = $(".page__text").text().trim() || "No synopsis.";
    const ratingMatch = $(".page__rating-votes")
      .text()
      .match(/(\d+(?:\.\d+)?)/);
    const rating = ratingMatch?.[1] ? parseFloat(ratingMatch[1]) : undefined;
    const statusText = $(".page__list li")
      .filter((_, el) => $(el).text().includes("Release type"))
      .first()
      .text()
      .toLowerCase();
    const status = statusText.includes("completed")
      ? "Completed"
      : statusText.includes("ongoing")
        ? "Ongoing"
        : "Unknown";

    const genres: string[] = [];
    $(".page__tags a").each((_, element) => {
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
        rating,
        contentRating: ContentRating.EVERYONE,
        status,
        tagGroups,
        artworkUrls: thumbnailUrl ? [thumbnailUrl] : [],
        shareUrl: `${BASE_URL}/${mangaId}.html`,
      },
    };
  }

  async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
    const $ = await this.fetchCheerio({
      url: `${BASE_URL}/${sourceManga.mangaId}.html`,
      method: "GET",
    });
    const chapters: Chapter[] = [];
    const chapterScript = $(".page__chapters-list script")
      .filter((_, el) => ($(el).html() ?? "").includes("__DATA__"))
      .first()
      .html();
    const jsonMatch = chapterScript?.match(/window\.__DATA__\s*=\s*({[\s\S]*?});/);
    if (!jsonMatch?.[1]) return chapters;

    try {
      const parsed = JSON.parse(jsonMatch[1]) as { chapters?: BatcaveChapterData[] };
      for (const chapter of parsed.chapters ?? []) {
        if (!chapter.id) continue;
        chapters.push({
          chapterId: String(chapter.id),
          sourceManga,
          langCode: "EN",
          chapNum: chapter.posi ?? 0,
          title: chapter.title || `Issue ${chapter.posi ?? ""}`.trim(),
          publishDate: parseBatcaveDate(chapter.date),
        });
      }
    } catch (error) {
      console.error("Batcave chapter JSON parse failed", error);
    }
    return chapters;
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const seriesId = chapter.sourceManga.mangaId.split("-")[0] ?? chapter.sourceManga.mangaId;
    const $ = await this.fetchCheerio({
      url: `${BASE_URL}/reader/${seriesId}/${chapter.chapterId}`,
      method: "GET",
    });
    const pages: string[] = [];
    const scriptData = $("script")
      .filter((_, el) => ($(el).html() ?? "").includes("__DATA__"))
      .first()
      .html();
    const jsonMatch = scriptData?.match(/window\.__DATA__\s*=\s*({[\s\S]*?})\s*;/);
    if (jsonMatch?.[1]) {
      try {
        const data = JSON.parse(jsonMatch[1]) as { images?: string[] };
        for (const image of data.images ?? []) pages.push(image.replace(/\\\//g, "/"));
      } catch (error) {
        console.error("Batcave image JSON parse failed", error);
      }
    }
    return { id: chapter.chapterId, mangaId: chapter.sourceManga.mangaId, pages };
  }

  getMangaShareUrl(mangaId: string): string {
    return `${BASE_URL}/${mangaId}.html`;
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
    const collectedIds = metadata?.collectedIds ?? [];
    const urlBuilder = new URLBuilder(BASE_URL).addPath("comix");
    if (page > 1) urlBuilder.addPath("page").addPath(String(page));
    const $ = await this.fetchCheerio({ url: urlBuilder.build(), method: "GET" });
    const items = this.parseReadedItems($, collectedIds);
    return {
      items,
      metadata: hasNextBatcavePage($) ? { page: page + 1, collectedIds } : undefined,
    };
  }

  private async getPopularSectionItems(): Promise<PagedResults<DiscoverSectionItem>> {
    const $ = await this.fetchCheerio({ url: BASE_URL, method: "GET" });
    const items: DiscoverSectionItem[] = [];
    $(".poster.grid-item").each((_, element) => {
      const unit = $(element);
      const rawMangaId = unit.attr("href") ?? "";
      const mangaId = mangaIdFromBatcaveHref(rawMangaId);
      const title = unit.find(".poster__title").text().trim();
      if (!mangaId || !title) return;
      items.push({
        type: "featuredCarouselItem",
        mangaId,
        imageUrl: absoluteUrl(unit.find(".poster__img img").attr("data-src") ?? ""),
        title,
        supertitle: unit.find(".poster__label--rate").text().trim() || undefined,
      });
    });
    return { items };
  }

  private async getLatestSectionItems(
    metadata?: PageMetadata,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    const page = metadata?.page ?? 1;
    const collectedIds = metadata?.collectedIds ?? [];
    const $ = await this.fetchCheerio({
      url: page > 1 ? `${BASE_URL}/page/${page}/` : BASE_URL,
      method: "GET",
    });
    const items: DiscoverSectionItem[] = [];
    $("#content-load .latest.grid-item").each((_, element) => {
      const unit = $(element);
      const rawMangaId = unit.find(".latest__title a").attr("href") ?? "";
      const mangaId = mangaIdFromBatcaveHref(rawMangaId);
      const title = unit.find(".latest__title a").clone().children().remove().end().text().trim();
      if (!mangaId || !title || collectedIds.includes(mangaId)) return;
      collectedIds.push(mangaId);
      items.push({
        type: "simpleCarouselItem",
        mangaId,
        imageUrl: absoluteUrl(unit.find(".latest__img img").attr("src") ?? ""),
        title,
        subtitle: unit.find(".latest__chapter a").text().trim() || undefined,
      });
    });
    return {
      items,
      metadata: $(".pagination__btn-loader a").length
        ? { page: page + 1, collectedIds }
        : undefined,
    };
  }

  private async getGenreSectionItems(): Promise<PagedResults<DiscoverSectionItem>> {
    const genres = [
      "Action",
      "Adventure",
      "Anthology",
      "Biography",
      "Comedy",
      "Crime",
      "Drama",
      "Fantasy",
      "Horror",
      "Manga",
      "Mystery",
      "Sci-Fi",
      "Superhero",
      "Thriller",
    ];
    return {
      items: genres.map((genre) => ({
        type: "genresCarouselItem",
        searchQuery: { title: genre, filters: [] },
        name: genre,
      })),
    };
  }

  private parseReadedSearchResults($: CheerioAPI, page: number): PagedResults<SearchResultItem> {
    const items: SearchResultItem[] = [];
    $(".readed").each((_, element) => {
      const unit = $(element);
      const link = unit.find(".readed__title a");
      const mangaId = mangaIdFromBatcaveHref(link.attr("href") ?? "");
      const title = link.text().trim();
      if (!mangaId || !title) return;
      items.push({
        mangaId,
        title,
        imageUrl: absoluteUrl(
          unit.find(".readed__img img").attr("data-src") ??
            unit.find(".readed__img img").attr("src") ??
            "",
        ),
        subtitle:
          unit.find(".readed__info li:last-child").text().replace("Last issue:", "").trim() ||
          undefined,
      });
    });
    return { items, metadata: hasNextBatcavePage($) ? { page: page + 1 } : undefined };
  }

  private parseReadedItems($: CheerioAPI, collectedIds: string[]): DiscoverSectionItem[] {
    const items: DiscoverSectionItem[] = [];
    $("#dle-content .readed, .readed").each((_, element) => {
      const unit = $(element);
      const link = unit.find(".readed__title a");
      const mangaId = mangaIdFromBatcaveHref(link.attr("href") ?? "");
      const title = link.text().trim();
      if (!mangaId || !title || collectedIds.includes(mangaId)) return;
      collectedIds.push(mangaId);
      items.push({
        type: "simpleCarouselItem",
        mangaId,
        title,
        imageUrl: absoluteUrl(
          unit.find(".readed__img img").attr("data-src") ??
            unit.find(".readed__img img").attr("src") ??
            "",
        ),
        subtitle:
          unit.find(".readed__info li:last-child").text().replace("Last issue:", "").trim() ||
          undefined,
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

interface BatcaveChapterData {
  id: number;
  title?: string;
  posi?: number;
  date?: string;
}

function absoluteUrl(raw: string): string {
  if (!raw) return "";
  if (raw.startsWith("//")) return `https:${raw}`;
  if (raw.startsWith("/")) return `${BASE_URL}${raw}`;
  return raw;
}

function mangaIdFromBatcaveHref(href: string): string {
  return href
    .replace(/^https?:\/\/batcave\.biz\//, "")
    .replace(/^\//, "")
    .replace(/\.html$/, "")
    .trim();
}

function tagFromTitle(title: string) {
  return { id: title.toLowerCase().replace(/[^a-z0-9]/g, ""), title };
}

function parseBatcaveDate(value?: string): Date | undefined {
  if (!value) return undefined;
  const [day, month, year] = value.split(".").map((part) => Number(part));
  if (!day || !month || !year) return undefined;
  return new Date(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
}

function hasNextBatcavePage($: CheerioAPI): boolean {
  const currentPage = parseInt($(".pagination__pages > span").first().text()) || 1;
  return (
    $(".pagination__pages > a").filter((_, el) => {
      const pageNum = parseInt($(el).text());
      return !isNaN(pageNum) && pageNum > currentPage;
    }).length > 0
  );
}

export const Batcave = new BatcaveExtension();
