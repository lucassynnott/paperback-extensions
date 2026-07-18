/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
  CloudflareError,
  PaperbackInterceptor,
  type Cookie,
  type Request,
  type Response,
} from "@paperback/types";

export const BASE_URL = "https://readcomicsonline.ru";

const HTML_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
const IMAGE_ACCEPT = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";
const ACCEPT_LANGUAGE = "en-US,en;q=0.9";
const FINGERPRINT_HEADERS = new Set([
  "origin",
  "user-agent",
  "accept",
  "accept-language",
  "referer",
  "x-requested-with",
]);

function isReaderAsset(url: string): boolean {
  return (
    /\/uploads\/manga\/[^/]+\/(?:chapters|cover)\//i.test(url) ||
    /\.(?:avif|gif|jpe?g|png|svg|webp)(?:[?#]|$)/i.test(url)
  );
}

async function createBrowserHeaders(
  url: string,
  existingHeaders: Record<string, string> | undefined,
): Promise<Record<string, string>> {
  const headers = Object.fromEntries(
    Object.entries(existingHeaders ?? {}).filter(
      ([name]) => !FINGERPRINT_HEADERS.has(name.toLowerCase()),
    ),
  );

  return {
    ...headers,
    "User-Agent": await Application.getDefaultUserAgent(),
    Accept: isReaderAsset(url) ? IMAGE_ACCEPT : HTML_ACCEPT,
    "Accept-Language": ACCEPT_LANGUAGE,
    Referer: `${BASE_URL}/`,
  };
}

function headerValue(headers: Record<string, string> | undefined, name: string): string {
  const entry = Object.entries(headers ?? {}).find(
    ([headerName]) => headerName.toLowerCase() === name.toLowerCase(),
  );
  return entry?.[1] ?? "";
}

export function isCloudflareChallenge(response: Response, html: string): boolean {
  if (/\bchallenge\b/i.test(headerValue(response.headers, "cf-mitigated"))) return true;

  const challengeBody =
    /(?:just a moment|checking your browser|cdn-cgi\/challenge-platform|cf-chl-|challenge-form)/i.test(
      html,
    );

  return (response.status === 403 || response.status === 503) && challengeBody;
}

export async function createCloudflareResolutionRequest(): Promise<Request> {
  const url = `${BASE_URL}/`;
  return { url, method: "GET", headers: await createBrowserHeaders(url, undefined) };
}

export function usableCloudflareCookies(cookies: Cookie[], now = Date.now()): Cookie[] {
  return cookies.filter((cookie) => !cookie.expires || cookie.expires.getTime() > now);
}

interface CookieStore {
  get cookies(): Readonly<Cookie[]>;
  set cookies(newValue: Cookie[]);
}

function cookieIdentity(cookie: Cookie): string {
  const domain = cookie.domain.replace(/^(?:www)?\.?/i, "").toLowerCase();
  const path = cookie.path?.startsWith("/") ? cookie.path : `/${cookie.path ?? ""}`;
  return `${cookie.name}-${domain}-${path}`;
}

export function applyCloudflareCookieUpdate(
  store: CookieStore,
  cookies: Cookie[],
  now = Date.now(),
): void {
  if (!cookies.length) return;

  const usableCookies = usableCloudflareCookies(cookies, now);
  if (usableCookies.length) {
    store.cookies = usableCookies;
  } else {
    const deletionKeys = new Set(cookies.map(cookieIdentity));
    store.cookies = store.cookies.filter((cookie) => !deletionKeys.has(cookieIdentity(cookie)));
  }
}

export class ReadComicsOnlineRuInterceptor extends PaperbackInterceptor {
  override async interceptRequest(request: Request): Promise<Request> {
    request.headers = await createBrowserHeaders(request.url, request.headers);
    return request;
  }

  override async interceptResponse(
    _request: Request,
    response: Response,
    data: ArrayBuffer,
  ): Promise<ArrayBuffer> {
    let html = "";
    try {
      html = Application.arrayBufferToUTF8String(data);
    } catch {
      // Binary responses cannot be Cloudflare interstitial HTML. Header/status checks still apply.
    }

    if (isCloudflareChallenge(response, html)) {
      throw new CloudflareError(
        await createCloudflareResolutionRequest(),
        "Cloudflare challenge required",
      );
    }
    return data;
  }
}
