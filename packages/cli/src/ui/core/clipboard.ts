import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export type ClipboardImage = {
  dataUrl: string;
  mimeType: string;
};

const PNG_MIME = "image/png";

// PowerShell script used on Windows to read a PNG image from the clipboard.
// It must run inside an STA-marked thread because
// System.Windows.Forms.Clipboard.GetImage() throws a ThreadStateException on
// the default MTA thread. The image bytes are written directly to stdout.
export const WIN32_CLIPBOARD_SCRIPT =
  "$code = {" +
  "Add-Type -AssemblyName System.Windows.Forms;" +
  "$img = [System.Windows.Forms.Clipboard]::GetImage();" +
  "if ($img) { $ms = New-Object System.IO.MemoryStream;" +
  "$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png);" +
  "$bytes = $ms.ToArray();" +
  "[Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length); } };" +
  "$thread = New-Object System.Threading.Thread($code, $true);" +
  "$thread.SetApartmentState('STA');" +
  "$thread.Start();" +
  "$thread.Join();";
const IMAGE_MIME_BY_EXT = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

function bufferToDataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function isImageFilePath(value: string): boolean {
  return IMAGE_MIME_BY_EXT.has(path.extname(value.trim()).toLowerCase());
}

function mimeTypeForPath(value: string): string {
  return IMAGE_MIME_BY_EXT.get(path.extname(value.trim()).toLowerCase()) ?? PNG_MIME;
}

function tryRun(command: string, args: string[]): Buffer | null {
  try {
    const result = spawnSync(command, args, { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
    if (result.status !== 0 || !result.stdout || result.stdout.length === 0) {
      return null;
    }
    return result.stdout;
  } catch {
    return null;
  }
}

function tryRunStatus(command: string, args: string[]): boolean {
  try {
    const result = spawnSync(command, args, { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
    return result.status === 0;
  } catch {
    return false;
  }
}

function readImageFile(filePath: string): ClipboardImage | null {
  try {
    if (!isImageFilePath(filePath)) {
      return null;
    }
    const buffer = fs.readFileSync(filePath);
    if (buffer.length === 0) {
      return null;
    }
    const mimeType = mimeTypeForPath(filePath);
    return { dataUrl: bufferToDataUrl(buffer, mimeType), mimeType };
  } catch {
    return null;
  }
}

function readMacClipboardImage(): ClipboardImage | null {
  const pngpaste = tryRun("pngpaste", ["-"]);
  if (pngpaste && pngpaste.length > 0) {
    return { dataUrl: bufferToDataUrl(pngpaste, PNG_MIME), mimeType: PNG_MIME };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-clipboard-"));
  const screenshotPath = path.join(tempDir, "clipboard.png");
  try {
    const saved = tryRunStatus("osascript", [
      "-e",
      "set png_data to (the clipboard as «class PNGf»)",
      "-e",
      `set fp to open for access POSIX file "${screenshotPath}" with write permission`,
      "-e",
      "write png_data to fp",
      "-e",
      "close access fp",
    ]);

    if (saved) {
      const image = readImageFile(screenshotPath);
      if (image) {
        return image;
      }
    }

    const fileUrl = tryRun("osascript", ["-e", "get POSIX path of (the clipboard as «class furl»)"]);
    const filePath = fileUrl?.toString("utf8").trim();
    if (filePath) {
      return readImageFile(filePath);
    }

    return null;
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
}

export function readClipboardImage(): ClipboardImage | null {
  if (process.platform === "darwin") {
    return readMacClipboardImage();
  }

  if (process.platform === "linux") {
    const xclip = tryRun("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]);
    if (xclip && xclip.length > 0) {
      return { dataUrl: bufferToDataUrl(xclip, PNG_MIME), mimeType: PNG_MIME };
    }
    const wlPaste = tryRun("wl-paste", ["--type", "image/png"]);
    if (wlPaste && wlPaste.length > 0) {
      return { dataUrl: bufferToDataUrl(wlPaste, PNG_MIME), mimeType: PNG_MIME };
    }
    return null;
  }

  if (process.platform === "win32") {
    // System.Windows.Forms.Clipboard.GetImage() can only be called from a
    // thread running in Single-Threaded Apartment (STA) mode. A normal
    // `powershell -Command` invocation runs on an MTA thread, where the call
    // throws a ThreadStateException and silently produces no output — which is
    // why Ctrl+V paste of a screenshot appears to "do nothing". Wrapping the
    // read in an explicitly STA-marked thread fixes this.
    const out = tryRun("powershell", ["-NoProfile", "-Command", WIN32_CLIPBOARD_SCRIPT]);
    if (out && out.length > 0) {
      return { dataUrl: bufferToDataUrl(out, PNG_MIME), mimeType: PNG_MIME };
    }
    return null;
  }

  return null;
}

export async function readClipboardImageAsync(): Promise<ClipboardImage | null> {
  return new Promise((resolve, reject) => {
    // Use setImmediate to avoid blocking the event loop
    setImmediate(() => {
      try {
        const result = readClipboardImage();
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
  });
}
