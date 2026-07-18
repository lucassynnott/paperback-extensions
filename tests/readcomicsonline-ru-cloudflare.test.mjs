import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { CloudflareError, CookieStorageInterceptor } from "@paperback/types";

import {
  BASE_URL,
  ReadComicsOnlineRuInterceptor,
  applyCloudflareCookieUpdate,
  createCloudflareResolutionRequest,
  isCloudflareChallenge,
  usableCloudflareCookies,
} from "../src/ReadComicsOnlineRu/interceptors.ts";

const DEFAULT_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const applicationState = new Map();

function response(status, headers) {
  return { url: BASE_URL, status, headers, cookies: [] };
}

beforeEach(() => {
  applicationState.clear();
  globalThis.Application = {
    getDefaultUserAgent: async () => DEFAULT_UA,
    arrayBufferToUTF8String: (data) => new TextDecoder().decode(data),
    getState: (key) => applicationState.get(key),
    setState: (value, key) => applicationState.set(key, value),
  };
});

describe("ReadComicsOnlineRu Cloudflare handling", () => {
  it("uses one browser fingerprint and strips contradictory app headers", async () => {
    const interceptor = new ReadComicsOnlineRuInterceptor("test");
    const request = await interceptor.interceptRequest({
      url: `${BASE_URL}/comic-list`,
      method: "GET",
      headers: {
        Origin: "https://wrong.invalid",
        "X-Requested-With": "com.batcave.android",
        Cookie: "session=kept",
      },
    });

    assert.equal(request.headers?.["User-Agent"], DEFAULT_UA);
    assert.equal(request.headers?.Referer, `${BASE_URL}/`);
    assert.equal(request.headers?.Cookie, "session=kept");
    assert.equal(request.headers?.Origin, undefined);
    assert.equal(request.headers?.["X-Requested-With"], undefined);
  });

  it("uses image-appropriate accept headers for reader CDN requests", async () => {
    const interceptor = new ReadComicsOnlineRuInterceptor("test");
    const request = await interceptor.interceptRequest({
      url: "https://cdn.readcomicsonline.ru/uploads/manga/a/chapters/1/page",
      method: "GET",
    });

    assert.match(request.headers?.Accept ?? "", /^image\//);
    assert.equal(request.headers?.Referer, `${BASE_URL}/`);
  });

  it("recognizes challenge headers regardless of casing", () => {
    assert.equal(isCloudflareChallenge(response(403, { "Cf-Mitigated": "challenge" }), ""), true);
  });

  it("recognizes body-only Cloudflare interstitials", () => {
    assert.equal(
      isCloudflareChallenge(
        response(403, { Server: "cloudflare" }),
        "<html><title>Just a moment...</title><script src='/cdn-cgi/challenge-platform/x'></script>",
      ),
      true,
    );
  });

  it("does not mistake an ordinary Cloudflare-hosted 403 for a challenge", () => {
    assert.equal(
      isCloudflareChallenge(response(403, { Server: "cloudflare" }), "<h1>Forbidden</h1>"),
      false,
    );
  });

  it("opens the clean origin with the same headers for challenge resolution", async () => {
    const resolution = await createCloudflareResolutionRequest();
    assert.equal(resolution.url, `${BASE_URL}/`);
    assert.equal(resolution.method, "GET");
    assert.equal(resolution.headers?.["User-Agent"], DEFAULT_UA);
    assert.equal(resolution.headers?.Referer, `${BASE_URL}/`);
    assert.equal(resolution.headers?.["X-Requested-With"], undefined);
  });

  it("throws a CloudflareError with the clean resolution request", async () => {
    const interceptor = new ReadComicsOnlineRuInterceptor("test");
    const body = new TextEncoder().encode("<title>Just a moment...</title>").buffer;

    await assert.rejects(
      interceptor.interceptResponse(
        { url: `${BASE_URL}/comic-list?page=4`, method: "GET" },
        response(403, { "CF-MITIGATED": "challenge" }),
        body,
      ),
      (error) => {
        assert.ok(error instanceof CloudflareError);
        assert.equal(error.resolutionRequest.url, `${BASE_URL}/`);
        return true;
      },
    );
  });

  it("keeps session cookies, rejects expired cookies, and tolerates an empty solve", () => {
    const sessionCookie = {
      name: "cf_clearance",
      value: "session",
      domain: ".readcomicsonline.ru",
    };
    const futureCookie = {
      name: "future",
      value: "valid",
      domain: ".readcomicsonline.ru",
      expires: new Date("2030-01-01T00:00:00Z"),
    };
    const expiredCookie = {
      name: "expired",
      value: "invalid",
      domain: ".readcomicsonline.ru",
      expires: new Date("2020-01-01T00:00:00Z"),
    };

    assert.deepEqual(
      usableCloudflareCookies(
        [sessionCookie, futureCookie, expiredCookie],
        new Date("2026-01-01T00:00:00Z").getTime(),
      ),
      [sessionCookie, futureCookie],
    );
    assert.deepEqual(usableCloudflareCookies([]), []);
  });

  it("preserves cookies on empty solve, replaces them on success, and honors deletion cookies", () => {
    const stale = {
      name: "cf_clearance",
      value: "stale",
      domain: ".readcomicsonline.ru",
      path: "/",
      expires: new Date("2028-01-01T00:00:00Z"),
    };
    const unrelated = {
      name: "session",
      value: "old",
      domain: ".readcomicsonline.ru",
      path: "/",
      expires: new Date("2028-01-01T00:00:00Z"),
    };
    const jar = new Map([
      [stale.name, stale],
      [unrelated.name, unrelated],
    ]);
    const store = {
      get cookies() {
        return [...jar.values()];
      },
      set cookies(cookies) {
        jar.clear();
        for (const cookie of cookies) jar.set(cookie.name, cookie);
      },
    };

    const now = new Date("2026-01-01T00:00:00Z").getTime();
    applyCloudflareCookieUpdate(store, [], now);
    assert.equal(jar.get("cf_clearance")?.value, "stale");

    const solved = { ...stale, value: "fresh" };
    applyCloudflareCookieUpdate(store, [solved], now);
    assert.deepEqual([...jar.keys()], ["cf_clearance"]);
    assert.equal(jar.get("cf_clearance")?.value, "fresh");

    const deletion = { ...solved, value: "", expires: new Date("2020-01-01T00:00:00Z") };
    applyCloudflareCookieUpdate(store, [deletion], now);
    assert.equal(jar.has("cf_clearance"), false);
  });

  it("persists deletion cookies through Paperback's real state-backed cookie store", () => {
    const stale = {
      name: "cf_clearance",
      value: "stale",
      domain: ".readcomicsonline.ru",
      path: "/",
      expires: new Date("2028-01-01T00:00:00Z"),
    };
    const deletion = { ...stale, value: "", expires: new Date("2020-01-01T00:00:00Z") };
    const now = new Date("2026-01-01T00:00:00Z").getTime();
    const store = new CookieStorageInterceptor({ storage: "stateManager" });
    store.cookies = [stale];

    applyCloudflareCookieUpdate(store, [deletion], now);

    assert.deepEqual(store.cookies, []);
    assert.deepEqual(new CookieStorageInterceptor({ storage: "stateManager" }).cookies, []);
  });
});
