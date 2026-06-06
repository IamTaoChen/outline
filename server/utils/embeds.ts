import type { EmbedDescriptor } from "@shared/editor/embeds";
import { getMatchingEmbed } from "@shared/editor/lib/embeds";
import embeds from "@shared/editor/embeds";
import env from "@server/env";
import fetch, { chromeUserAgent } from "./fetch";
import { Second } from "@shared/utils/time";

/**
 * Result of an embed check operation.
 */
export interface EmbedCheckResult {
  /** Whether the URL can be embedded in an iframe. */
  embeddable: boolean;
  /** The reason why the URL cannot be embedded, if applicable. */
  reason?:
    | "x-frame-options"
    | "csp-frame-ancestors"
    | "no-match"
    | "coep"
    | "http-error"
    | "error"
    | "timeout";
}

/**
 * Parses X-Frame-Options header and determines if embedding is allowed.
 *
 * @param value The X-Frame-Options header value.
 * @returns true if embedding is blocked, false otherwise.
 */
function isBlockedByXFrameOptions(value: string | null): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.toUpperCase().trim();

  // DENY - Cannot be embedded anywhere
  // SAMEORIGIN - Can only be embedded on same origin (blocks us)
  // ALLOW-FROM - Deprecated but treat as blocked
  return (
    normalized === "DENY" ||
    normalized === "SAMEORIGIN" ||
    normalized.startsWith("ALLOW-FROM")
  );
}

/**
 * Checks whether a CSP frame-ancestors source matches the given origin.
 * Supports exact matches and wildcard subdomain patterns (e.g. https://*.example.com).
 *
 * @param source A single frame-ancestors source token.
 * @param origin The origin to test against (e.g. "https://note.kyzdt.com").
 * @returns true if the source covers the origin.
 */
function sourceMatchesOrigin(source: string, origin: string): boolean {
  if (source === origin) {
    return true;
  }

  // Wildcard subdomain: https://*.example.com
  if (source.includes("*")) {
    const escaped = source
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&") // escape regex special chars
      .replace("\\*", "[^.]+"); // replace escaped * with single-label wildcard
    return new RegExp(`^${escaped}$`).test(origin);
  }

  return false;
}

/**
 * Parses Content-Security-Policy header and checks if frame-ancestors blocks embedding.
 *
 * @param value The Content-Security-Policy header value.
 * @param siteOrigin The origin of the current Outline installation (e.g. "https://note.kyzdt.com").
 *                   When provided, the list of frame-ancestors sources is checked against it so that
 *                   pages that explicitly whitelist this origin are not incorrectly blocked.
 * @returns true if embedding is blocked, false otherwise.
 */
function isBlockedByCSP(
  value: string | null,
  siteOrigin?: string
): boolean {
  if (!value) {
    return false;
  }

  // Parse the CSP header to find frame-ancestors directive
  const directives = value.split(";").map((d) => d.trim());

  for (const directive of directives) {
    const parts = directive.split(/\s+/);
    if (parts[0]?.toLowerCase() === "frame-ancestors") {
      const sources = parts.slice(1);

      // 'none' - Cannot be embedded anywhere
      if (sources.includes("'none'")) {
        return true;
      }

      // Wildcard * - Any origin is allowed
      if (sources.includes("*")) {
        return false;
      }

      // If we know our site origin, check whether it is explicitly listed
      if (siteOrigin) {
        for (const source of sources) {
          if (source === "'self'") {
            continue; // 'self' refers to the embedded page's own origin, not ours
          }
          if (sourceMatchesOrigin(source, siteOrigin)) {
            return false;
          }
        }
      }

      // No matching source found – treat as blocked
      return true;
    }
  }

  return false;
}

/**
 * Checks Cross-Origin-Embedder-Policy header for embedding restrictions.
 *
 * @param value The Cross-Origin-Embedder-Policy header value.
 * @returns true if embedding is blocked, false otherwise.
 */
function isBlockedByCOEP(value: string | null): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.toLowerCase().trim();

  // unsafe-none means no restrictions, anything else blocks cross-origin embedding
  return normalized !== "unsafe-none";
}

/**
 * Checks if a URL can be embedded in an iframe by verifying:
 * 1. The URL matches a known embed pattern
 * 2. The URL's response headers don't block iframe embedding
 *
 * @param url The URL to check for embeddability.
 * @returns a promise resolving to the embed check result.
 */
export async function checkEmbeddability(
  url: string
): Promise<EmbedCheckResult> {
  const match = getMatchingEmbed(embeds, url);
  if (!match) {
    return { embeddable: false, reason: "no-match" };
  }

  if (match.embed.title !== "Embed") {
    // Known safe embed type
    return { embeddable: true };
  }

  // Derive our installation's origin so we can check CSP frame-ancestors against it
  let siteOrigin: string | undefined;
  try {
    if (env.URL) {
      siteOrigin = new URL(env.URL).origin;
    }
  } catch (_e) {
    // Invalid env.URL – proceed without origin matching
  }

  // Make GET request to check headers (HEAD is unreliable for many servers)
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), Second.ms * 3);

    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": chromeUserAgent,
      },
    });

    clearTimeout(timeoutId);

    // Get headers then immediately close the connection - we don't need the body
    const status = response.status;
    const xFrameOptions = response.headers.get("x-frame-options");
    const csp = response.headers.get("content-security-policy");
    const coep = response.headers.get("cross-origin-embedder-policy");
    controller.abort();

    // Check for HTTP errors - if the server rejects the request, embedding won't work
    if (status >= 400) {
      return { embeddable: false, reason: "http-error" };
    }

    // Check X-Frame-Options header
    if (isBlockedByXFrameOptions(xFrameOptions)) {
      return { embeddable: false, reason: "x-frame-options" };
    }

    // Check Content-Security-Policy for frame-ancestors
    if (isBlockedByCSP(csp, siteOrigin)) {
      return { embeddable: false, reason: "csp-frame-ancestors" };
    }

    // Check Cross-Origin-Embedder-Policy
    if (isBlockedByCOEP(coep)) {
      return { embeddable: false, reason: "coep" };
    }

    return { embeddable: true };
  } catch {
    // On timeout or network error, be optimistic and allow embedding
    return { embeddable: true, reason: "timeout" };
  }
}

/**
 * Checks if a URL matches any of the embed patterns.
 *
 * @param url - The URL to check.
 * @param embedDescriptors - The list of embed descriptors to check against.
 * @returns True if the URL matches an embed pattern with `matchOnInput` enabled.
 */
function isEmbedUrl(url: string, embedDescriptors: EmbedDescriptor[]): boolean {
  for (const embed of embedDescriptors) {
    if (!embed.matchOnInput) {
      continue;
    }
    if (embed.matcher(url)) {
      return true;
    }
  }
  return false;
}

/**
 * A regex pattern that matches URLs at the beginning of a line or as standalone content.
 * Matches http:// and https:// URLs.
 */
const bareUrlPattern = /^(https?:\/\/[^\s]+)$/;

/**
 * Converts bare URLs in markdown text to the embed-friendly link format `[url](url)`.
 * This allows the markdown parser to recognize them as embeds when they match
 * supported embed patterns (YouTube, Vimeo, etc.).
 *
 * Only URLs that match a known embed pattern with `matchOnInput` enabled will be converted.
 *
 * @param text - The markdown text to process.
 * @param embedDescriptors - Optional custom list of embed descriptors. Defaults to built-in embeds.
 * @returns The processed text with bare embed URLs converted to link format.
 *
 * @example
 * // Input:
 * "Check out this video:\n\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ\n\nPretty cool!"
 *
 * // Output:
 * "Check out this video:\n\n[https://www.youtube.com/watch?v=dQw4w9WgXcQ](https://www.youtube.com/watch?v=dQw4w9WgXcQ)\n\nPretty cool!"
 */
export function convertBareUrlsToEmbedMarkdown(
  text: string,
  embedDescriptors: EmbedDescriptor[] = embeds
): string {
  const lines = text.split("\n");

  return lines
    .map((line) => {
      const trimmed = line.trim();

      // Check if the line is a bare URL
      const match = trimmed.match(bareUrlPattern);
      if (!match) {
        return line;
      }

      const url = match[1];

      // Only convert if the URL matches a known embed pattern
      if (isEmbedUrl(url, embedDescriptors)) {
        // Preserve leading whitespace from the original line
        const leadingWhitespace = line.match(/^(\s*)/)?.[1] ?? "";
        return `${leadingWhitespace}[${url}](${url})`;
      }

      return line;
    })
    .join("\n");
}
