/* SPDX-License-Identifier: GPL-3.0-or-later */

import { ContentRating, SourceIntents, type ExtensionInfo } from "@paperback/types";

export default {
  name: "Read Comics Online RU",
  description: "Paperback extension for readcomicsonline.ru.",
  version: "1.0.12",
  icon: "icon.png",
  language: "en",
  contentRating: ContentRating.EVERYONE,
  badges: [],
  capabilities:
    SourceIntents.DISCOVER_SECTION_PROVIDING |
    SourceIntents.SEARCH_RESULT_PROVIDING |
    SourceIntents.CHAPTER_PROVIDING |
    SourceIntents.CLOUDFLARE_BYPASS_PROVIDING,
  developers: [{ name: "lucas" }],
} satisfies ExtensionInfo;
