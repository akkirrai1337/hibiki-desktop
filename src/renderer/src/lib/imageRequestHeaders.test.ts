import { describe, expect, it } from "vitest";
import { headersForImageRequest } from "@shared/imageRequestHeaders";

describe("headersForImageRequest", () => {
  it("drops the referer a hotlink check would reject", () => {
    // AniTube's CDN answers 403 to a foreign Referer and 200 to a request carrying none.
    expect(
      headersForImageRequest("image", { Referer: "http://localhost:5173/", "User-Agent": "chrome" }),
    ).toEqual({ "User-Agent": "chrome" });
  });

  it("matches the header however it is capitalised", () => {
    expect(headersForImageRequest("image", { referer: "x", ORIGIN: "y", Accept: "image/*" }))
      .toEqual({ Accept: "image/*" });
  });

  it("leaves everything that is not an image alone", () => {
    const headers = { Referer: "https://example.test/", Accept: "*/*" };
    expect(headersForImageRequest("xhr", headers)).toBe(headers);
    expect(headersForImageRequest("media", headers)).toBe(headers);
  });

  it("returns the same object when there is nothing to drop", () => {
    const headers = { Accept: "image/*" };
    expect(headersForImageRequest("image", headers)).toBe(headers);
  });
});
