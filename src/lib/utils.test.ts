import { describe, expect, it } from "vitest";
import { tildeAbbreviate } from "./utils";

describe("tildeAbbreviate", () => {
  it("collapses the home prefix on each platform", () => {
    expect(tildeAbbreviate("/Users/ada/Vercel")).toBe("~/Vercel");
    expect(tildeAbbreviate("/home/ada/Vercel")).toBe("~/Vercel");
    expect(tildeAbbreviate("C:\\Users\\ada\\Vercel")).toBe("~\\Vercel");
  });

  it("leaves a path with no home prefix whole", () => {
    // Showing a truncated-looking path would be worse than showing all of it:
    // the point is to drop noise, not to shorten at any cost.
    expect(tildeAbbreviate("/Volumes/Work/Vercel")).toBe("/Volumes/Work/Vercel");
    expect(tildeAbbreviate("/Users")).toBe("/Users");
  });

  it("collapses only the leading prefix, not a later one", () => {
    expect(tildeAbbreviate("/Volumes/backup/Users/ada/Vercel")).toBe(
      "/Volumes/backup/Users/ada/Vercel",
    );
  });

  it("is empty for an unset root folder", () => {
    expect(tildeAbbreviate("")).toBe("");
  });
});
