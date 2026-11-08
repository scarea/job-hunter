import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const run = promisify(execFile);

/**
 * 简历文件 → 纯文本
 *   .pdf          unpdf（纯 JS）
 *   .docx/.doc/.rtf/.pages  macOS 自带 textutil
 *   .md/.txt      直接读
 * 扫描版 PDF（图片）提取不到文字，会提示改用粘贴。
 */
export async function extractResumeText(buf: Buffer, filename: string): Promise<string> {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".md" || ext === ".txt" || ext === ".markdown") return clean(buf.toString("utf8"));

  if (ext === ".pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: true });
    return clean(String(text));
  }

  if ([".docx", ".doc", ".rtf", ".pages", ".odt", ".html"].includes(ext)) {
    const tmp = path.join(os.tmpdir(), `resume-${process.pid}-${Date.now()}${ext}`);
    fs.writeFileSync(tmp, buf);
    try {
      const { stdout } = await run("textutil", ["-convert", "txt", "-stdout", tmp], { maxBuffer: 10 * 1024 * 1024 });
      return clean(stdout);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  throw new Error(`不支持的格式 ${ext || "(无扩展名)"}，请上传 PDF / Word / Markdown / TXT`);
}

/** 去掉多余空白：PDF 提取常有一堆空行和行尾空格 */
function clean(t: string): string {
  return t.normalize("NFKC").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
