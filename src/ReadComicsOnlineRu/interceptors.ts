/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
  CloudflareError,
  PaperbackInterceptor,
  type Request,
  type Response,
} from "@paperback/types";

export class ReadComicsOnlineRuInterceptor extends PaperbackInterceptor {
  override async interceptRequest(request: Request): Promise<Request> {
    request.headers = {
      ...request.headers,
      Origin: "https://readcomicsonline.ru",
      Referer: "https://readcomicsonline.ru/",
      "User-Agent": await Application.getDefaultUserAgent(),
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      "X-Requested-With": "com.batcave.android",
    };
    return request;
  }

  override async interceptResponse(
    request: Request,
    response: Response,
    data: ArrayBuffer,
  ): Promise<ArrayBuffer> {
    if (response.headers?.["cf-mitigated"] === "challenge") {
      throw new CloudflareError(
        {
          url: request.url,
          method: request.method ?? "GET",
          headers: { "User-Agent": await Application.getDefaultUserAgent() },
        },
        "Cloudflare challenge required",
      );
    }
    return data;
  }
}
