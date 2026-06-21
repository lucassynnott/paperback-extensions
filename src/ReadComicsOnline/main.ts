/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
  BasicRateLimiter,
  DiscoverSectionType,
  type Chapter,
  type ChapterDetails,
  type ChapterProviding,
  type DiscoverSection,
  type DiscoverSectionItem,
  type DiscoverSectionProviding,
  type Extension,
  type MangaProviding,
  type PagedResults,
  type SearchFilter,
  type SearchQuery,
  type SearchResultItem,
  type SearchResultsProviding,
  type SourceManga,
} from "@paperback/types";

import { BASE_URL, MainInterceptor } from "./network";
import {
  parseCategoryPage,
  parseChapterPages,
  parseChapters,
  parseHomeDiscover,
  parseListPage,
  parseMangaDetails,
  parseSearchSuggestions,
} from "./parser";

const PUBLISHERS: { id: string; title: string }[] = [
  { id: "DC-Comics", title: "DC Comics" },
  { id: "Marvel", title: "Marvel Comics" },
  { id: "Image-Comics", title: "Image Comics" },
  { id: "Dark-Horse-Comics", title: "Dark Horse" },
  { id: "IDW-Publishing", title: "IDW" },
  { id: "Boom-Studios", title: "Boom Studios" },
  { id: "Dynamite", title: "Dynamite" },
  { id: "Valiant", title: "Valiant" },
  { id: "Vertigo", title: "Vertigo" },
  { id: "Archie", title: "Archie" },
  { id: "Oni-Press", title: "Oni Press" },
  { id: "Aftershock-Comics", title: "Aftershock Comics" },
];

type ReadComicsOnlineImplementation = Extension &
  DiscoverSectionProviding &
  SearchResultsProviding &
  MangaProviding &
  ChapterProviding;

async function fetchString(url: string): Promise<string> {
  const [, data] = await Application.scheduleRequest({ url, method: "GET" });
  return Application.arrayBufferToUTF8String(data);
}

export class ReadComicsOnlineExtension implements ReadComicsOnlineImplementation {
  mainRateLimiter = new BasicRateLimiter("main", {
    numberOfRequests: 6,
    bufferInterval: 5,
    ignoreImages: true,
  });

  mainInterceptor = new MainInterceptor("main");

  async initialise(): Promise<void> {
    this.mainRateLimiter.registerInterceptor();
    this.mainInterceptor.registerInterceptor();
  }

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    return [
      {
        id: "latest-releases",
        title: "Latest Releases",
        subtitle: "Recently added issues",
        type: DiscoverSectionType.simpleCarousel,
      },
      {
        id: "most-viewed",
        title: "Most Viewed",
        subtitle: "All-time popular comics",
        type: DiscoverSectionType.featured,
      },
      {
        id: "hot-updates",
        title: "Hot Updates",
        subtitle: "Trending right now",
        type: DiscoverSectionType.prominentCarousel,
      },
      {
        id: "publishers",
        title: "Publishers",
        type: DiscoverSectionType.genres,
      },
    ];
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: number | undefined,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    const page = metadata ?? 1;

    if (section.id === "latest-releases") {
      const html = await fetchString(`${BASE_URL}/Status/Ongoing/LatestUpdate?page=${page}`);
      const items = parseListPage(html, "simpleCarouselItem");
      return { items, metadata: items.length === 0 ? undefined : page + 1 };
    }

    if (section.id === "publishers") {
      const items: DiscoverSectionItem[] = PUBLISHERS.map((p) => ({
        type: "genresCarouselItem",
        searchQuery: {
          title: "",
          filters: [],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ...({ metadata: { publisher: p.id } } as any),
        },
        name: p.title,
        metadata: undefined,
      }));
      return { items, metadata: undefined };
    }

    const html = await fetchString(
      section.id === "most-viewed" ? `${BASE_URL}/ComicList/MostPopular?page=1` : `${BASE_URL}/`,
    );
    const type = section.id === "most-viewed" ? "featuredCarouselItem" : "prominentCarouselItem";
    const items = parseHomeDiscover(html, section.id, type);
    return { items };
  }

  async getSearchFilters(): Promise<SearchFilter[]> {
    return [];
  }

  async getSearchResults(
    query: SearchQuery,
    metadata?: number,
  ): Promise<PagedResults<SearchResultItem>> {
    const term = (query.title ?? "").trim();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const qMeta = (query as any).metadata as { publisher?: string } | undefined;
    const publisherId = qMeta?.publisher ?? "";

    if (publisherId) {
      const page = metadata ?? 1;
      const url = `${BASE_URL}/Publisher/${publisherId}/LatestUpdate?page=${page}`;
      const html = await fetchString(url);
      let items = parseCategoryPage(html);
      if (term) {
        const lc = term.toLowerCase();
        items = items.filter((i) => i.title.toLowerCase().includes(lc));
      }
      return { items, metadata: items.length === 0 ? undefined : page + 1 };
    }

    if (!term) return { items: [] };
    const url = `${BASE_URL}/AdvanceSearch?comicName=${encodeURIComponent(term)}`;
    const body = await fetchString(url);
    return { items: parseSearchSuggestions(body) };
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const html = await fetchString(`${BASE_URL}/Comic/${mangaId}`);
    return parseMangaDetails(html, mangaId);
  }

  async getChapters(sourceManga: SourceManga, sinceDate?: Date): Promise<Chapter[]> {
    void sinceDate;
    const html = await fetchString(`${BASE_URL}/Comic/${sourceManga.mangaId}`);
    return parseChapters(html, sourceManga);
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const separator = chapter.chapterId.includes("?") ? "&" : "?";
    const url = `${BASE_URL}/Comic/${chapter.sourceManga.mangaId}/${chapter.chapterId}${separator}quality=hq`;
    const html = await fetchString(url);
    const pages = parseChapterPages(html);
    return {
      id: chapter.chapterId,
      mangaId: chapter.sourceManga.mangaId,
      pages,
    };
  }
}

export const ReadComicsOnline = new ReadComicsOnlineExtension();
