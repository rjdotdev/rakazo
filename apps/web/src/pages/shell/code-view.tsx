import type { PrismTheme } from "prism-react-renderer";
import { Highlight } from "prism-react-renderer";

const LANGUAGES: Record<string, string> = {
  bash: "bash",
  c: "c",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  go: "go",
  h: "c",
  html: "markup",
  java: "java",
  js: "javascript",
  jsx: "jsx",
  json: "json",
  kt: "kotlin",
  md: "markdown",
  mjs: "javascript",
  php: "php",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  sql: "sql",
  svg: "markup",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  xml: "markup",
  yaml: "yaml",
  yml: "yaml",
};

/** Weight and muted ink only, so a file reads like the rest of the app. */
const quiet: PrismTheme = {
  plain: { color: "var(--foreground)", backgroundColor: "transparent" },
  styles: [
    {
      types: ["comment", "prolog", "doctype", "cdata", "punctuation"],
      style: { color: "var(--muted-foreground)" },
    },
    {
      types: ["keyword", "tag", "selector", "function", "class-name", "function-variable"],
      style: { fontWeight: "600" },
    },
  ],
};

export function codeLanguage(path: string): string | null {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return LANGUAGES[name.slice(dot + 1).toLowerCase()] ?? null;
}

export function CodeView({
  code,
  language,
  startLine,
}: {
  code: string;
  language: string | null;
  startLine: number;
}) {
  if (!language) return <PlainCode code={code} startLine={startLine} />;
  return (
    <Highlight theme={quiet} code={code} language={language}>
      {({ tokens, getLineProps, getTokenProps }) => (
        <pre
          data-testid="code-view"
          className="overflow-x-auto font-mono text-body-sm leading-6 text-foreground"
        >
          {tokens.map((line, index) => (
            <div key={startLine + index} {...getLineProps({ line })} className="flex">
              <span className="w-8 shrink-0 pe-3 text-end text-muted-foreground select-none">
                {startLine + index}
              </span>
              <span>
                {line.map((token, tokenIndex) => (
                  <span key={tokenIndex} {...getTokenProps({ token })} />
                ))}
              </span>
            </div>
          ))}
        </pre>
      )}
    </Highlight>
  );
}

function PlainCode({ code, startLine }: { code: string; startLine: number }) {
  const lines = code === "" ? [] : code.split("\n");
  return (
    <pre
      data-testid="code-view"
      className="overflow-x-auto font-mono text-body-sm leading-6 whitespace-pre-wrap break-words text-foreground"
    >
      {lines.map((line, index) => (
        <div key={startLine + index} className="flex">
          <span className="w-8 shrink-0 pe-3 text-end text-muted-foreground select-none">
            {startLine + index}
          </span>
          <span>{line || " "}</span>
        </div>
      ))}
    </pre>
  );
}
