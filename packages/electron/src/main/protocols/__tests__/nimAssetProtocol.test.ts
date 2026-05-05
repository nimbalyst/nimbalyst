import { describe, it, expect } from "vitest";
import { sep } from "path";
import {
  encodeNimAssetUrl,
  validateNimAssetPath,
  NIM_ASSET_SCHEME,
  NIM_ASSET_HOST,
} from "../nimAssetProtocol";

const ROOT = `${sep}tmp${sep}allowed-root`;
const OTHER = `${sep}tmp${sep}allowed-other`;

describe("nimAssetProtocol", () => {
  describe("encodeNimAssetUrl", () => {
    it("produces a parseable nim-asset URL with base64url-encoded path", () => {
      const url = encodeNimAssetUrl(`${ROOT}/foo/bar baz.png`);
      expect(url).toMatch(new RegExp(`^${NIM_ASSET_SCHEME}://${NIM_ASSET_HOST}/[A-Za-z0-9_-]+$`));

      // round-trip: decode the base64url back and confirm we got the path
      const encoded = url.replace(`${NIM_ASSET_SCHEME}://${NIM_ASSET_HOST}/`, "");
      const decoded = Buffer.from(encoded, "base64url").toString("utf8");
      expect(decoded).toBe(`${ROOT}/foo/bar baz.png`);
    });

    it("does not introduce slashes in the encoded segment", () => {
      const url = encodeNimAssetUrl(`${ROOT}/deeply/nested/dir/image.jpg`);
      const encoded = url.replace(`${NIM_ASSET_SCHEME}://${NIM_ASSET_HOST}/`, "");
      expect(encoded).not.toContain("/");
    });
  });

  describe("validateNimAssetPath", () => {
    const roots = [ROOT, OTHER];

    it("accepts a PNG inside the first allowlisted root", () => {
      expect(validateNimAssetPath(`${ROOT}/img.png`, roots)).toBe(`${ROOT}/img.png`);
    });

    it("accepts a JPG inside another allowlisted root", () => {
      expect(validateNimAssetPath(`${OTHER}/sub/x.jpg`, roots)).toBe(`${OTHER}/sub/x.jpg`);
    });

    it("accepts each image extension in the allowlist", () => {
      for (const ext of [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"]) {
        expect(validateNimAssetPath(`${ROOT}/x${ext}`, roots)).toBe(`${ROOT}/x${ext}`);
      }
    });

    it("rejects when no roots are configured", () => {
      expect(validateNimAssetPath(`${ROOT}/img.png`, [])).toBeNull();
    });

    it("rejects a path outside every allowlisted root", () => {
      expect(validateNimAssetPath(`${sep}etc${sep}passwd.png`, roots)).toBeNull();
    });

    it("rejects a path that uses .. to traverse out of an allowlisted root", () => {
      expect(validateNimAssetPath(`${ROOT}/../etc/passwd.png`, roots)).toBeNull();
    });

    it("rejects .. traversal expressed with backslash separators", () => {
      // Defense must hold regardless of which separator the caller uses,
      // because on Windows the renderer emits backslash-separated paths.
      // The earlier `normalize() === input` guard happened to catch this
      // on POSIX but is gone; this test pins the explicit `..` segment
      // check that replaced it.
      expect(validateNimAssetPath(`${ROOT}\\..\\etc\\passwd.png`, roots)).toBeNull();
    });

    it("rejects null-byte injection", () => {
      expect(validateNimAssetPath(`${ROOT}/img.png\0.txt`, roots)).toBeNull();
    });

    it("rejects an empty string", () => {
      expect(validateNimAssetPath("", roots)).toBeNull();
    });

    it("rejects a non-image file extension (markdown)", () => {
      expect(validateNimAssetPath(`${ROOT}/README.md`, roots)).toBeNull();
    });

    it("rejects a non-image file extension (text)", () => {
      expect(validateNimAssetPath(`${ROOT}/secret.txt`, roots)).toBeNull();
    });

    it("rejects an extensionless file", () => {
      expect(validateNimAssetPath(`${ROOT}/Makefile`, roots)).toBeNull();
    });

    it("normalizes the file extension comparison case-insensitively", () => {
      expect(validateNimAssetPath(`${ROOT}/IMG.PNG`, roots)).toBe(`${ROOT}/IMG.PNG`);
    });

    it("requires the root prefix match to be a directory boundary, not a substring prefix", () => {
      // The path-prefix check must use a separator boundary so that
      // /tmp/allowed-root-evil does not match /tmp/allowed-root.
      const evil = `${ROOT}-evil${sep}img.png`;
      expect(validateNimAssetPath(evil, roots)).toBeNull();
    });

    it("accepts the root itself if the root is the file (edge case, won't happen in practice)", () => {
      // Documenting current behavior: if requestedAbsPath === root and the
      // root has an image extension, it passes. Realistic roots are
      // directories so this never triggers in production.
      expect(validateNimAssetPath(`${ROOT}.png`, [`${ROOT}.png`])).toBe(`${ROOT}.png`);
    });
  });
});
