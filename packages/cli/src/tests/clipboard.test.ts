import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type ClipboardModule = typeof import("../ui/core/clipboard");

const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_PLATFORM = process.platform;

function withCleanPath<T>(fn: () => T): T {
  process.env.PATH = "/nonexistent-bin-dir";
  try {
    return fn();
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
}

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", { value: ORIGINAL_PLATFORM });
  }
}

test("readClipboardImage returns null when no clipboard helpers are installed", async () => {
  // Reload module so it picks up the patched PATH at spawn time.
  const moduleUrl = new URL(`../ui/core/clipboard.ts?t=${Date.now()}`, import.meta.url).href;
  const { readClipboardImage } = (await import(moduleUrl)) as ClipboardModule;
  const result = withCleanPath(() => readClipboardImage());
  assert.equal(result, null);
});

test("win32 clipboard read uses an STA thread", async () => {
  // The win32 path shells out to PowerShell. On an MTA thread (the default for
  // `powershell -Command`), System.Windows.Forms.Clipboard.GetImage() throws a
  // ThreadStateException and produces no output, so image paste silently fails.
  // The script must therefore read the clipboard inside an STA-marked thread.
  const moduleUrl = new URL(`../ui/core/clipboard.ts?t=${Date.now()}`, import.meta.url).href;
  const mod = (await import(moduleUrl)) as ClipboardModule & { WIN32_CLIPBOARD_SCRIPT?: string };

  const script = mod.WIN32_CLIPBOARD_SCRIPT;
  assert.ok(script, "expected a win32 clipboard script to be exported");
  assert.match(script, /SetApartmentState\('STA'\)/, "script must set STA apartment state");
  assert.match(script, /System\.Threading\.Thread/, "script must run on a dedicated STA thread");

  // The win32 read must not throw and resolves to null (no image) without a
  // clipboard image available in the test environment.
  const result = withPlatform("win32", () => mod.readClipboardImage());
  assert.equal(result, null);
});

test(
  "readClipboardImage uses osascript fallback on macOS when pngpaste is missing",
  { skip: process.platform === "win32" },
  async () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-clipboard-test-bin-"));
    try {
      fs.writeFileSync(path.join(binDir, "pngpaste"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      fs.writeFileSync(
        path.join(binDir, "osascript"),
        [
          "#!/bin/sh",
          'for arg in "$@"; do',
          '  case "$arg" in',
          "    *'open for access POSIX file " + '"' + "'*)",
          '      path_part=${arg#*POSIX file \\"}',
          '      out_path=${path_part%%\\"*}',
          '      printf fakepng > "$out_path"',
          "      exit 0",
          "      ;;",
          "  esac",
          "done",
          "exit 1",
          "",
        ].join("\n"),
        { mode: 0o755 }
      );

      const moduleUrl = new URL(`../ui/core/clipboard.ts?t=${Date.now()}`, import.meta.url).href;
      const { readClipboardImage } = (await import(moduleUrl)) as ClipboardModule;

      process.env.PATH = binDir;
      const result = withPlatform("darwin", () => readClipboardImage());
      assert.equal(result?.mimeType, "image/png");
      assert.equal(result?.dataUrl, `data:image/png;base64,${Buffer.from("fakepng").toString("base64")}`);
    } finally {
      process.env.PATH = ORIGINAL_PATH;
      Object.defineProperty(process, "platform", { value: ORIGINAL_PLATFORM });
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  }
);
