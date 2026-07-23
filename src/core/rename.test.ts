import { describe, expect, it } from "vitest";
import { isLegitRename, parseLinkFile } from "./rename";

describe("isLegitRename", () => {
  it("accepts a rename when the link travelled with the folder", () => {
    expect(isLegitRename("prj_123", "prj_123")).toBe(true);
  });

  it("rejects when the appeared folder is a different project", () => {
    expect(isLegitRename("prj_123", "prj_999")).toBe(false);
  });

  it("rejects when the old project was linked but the new folder has no link", () => {
    // delete blog (linked) + drop in shop (fresh) must NOT inherit history
    expect(isLegitRename("prj_123", null)).toBe(false);
  });

  it("treats never-deployed ghosts as delete+add, never rename", () => {
    // A new drop coinciding with a never-deployed ghost must deploy fresh —
    // "renaming" onto worthless history would skip its first deploy.
    expect(isLegitRename(null, null)).toBe(false);
    expect(isLegitRename(null, "prj_123")).toBe(false);
  });
});

describe("parseLinkFile", () => {
  it("extracts projectId from a real link file", () => {
    const raw = '{"projectId":"prj_3snCLvtXxRvSAyKzJAlnAVyoRs19","orgId":"team_x","projectName":"helloworld"}';
    expect(parseLinkFile(raw)).toBe("prj_3snCLvtXxRvSAyKzJAlnAVyoRs19");
  });

  it("is null-safe on missing or corrupt files", () => {
    expect(parseLinkFile(null)).toBeNull();
    expect(parseLinkFile("not json")).toBeNull();
    expect(parseLinkFile("{}")).toBeNull();
  });
});
