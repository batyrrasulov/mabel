import {
  getSingletonHighlighter,
  type BundledLanguage,
  type Highlighter,
} from "shiki";

const MABEL_SHIKI_LANGUAGES = [
  "bash",
  "c",
  "cpp",
  "css",
  "diff",
  "graphql",
  "html",
  "java",
  "javascript",
  "js",
  "json",
  "jsonc",
  "jsx",
  "markdown",
  "md",
  "mdx",
  "php",
  "python",
  "py",
  "regex",
  "regexp",
  "scss",
  "sh",
  "shell",
  "shellscript",
  "sql",
  "ts",
  "tsx",
  "typescript",
  "vue",
  "xml",
  "yaml",
  "yml",
] as const satisfies readonly BundledLanguage[];

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= getSingletonHighlighter({
    themes: ["github-light", "github-dark"],
    langs: [...MABEL_SHIKI_LANGUAGES],
  });
  return highlighterPromise;
}

function normalizeLanguage(raw: string): BundledLanguage {
  const candidate = (raw || "markdown").trim().toLowerCase();
  const aliases: Record<string, BundledLanguage> = {
    plain: "markdown",
    plaintext: "markdown",
    text: "markdown",
    txt: "markdown",
  };
  const resolved = aliases[candidate] ?? (candidate as BundledLanguage);
  return (MABEL_SHIKI_LANGUAGES as readonly string[]).includes(resolved)
    ? resolved
    : "markdown";
}

export async function mabelCodeToHtml(
  code: string,
  language: string,
  theme: "light" | "dark",
): Promise<string> {
  const highlighter = await getHighlighter();
  const activeTheme = theme === "dark" ? "github-dark" : "github-light";
  try {
    return highlighter.codeToHtml(code, {
      lang: normalizeLanguage(language),
      theme: activeTheme,
    });
  } catch {
    return highlighter.codeToHtml(code, {
      lang: "markdown",
      theme: activeTheme,
    });
  }
}
