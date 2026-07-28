#!/usr/bin/env node
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { refreshPair } from "./refresh-pair-index.mjs";

const INDEX_NAMES = [
  "symbols", "call_graph", "sql_usage", "transactions", "external_io",
  "env_branches", "schema", "api_contracts", "dead_code",
];

const MARKDOWN_EXTENSIONS = /\.(?:md|mdx)$/i;
const MARKDOWN_EXCLUDED_SEGMENTS = new Set([
  ".git", ".hg", ".svn", ".cache", ".codex", ".next", ".nuxt",
  "node_modules", "vendor", "dist", "build", "out", "target", "coverage",
  "site-packages", ".venv", "venv", "pods", "_workspace_prev",
]);
const MARKDOWN_EXCLUDED_PREFIXES = [
  ".claude/wiki/", ".claude/eval-backup/", ".claude/plugins/",
  ".agents/plugins/", "plugins/ax-harness/",
];
const WIKI_REPORT_NAMES = new Set(["07_wiki_report.md", "08_system_wiki_report.md"]);

const VISUAL = {
  view: { color: "#F26B6B", shape: "ellipse", label: "화면 / Client" },
  endpoint: { color: "#4A90D9", shape: "box", label: "API / 진입점" },
  function: { color: "#9B6DE3", shape: "hexagon", label: "Service / 함수" },
  dao: { color: "#56B4D3", shape: "hexagon", label: "DAO / Repository" },
  external: { color: "#F5A623", shape: "diamond", label: "외부 시스템" },
  db_table: { color: "#56C596", shape: "database", label: "DB 테이블" },
  util: { color: "#4FC3B1", shape: "dot", label: "설정 / DTO / Util" },
};

function parseArgs(argv) {
  // --frontend는 반복 가능하다. 백엔드 1개 : 클라이언트 N개(1:N) 시스템 위키를 한 번에 만든다.
  const args = { root: null, backend: null, frontends: [], quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root") args.root = argv[++i];
    else if (argv[i] === "--backend") args.backend = argv[++i];
    else if (["--frontend", "--client", "--consumer"].includes(argv[i])) args.frontends.push(argv[++i]);
    else if (argv[i] === "--quiet") args.quiet = true;
    else if (argv[i] === "--help" || argv[i] === "-h") args.help = true;
    else throw new Error(`알 수 없는 인자: ${argv[i]}`);
  }
  if (!args.help && !args.root && !(args.backend && args.frontends.length)) throw new Error("단일 프로젝트는 --root, pair는 --backend와 1개 이상의 --frontend가 필요합니다.");
  if (args.root && (args.backend || args.frontends.length)) throw new Error("--root와 pair 인자를 함께 사용할 수 없습니다.");
  for (const key of ["root", "backend"]) if (args[key]) args[key] = resolve(args[key]);
  args.frontends = args.frontends.map((item) => resolve(item));
  return args;
}

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function readText(path, fallback = "") {
  try { return readFileSync(path, "utf8"); } catch { return fallback; }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function scriptJson(value) { return JSON.stringify(value).replaceAll("<", "\\u003c"); }
function slash(value) { return String(value || "").split(sep).join("/"); }
function ns(project, id) { return `${project}::${id}`; }
function asArray(value) { return Array.isArray(value) ? value : []; }
function labelOf(id) { return String(id || "unknown").split(/[.:/]/).filter(Boolean).at(-1) || String(id); }

function graphNoteText(value) {
  return String(value || "")
    .replace(/!?\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*|~~/g, "")
    .replace(/^\s*(?:>|[-*+])\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

const GENERIC_GRAPH_IDENTIFIERS = new Set([
  "call", "create", "delete", "execute", "get", "handle", "handler", "index",
  "init", "list", "main", "method", "operation", "post", "process", "run",
  "select", "service", "unknown", "update",
]);

function splitGraphNoteBlock(block) {
  const severityParts = String(block).split(/(?=\[(?:CRITICAL|HIGH|MEDIUM|LOW)\]\s*)/gi).filter((item) => item.trim());
  if (severityParts.length > 1) return severityParts;
  const bulletParts = String(block).split(/\r?\n(?=\s*(?:[-*+]|\d+[.)])\s+)/).filter((item) => item.trim());
  return bulletParts.length ? bulletParts : [block];
}

function graphNoteMatchesNode(note, node) {
  if (!note || note.project !== node.project) return false;
  const text = String(note.text || "").toLowerCase().replaceAll("\\", "/");
  const file = String(node.file || "").toLowerCase().replaceAll("\\", "/");
  const base = file.split("/").pop() || "";
  const original = String(node.original_id || "").toLowerCase();
  const parts = original.split(/[.:/#]+/).filter(Boolean);
  const label = String(node.label || "").toLowerCase();
  const terms = new Set();
  if (file.length > 4) terms.add(file);
  if (base.length > 4) terms.add(base);
  if (original.length > 5 && !GENERIC_GRAPH_IDENTIFIERS.has(original)) terms.add(original);
  if (parts.length >= 2) terms.add(parts.slice(-2).join("."));
  if (parts.length >= 3) terms.add(parts.slice(-3).join("."));
  if (label.length > 7 && !GENERIC_GRAPH_IDENTIFIERS.has(label)) terms.add(label);
  return [...terms].some((term) => term.length > 5 && text.includes(term));
}

function graphAnalysisNotes(project) {
  const limitation = /(인덱서|indexer|결정적\s*분석|정적\s*분석|호출\s*그래프|call\s*graph|데드\s*코드|dead[_\s-]*code|in-degree|out-degree)/i;
  const caution = /(한계|제약|누락|미탐지|오탐|검증\s*필요|자동\s*제거\s*금지|불완전|주의|위험|확인\s*필요)/i;
  const notes = []; const seen = new Set();
  for (const section of sections(project.analyzer)) {
    const limitationSection = limitation.test(section.title) && caution.test(section.title);
    const blocks = section.body.split(/\r?\n\s*\r?\n/).flatMap((block) => {
      const rows = block.split(/\r?\n/).filter((line) => /^\s*\|.*\|\s*$/.test(line) && !/^\s*\|?\s*:?-{3,}/.test(line));
      return (rows.length > 1 ? rows.slice(1) : [block]).flatMap(splitGraphNoteBlock);
    });
    for (const block of blocks) {
      const text = graphNoteText(block.replace(/\s*\|\s*/g, " · ").replace(/^ · | · $/g, ""));
      if (!text || !(limitationSection || (limitation.test(text) && caution.test(text)))) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      notes.push({ project: project.id, title: section.title, text, source: "_workspace/01_analyzer_report.md" });
    }
  }
  return notes;
}

function callGraphLinksInNewTab(html) {
  return html.replace(/<a\b([^>]*\bhref="[^"]*call-graph\.html[^"]*"[^>]*)>/gi, (match, attributes) => {
    let next = attributes;
    if (!/\bdata-call-graph-link\b/i.test(next)) next += " data-call-graph-link";
    if (!/\btarget\s*=/i.test(next)) next += ' target="_blank"';
    if (!/\brel\s*=/i.test(next)) next += ' rel="noopener noreferrer"';
    return `<a${next}>`;
  });
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, content, "utf8");
  renameSync(temp, path);
}

function markdownPathExcluded(relativePath) {
  const normalized = slash(relativePath).replace(/^\.\//, "");
  const lower = normalized.toLowerCase();
  if (!MARKDOWN_EXTENSIONS.test(lower)) return true;
  if (WIKI_REPORT_NAMES.has(basename(lower))) return true;
  if (MARKDOWN_EXCLUDED_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
  return lower.split("/").some((segment) => MARKDOWN_EXCLUDED_SEGMENTS.has(segment));
}

function walkMarkdown(root, startRelative = "") {
  const start = resolve(root, startRelative);
  if (!existsSync(start)) return [];
  const found = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const rel = slash(relative(root, absolute));
      if (entry.isDirectory()) {
        if (!markdownPathExcluded(`${rel}/placeholder.md`)) visit(absolute);
      } else if (entry.isFile() && !markdownPathExcluded(rel)) found.push(rel);
    }
  };
  if (!markdownPathExcluded(`${slash(startRelative)}/placeholder.md`)) visit(start);
  return found;
}

function gitTrackedMarkdown(root) {
  try {
    const output = execFileSync("git", ["-C", root, "ls-files", "-z", "--", "*.md", "*.mdx"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024,
    });
    return output.split("\0").filter(Boolean).map(slash).filter((path) => !markdownPathExcluded(path));
  } catch {
    return null;
  }
}

function generatedMarkdown(root) {
  const found = new Set();
  if (existsSync(join(root, "CLAUDE.md"))) found.add("CLAUDE.md");
  for (const directory of [".claude", "_workspace"]) {
    for (const path of walkMarkdown(root, directory)) found.add(path);
  }
  return [...found];
}

function markdownTitle(path, text) {
  const body = String(text || "").replace(/^---[\s\S]*?---\s*/, "");
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || basename(path).replace(MARKDOWN_EXTENSIONS, "");
}

function markdownText(text) {
  return String(text || "")
    .replace(/^---[\s\S]*?---\s*/, "")
    .replace(/!?(?:\[([^\]]*)\])\(([^)]+)\)/g, "$1 $2")
    .replace(/<[^>]+>/g, " ")
    .replace(/^[#>*+-]+\s*/gm, "")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function markdownCategory(path) {
  const lower = slash(path).toLowerCase();
  if (lower.startsWith("_workspace/")) return "Harness reports";
  if (lower === "claude.md" || lower.startsWith(".claude/")) return "Harness knowledge";
  if (/(^|\/)(adr|decision|decisions)(\/|$)|(^|\/)adr[-_]/.test(lower)) return "ADR / decisions";
  if (/(^|\/)(api|apis|openapi|swagger)(\/|$)|api[-_]/.test(lower)) return "API";
  if (/(architecture|architectural|design|diagram)/.test(lower)) return "Architecture / design";
  if (/(runbook|operation|operations|deploy|deployment|release|troubleshoot)/.test(lower)) return "Operations";
  if (/(spec|specification|requirement|requirements)/.test(lower)) return "Specifications";
  if (/^readme(?:[._-]|$)/i.test(basename(lower))) return "README";
  return "Project documents";
}

function loadMarkdownDocuments(root, project) {
  const tracked = gitTrackedMarkdown(root);
  const trackedSet = new Set(tracked || []);
  const paths = new Set(tracked === null ? walkMarkdown(root) : trackedSet);
  for (const path of generatedMarkdown(root)) paths.add(path);
  return [...paths].sort((a, b) => a.localeCompare(b)).map((path) => {
    const text = readText(join(root, ...path.split("/")));
    const digest = createHash("sha1").update(`${project}\0${path}`).digest("hex").slice(0, 10);
    const slug = `${slugify(path.replace(MARKDOWN_EXTENSIONS, ""), "document")}-${digest}`;
    const harness = path === "CLAUDE.md" || path.startsWith(".claude/") || path.startsWith("_workspace/");
    return {
      project, path, title: markdownTitle(path, text), text, plain: markdownText(text),
      category: markdownCategory(path), source: harness && !trackedSet.has(path) ? "generated" : tracked === null ? "filesystem" : "git",
      slug, url: `pages/documents/${slugify(project)}/${slug}.html`,
    };
  });
}

function loadPatterns(root) {
  const dir = join(root, ".claude", "patterns");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => ({ file: entry.name, text: readText(join(dir, entry.name)) }));
}

function loadProject(root, id, role) {
  if (!existsSync(root)) throw new Error(`프로젝트 경로가 없습니다: ${root}`);
  const indexDir = join(root, "_workspace", "index");
  const meta = readJson(join(indexDir, "_meta.json"));
  if (!meta) throw new Error(`${id}: _workspace/index/_meta.json이 없습니다.`);
  const indexes = {};
  for (const name of INDEX_NAMES) indexes[name] = readJson(join(indexDir, `${name}.json`), {});
  const indexAvailability = Object.fromEntries(INDEX_NAMES.map((name) => [name, existsSync(join(indexDir, `${name}.json`))]));
  const analysisInput = readJson(join(indexDir, "_analysis_input.json"), {});
  const unresolvedPath = join(indexDir, "_unresolved.jsonl");
  const unresolvedAvailable = existsSync(unresolvedPath);
  const unresolvedCount = unresolvedAvailable ? readText(unresolvedPath).split(/\r?\n/).filter(Boolean).length : 0;
  const validator = readJson(join(root, "_workspace", "03_validator_result.json"), {});
  if (validator.status === "FAIL") throw new Error(`${id}: validator 상태가 FAIL입니다.`);
  return {
    id, role, root, name: basename(root), meta, indexes, indexAvailability, analysisInput, unresolvedAvailable, unresolvedCount, validator,
    claude: readText(join(root, "CLAUDE.md")),
    analyzer: readText(join(root, "_workspace", "01_analyzer_report.md")),
    validatorReport: readText(join(root, "_workspace", "03_validator_report.md")),
    domain: readText(join(root, ".claude", "agents", "domain-expert.md")),
    guide: readText(join(root, ".claude", "ito-guide.md")),
    patterns: loadPatterns(root),
    documents: loadMarkdownDocuments(root, id),
  };
}

function qualitySignals(project) {
  const commands = [];
  const addCommand = (command, purpose) => { if (command && !commands.some((item) => item.command === command)) commands.push({ command, purpose }); };
  const packageJson = readJson(join(project.root, "package.json"), {});
  for (const [name, value] of Object.entries(packageJson.scripts || {})) if (/(?:test|lint|check|verify|validate|coverage|quality)/i.test(name)) {
    addCommand(name === "test" ? "npm test" : `npm run ${name}`, String(value));
  }
  if (existsSync(join(project.root, "pom.xml"))) addCommand("mvn test", "Maven test lifecycle");
  if (existsSync(join(project.root, "gradlew")) || existsSync(join(project.root, "gradlew.bat"))) addCommand("./gradlew test", "Gradle test task");
  if (existsSync(join(project.root, "pytest.ini")) || existsSync(join(project.root, "pyproject.toml"))) addCommand("pytest", "Python test suite");
  if (readdirSync(project.root, { withFileTypes: true }).some((entry) => entry.isFile() && /\.(?:sln|csproj)$/i.test(entry.name))) addCommand("dotnet test", ".NET test suite");

  const testFiles = new Set();
  for (const category of asArray(project.analysisInput?.pattern_candidates?.categories)) if (category.slug === "test" || /test|qa|검증/i.test(category.category || "")) for (const file of asArray(category.evidence_files)) testFiles.add(slash(file));
  for (const symbol of asArray(project.indexes.symbols.symbols)) if (/(?:^|\/)(?:tests?|spec|__tests__)(?:\/|$)|(?:test|spec)\.[^.\/]+$|(?:Test|Tests)\.[^.\/]+$/i.test(slash(symbol.file))) testFiles.add(slash(symbol.file));
  const visit = (relativeDir) => {
    const absolute = join(project.root, ...relativeDir.split("/").filter(Boolean));
    if (!existsSync(absolute)) return;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const relativePath = slash(join(relativeDir, entry.name));
      if (entry.isDirectory()) visit(relativePath);
      else if (entry.isFile() && /(?:^|\/)(?:tests?|spec|__tests__)(?:\/|$)/i.test(relativePath)) testFiles.add(relativePath);
    }
  };
  for (const directory of ["test", "tests", "spec", "__tests__"]) visit(directory);

  const files = [...testFiles].sort().filter((file) => {
    const absolute = resolve(project.root, ...file.split("/"));
    return !relative(project.root, absolute).startsWith("..") && existsSync(absolute);
  }).map((file) => {
    const text = readText(resolve(project.root, ...file.split("/")));
    const cases = [];
    const patterns = [
      /\b(?:test|it|describe)\s*\(\s*["'`]([^"'`]{2,160})/g,
      /^\s*def\s+(test_[A-Za-z0-9_]+)/gm,
      /^\s*func\s+(Test[A-Za-z0-9_]+)/gm,
      /@Test[\s\S]{0,160}?\b(?:void|[A-Za-z0-9_<>]+)\s+([A-Za-z0-9_]+)\s*\(/g,
    ];
    for (const pattern of patterns) for (const match of text.matchAll(pattern)) if (!cases.includes(match[1])) cases.push(match[1]);
    return { file, cases: cases.slice(0, 100) };
  });
  const reports = project.documents.filter((document) => !document.path.startsWith(".claude/patterns/") && /(?:qa|quality|test|validator|validation|coverage|검증|테스트)/i.test(`${document.path} ${document.title}`));
  return { commands, files, reports };
}

function indexArraySummary(value) {
  const counts = Object.entries(value || {})
    .filter(([, items]) => Array.isArray(items))
    .map(([key, items]) => ({ key, count: items.length }));
  return {
    total: counts.reduce((sum, item) => sum + item.count, 0),
    detail: counts.length ? counts.map((item) => `${item.key} ${item.count}`).join(" · ") : "배열 레코드 없음",
  };
}

function clientProjectId(root) {
  const meta = readJson(join(root, "_workspace", "index", "_meta.json"), {});
  const workspaces = asArray(meta.workspaces);
  const kind = workspaces.find((item) => ["frontend", "desktop", "mobile"].includes(item.kind))?.kind;
  const id = workspaces.find((item) => ["frontend", "desktop", "mobile"].includes(item.id))?.id;
  return kind || id || "frontend";
}

function projectRoleLabel(project) {
  if (project.id === "root") return "Root";
  if (project.role === "backend" || project.id === "backend") return "Backend (Server)";
  if (project.id === "desktop") return "Desktop (Client)";
  if (project.id === "mobile") return "Mobile (Client)";
  return "Frontend (Client)";
}

function sections(markdown) {
  const source = String(markdown || "");
  const found = [...source.matchAll(/^(#{2,3})\s+(.+)$/gm)].map((match) => ({ index: match.index, text: match[0], level: match[1].length, title: match[2].trim() }));
  return found.map((match, index) => {
    const next = found.slice(index + 1).find((candidate) => candidate.level <= match.level);
    return {
      title: match.title,
      level: match.level,
      body: source.slice(match.index + match.text.length, next?.index ?? source.length).trim(),
    };
  });
}

function sectionText(markdown, patterns) {
  const wanted = patterns.map((item) => item.toLowerCase());
  return sections(markdown).filter((item) => wanted.some((name) => item.title.toLowerCase().includes(name))).map((item) => `## ${item.title}\n${item.body}`).join("\n\n");
}

function inlineMarkdown(value) {
  const placeholders = [];
  const token = (html) => {
    const key = `AXINLINEPLACEHOLDER${placeholders.length}TOKEN`;
    placeholders.push([key, html]);
    return key;
  };
  let text = String(value || "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, (_, code) => token(`<code>${escapeHtml(code)}</code>`))
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
      const safe = /^(?:https?:|mailto:|#)/i.test(href.trim());
      return safe ? token(`<a href="${escapeHtml(href.trim())}">${escapeHtml(label)}</a>`) : label;
    });
  text = escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/(^|\s)\*([^*]+)\*(?=\s|$)/g, "$1<em>$2</em>");
  for (const [key, html] of placeholders) text = text.replaceAll(key, html);
  return text;
}

function markdownTableCells(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function markdownHtml(markdown) {
  const lines = String(markdown || "").replace(/^---[\s\S]*?---\s*/, "").split(/\r?\n/);
  const out = []; let list = null; let code = false; let paragraph = [];
  const flushParagraph = () => { if (paragraph.length) { out.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`); paragraph = []; } };
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const startList = (type) => { if (list !== type) { closeList(); out.push(`<${type}>`); list = type; } };
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (/^```/.test(raw)) { flushParagraph(); closeList(); code = !code; out.push(code ? "<pre><code>" : "</code></pre>"); continue; }
    if (code) { out.push(`${escapeHtml(raw)}\n`); continue; }
    const heading = raw.match(/^(#{1,4})\s+(.+)$/);
    if (heading) { flushParagraph(); closeList(); const level = Math.min(4, heading[1].length + 1); out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`); continue; }
    if (/^\|.*\|\s*$/.test(raw) && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] || "")) {
      flushParagraph(); closeList();
      const headers = markdownTableCells(raw); index += 1; const rows = [];
      while (/^\|.*\|\s*$/.test(lines[index + 1] || "")) rows.push(markdownTableCells(lines[++index]));
      out.push(`<div class="table-wrap"><table><thead><tr>${headers.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_, cellIndex) => `<td>${inlineMarkdown(row[cellIndex] || "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    const bullet = raw.match(/^\s*[-*+]\s+(.+)$/);
    if (bullet) { flushParagraph(); startList("ul"); out.push(`<li>${inlineMarkdown(bullet[1])}</li>`); continue; }
    const ordered = raw.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ordered) { flushParagraph(); startList("ol"); out.push(`<li>${inlineMarkdown(ordered[1])}</li>`); continue; }
    const quote = raw.match(/^>\s?(.*)$/);
    if (quote) { flushParagraph(); closeList(); out.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`); continue; }
    if (/^\s*(?:---+|___+)\s*$/.test(raw)) { flushParagraph(); closeList(); out.push("<hr>"); continue; }
    if (!raw.trim()) { flushParagraph(); closeList(); continue; }
    paragraph.push(raw.trim());
  }
  flushParagraph(); closeList(); if (code) out.push("</code></pre>");
  return out.join("\n") || '<p class="muted">기록된 내용이 없습니다.</p>';
}

function tokenize(value) {
  const normalized = String(value || "").normalize("NFKC");
  const raw = normalized.toLowerCase();
  const expanded = normalized.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_.$/\\:-]+/g, " ").toLowerCase();
  const base = raw.split(/[^\p{L}\p{N}_.$-]+/u).filter((x) => x.length > 1);
  const parts = expanded.split(/[^\p{L}\p{N}]+/u).filter((x) => x.length > 1);
  return [...new Set([...base, ...parts])];
}

function slugify(value, fallback = "domain") {
  const slug = String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 80);
  return slug || fallback;
}

function firstParagraph(markdown) {
  const body = String(markdown || "").replace(/^---[\s\S]*?---\s*/, "");
  for (const block of body.split(/\r?\n\s*\r?\n/)) {
    const text = block.trim();
    if (!text || /^(?:#|\||```|[-*]\s)/.test(text)) continue;
    const plain = markdownText(text);
    if (plain.length >= 20) return plain;
  }
  return "";
}

function analyzerValue(markdown, labels) {
  const pattern = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return String(markdown || "").match(new RegExp(`^\\s*[-*]\\s*(?:${pattern})\\s*:\\s*(.+)$`, "mi"))?.[1]?.trim() || "";
}

function extractStackChips(project) {
  const values = [];
  for (const workspace of asArray(project.meta.workspaces)) if (workspace.stack) values.push(workspace.stack);
  const stackText = sectionText(project.claude, ["기술 스택", "tech stack", "technology"]);
  for (const line of stackText.split(/\r?\n/)) {
    const clean = line.replace(/^#+\s+.*$/, "").replace(/^\s*[-*]\s*/, "").trim();
    if (!clean) continue;
    values.push(...clean.split(/\s+\/\s+|\s+·\s+|\s*;\s*/));
  }
  return [...new Set(values.map((value) => markdownText(value).replace(/^(?:스택|stack)\s*:\s*/i, "").trim()).filter((value) => value.length > 1))].slice(0, 12);
}

function extractRisks(project) {
  const result = []; const seen = new Set();
  const riskSections = sections(project.claude).filter((section) => /(주의|위험|risk|security|known issue)/i.test(section.title));
  for (const section of riskSections) for (const line of section.body.split(/\r?\n/)) {
    const match = line.match(/^\s*[-*]\s+(.+)$/); if (!match) continue;
    const text = markdownText(match[1]); if (!text) continue;
    const severity = /\b(?:보안\s*)?HIGH\b|치명|심각/i.test(text) ? "HIGH" : /\bMEDIUM\b|주의|경고/i.test(text) ? "MEDIUM" : "INFO";
    const key = text.toLowerCase().slice(0, 160); if (seen.has(key)) continue;
    seen.add(key); result.push({ project: project.id, severity, text });
  }
  return result;
}

function projectIdentity(project) {
  const analyzerName = analyzerValue(project.analyzer, ["이름", "name"]);
  const claudeHeading = String(project.claude || "").match(/^#\s+(.+)$/m)?.[1]?.replace(/^CLAUDE\.md$/i, "").trim();
  const title = analyzerName || claudeHeading || project.name;
  const summary = firstParagraph(project.claude) || firstParagraph(sectionText(project.analyzer, ["분석 개요", "시스템 목적과 업무 범위", "프로젝트 기본", "project overview"])) || `${project.name} 코드베이스`;
  return { id: project.id, role: project.role, title, summary, stacks: extractStackChips(project), risks: extractRisks(project) };
}

function pageSummary(page) {
  const summaries = {
    overview: "프로젝트 목적·스택·분석 범위와 핵심 통계",
    business: "사용자·업무 역량·핵심 업무 여정과 성공/실패 조건",
    onboarding: "신규 담당자의 첫날·첫 주·실행·디버깅·안전 수칙",
    architecture: "구조적 책임·런타임 흐름·경계·설계 결정과 근거",
    workflows: "하네스 스킬·개발 및 유지보수 절차",
    qa: "validator·테스트 명령·테스트 파일과 케이스·QA 보고서",
    documents: "README·설계·ADR·하네스 보고서 원문",
    "data-model": "테이블·컬럼·키·관계와 근거",
    sql: "SQL 사용처와 API 엔드포인트",
    transactions: "트랜잭션 경계·외부 호출·원자성 위험",
    "external-io": "외부 시스템·프로토콜·timeout·retry",
    conventions: "프로젝트에서 추출한 코드 패턴·실제 예시·file:line 근거",
    risks: "보안·정합성·환경 분기·미해결 항목",
    "api-contracts": "클라이언트 호출과 백엔드 endpoint 매칭",
    coverage: "스택별 결정적 분석 수준과 미지원 파일",
  };
  if (page.kind === "domain") return page.domain?.summary || "도메인 지식과 관련 코드";
  if (page.kind === "repository") return `${page.project} 스택·인덱스·검증·위험`;
  return summaries[page.id] || page.title;
}

function narrativeText(narrative, keys) {
  return keys.map((key) => narrative?.[key]).filter(Boolean).map((value) => typeof value === "string" ? value : JSON.stringify(value)).join("\n");
}

function evidenceParts(value) {
  const match = String(value || "").trim().match(/^(?:([^:]+)::)?(.+):(\d+)$/);
  return match ? { project: match[1] || null, path: slash(match[2]), line: Number(match[3]) } : null;
}

function validateNarrative(narrative, projects) {
  if (!narrative || !Object.keys(narrative).length) return { status: "MISSING", findings: ["wiki-narrative.json 없음"], aiCalls: 0, evidenceCount: 0 };
  const findings = [];
  if (Number(narrative.version) < 2) findings.push("narrative schema version 2 필요");
  for (const key of ["system_overview", "business_capabilities", "critical_user_journeys", "architecture", "onboarding"]) if (!narrative[key]) findings.push(`필수 섹션 누락: ${key}`);
  const expectedSource = Object.fromEntries(projects.map((project) => [project.id, project.analysisInput?.generated_at]).filter(([, value]) => value));
  const actualSource = narrative.source_generated_at;
  if (Object.keys(expectedSource).length) {
    const matches = typeof actualSource === "string"
      ? projects.length === 1 && actualSource === Object.values(expectedSource)[0]
      : Object.entries(expectedSource).every(([project, value]) => actualSource?.[project] === value);
    if (!matches) findings.push("분석 입력보다 narrative가 오래되었거나 source_generated_at이 다름");
  }
  const evidence = [];
  const visit = (value, key = "") => {
    if (key === "evidence") for (const item of asArray(value)) evidence.push(item);
    else if (Array.isArray(value)) value.forEach((item) => visit(item));
    else if (value && typeof value === "object") Object.entries(value).forEach(([childKey, child]) => visit(child, childKey));
  };
  visit(narrative);
  for (const item of evidence) {
    const parts = evidenceParts(item);
    if (!parts || parts.path.includes("..") || /^[/\\]/.test(parts?.path || "")) { findings.push(`잘못된 evidence 형식: ${item}`); continue; }
    const candidates = parts.project ? projects.filter((project) => project.id === parts.project) : projects;
    const owner = candidates.find((project) => {
      const absolute = resolve(project.root, parts.path);
      return !relative(project.root, absolute).startsWith("..") && existsSync(absolute);
    });
    if (!owner) { findings.push(`evidence 파일 없음: ${item}`); continue; }
    const lineCount = readText(resolve(owner.root, parts.path)).split(/\r?\n/).length;
    if (parts.line < 1 || parts.line > lineCount) findings.push(`evidence 줄 범위 초과: ${item}`);
  }
  const stale = findings.some((item) => item.includes("오래되었거나"));
  return {
    status: stale ? "STALE" : findings.length ? "WARN" : "PASS",
    findings, evidenceCount: evidence.length,
    aiCalls: Number(narrative.generation?.ai_calls || 0),
  };
}

function evidenceHtml(items) {
  const values = asArray(items);
  return values.length ? `<p class="evidence"><b>근거</b> ${values.map((item) => `<code>${escapeHtml(item)}</code>`).join(" ")}</p>` : "";
}

function bulletHtml(items, empty = "확인된 항목 없음") {
  const values = asArray(items);
  return values.length ? `<ul>${values.map((item) => `<li>${escapeHtml(typeof item === "string" ? item : item.title || item.name || JSON.stringify(item))}</li>`).join("")}</ul>` : `<p class="muted">${escapeHtml(empty)}</p>`;
}

function businessNarrativeHtml(narrative, projects, narrativeStatus) {
  const overview = narrative.system_overview || {};
  const capabilities = asArray(narrative.business_capabilities);
  const journeys = asArray(narrative.critical_user_journeys);
  const status = narrativeStatus.status === "PASS"
    ? '<span class="badge high">근거 검증 PASS</span>'
    : `<div class="alert warn"><b>서술 보강 상태: ${escapeHtml(narrativeStatus.status)}</b> — 아래 결정적 분석 근거는 계속 제공되지만 업무 해설은 제한적일 수 있습니다.</div>`;
  const purpose = overview.purpose || (typeof narrative.overview === "string" ? narrative.overview : "");
  const capabilityCards = capabilities.map((item) => `<article class="card"><div class="eyebrow">Business capability</div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.summary || "")}</p><p><b>사용자/주체</b> ${asArray(item.actors).map(escapeHtml).join(" · ") || "-"}</p><p><b>진입점</b> ${asArray(item.entry_points).map((value) => `<code>${escapeHtml(value)}</code>`).join(" ") || "-"}</p><p><b>핵심 데이터</b> ${asArray(item.data).map(escapeHtml).join(" · ") || "-"}</p>${evidenceHtml(item.evidence)}</article>`).join("");
  const journeySections = journeys.map((journey) => {
    const steps = asArray(journey.steps).map((step) => `<div class="step"><b>${escapeHtml(step.title || step.name || "단계")}</b><div>${escapeHtml(step.description || "")}</div>${evidenceHtml(step.evidence)}</div>`).join("");
    return `<article class="card"><div class="eyebrow">${escapeHtml(journey.actor || "업무 주체")} · ${escapeHtml(journey.trigger || "트리거")}</div><h3>${escapeHtml(journey.name)}</h3><div class="timeline">${steps}</div><h3>완료 조건</h3><p>${escapeHtml(journey.success || "런타임 확인 필요")}</p><h3>실패·예외 경로</h3>${bulletHtml(journey.failure_paths)}<h3>운영 확인</h3>${bulletHtml(journey.operational_checks)}${evidenceHtml(journey.evidence)}</article>`;
  }).join("");
  const deterministic = projects.map((project) => `<h2>${escapeHtml(project.id)} 분석 원문 근거</h2>${markdownHtml(sectionText(project.analyzer, ["시스템 목적과 업무 범위", "주요 업무 흐름", "도메인", "불변조건", "분석 개요"]))}`).join("");
  return `<h1>업무 이해</h1>${status}<section class="card cta"><div class="eyebrow">왜 존재하는 시스템인가</div><h2 style="margin-top:6px">${escapeHtml(overview.title || "시스템 목적")}</h2><p>${escapeHtml(purpose || "분석 문서의 목적·업무 범위를 확인하세요.")}</p><div class="two-col"><div><h3>주요 사용자</h3>${bulletHtml(overview.users)}</div><div><h3>기대하는 업무 결과</h3>${bulletHtml(overview.business_outcomes)}</div></div>${evidenceHtml(overview.evidence)}</section><h2>업무 역량</h2><div class="cards">${capabilityCards || '<p class="muted">구조화된 업무 역량 설명 없음</p>'}</div><h2>핵심 업무 여정</h2><div class="cards">${journeySections || '<p class="muted">구조화된 업무 여정 설명 없음</p>'}</div><section class="prose">${deterministic}</section>`;
}

function onboardingNarrativeHtml(narrative, projects, narrativeStatus) {
  const onboarding = narrative.onboarding || {};
  const checklist = (title, items) => `<section class="card"><h2 style="margin-top:0">${escapeHtml(title)}</h2>${bulletHtml(items)}</section>`;
  const readingRows = asArray(onboarding.reading_order).map((item, index) => [String(index + 1), escapeHtml(item.title || item.target), escapeHtml(item.why || ""), `<code>${escapeHtml(item.target || "")}</code>`, asArray(item.evidence).map((value) => `<code>${escapeHtml(value)}</code>`).join(" ")]);
  const debuggingRows = asArray(onboarding.debugging_entry_points).map((item) => [escapeHtml(item.symptom || item.title || "증상"), escapeHtml(item.start || item.entry || ""), escapeHtml(item.check || item.description || ""), asArray(item.evidence).map((value) => `<code>${escapeHtml(value)}</code>`).join(" ")]);
  const fallback = narrativeStatus.status === "PASS" ? "" : `<div class="alert warn"><b>온보딩 서술 상태: ${escapeHtml(narrativeStatus.status)}</b> — 실행 명령과 안전 수칙은 프로젝트 문서 원문에서도 교차 확인하세요.</div>`;
  const guideEvidence = projects.map((project) => `<h2>${escapeHtml(project.id)} 실행·유지보수 원문</h2>${markdownHtml(sectionText(project.claude, ["주요 파일과 명령", "작업 주의사항", "기술 스택", "실행"]))}${markdownHtml(project.guide)}`).join("");
  return `<h1>신규 담당자 시작하기</h1><p class="muted">코드를 모두 읽기 전에 업무 맥락, 실행 경로, 안전 경계를 순서대로 익히는 안내서입니다.</p>${fallback}<div class="two-col">${checklist("첫날", onboarding.first_day)}${checklist("첫 주", onboarding.first_week)}</div><h2>권장 읽기 순서</h2>${readingRows.length ? table(["순서", "문서/코드", "읽는 이유", "위치", "근거"], readingRows) : '<p class="muted">구조화된 읽기 순서 없음</p>'}<div class="two-col">${checklist("로컬 실행", onboarding.local_run)}${checklist("안전한 첫 작업", onboarding.safe_first_tasks)}</div><div class="two-col">${checklist("변경 전 반드시 확인", onboarding.do_not_change_without)}${checklist("첫 PR 완료 기준", onboarding.first_pr_definition_of_done)}</div><h2>장애·디버깅 시작점</h2>${debuggingRows.length ? table(["증상", "시작점", "확인할 것", "근거"], debuggingRows) : '<p class="muted">구조화된 디버깅 시작점 없음</p>'}<section class="prose">${guideEvidence}</section>`;
}

function architectureNarrativeHtml(narrative, projects, system) {
  const architecture = narrative.architecture;
  if (!architecture || typeof architecture === "string") return `${architecture ? `<section class="card prose">${markdownHtml(architecture)}</section>` : ""}`;
  const layerRows = asArray(architecture.layers).map((item) => [escapeHtml(item.name), escapeHtml(item.responsibility), asArray(item.components).map((value) => `<code>${escapeHtml(value)}</code>`).join(" "), asArray(item.evidence).map((value) => `<code>${escapeHtml(value)}</code>`).join(" ")]);
  const decisionCards = asArray(architecture.decisions).map((item) => `<article class="card"><div class="eyebrow">Architecture decision</div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.rationale || "")}</p><h3>Trade-off</h3>${bulletHtml(item.tradeoffs)}${evidenceHtml(item.evidence)}</article>`).join("");
  const runtime = asArray(architecture.runtime_flow).map((item) => `<div class="step"><b>${escapeHtml(item.title || item.name || "단계")}</b><div>${escapeHtml(item.description || (typeof item === "string" ? item : ""))}</div>${evidenceHtml(item.evidence)}</div>`).join("");
  const boundaries = asArray(architecture.boundaries).map((item) => `<article class="card"><h3>${escapeHtml(item.name || item.title)}</h3><p>${escapeHtml(item.description || "")}</p><p><b>소유</b> ${escapeHtml(item.owner || "-")}</p>${evidenceHtml(item.evidence)}</article>`).join("");
  return `<section class="card cta"><div class="eyebrow">${escapeHtml(architecture.style || (system ? "Integrated system" : "System architecture"))}</div><p>${escapeHtml(architecture.summary || "")}</p>${evidenceHtml(architecture.evidence)}</section><h2>구조적 책임</h2>${layerRows.length ? table(["계층/영역", "책임", "구성요소", "근거"], layerRows) : ""}<h2>대표 런타임 흐름</h2><div class="timeline">${runtime || '<p class="muted">구조화된 런타임 흐름 없음</p>'}</div><h2>시스템 경계</h2><div class="cards">${boundaries || '<p class="muted">구조화된 경계 설명 없음</p>'}</div><h2>핵심 설계 결정</h2><div class="cards">${decisionCards || '<p class="muted">명시적으로 확인된 설계 결정 없음</p>'}</div>`;
}

function siteIdentity(projects, system) {
  const projectItems = projects.map((project) => ({ project, ...projectIdentity(project) }));
  const backend = projectItems.find((item) => item.role === "backend") || projectItems[0];
  const clients = projectItems.filter((item) => item.role === "client");
  const title = system ? `${backend.title} · 통합 시스템 위키` : backend.title;
  const summary = system && clients.length
    ? `${clients.map((item) => item.title).join(", ")} → API 계약 → ${backend.title}를 하나의 지식 베이스로 탐색합니다.${clients.length > 1 ? ` 클라이언트 ${clients.length}개가 같은 백엔드를 사용합니다.` : ""}`
    : backend.summary;
  return {
    title, summary, projectItems,
    stacks: [...new Set(projectItems.flatMap((item) => item.stacks))],
    risks: projectItems.flatMap((item) => item.risks),
    system,
  };
}

function projectStats(project) {
  const i = project.indexes;
  return {
    symbols: asArray(i.symbols.symbols).length,
    nodes: asArray(i.call_graph.nodes).length,
    edges: asArray(i.call_graph.edges).length,
    sql: asArray(i.sql_usage.sqls).length,
    tables: asArray(i.schema.tables).length,
    transactions: asArray(i.transactions.boundaries).length,
    external: asArray(i.external_io.communications).length,
    endpoints: asArray(i.api_contracts.endpoints).filter((x) => x.source !== "external").length,
    consumers: asArray(i.api_contracts.consumers).filter((x) => x.source !== "external").length,
    unresolved: Number(project.meta.unresolved_count || 0),
  };
}

function classifyNode(item) {
  const value = `${item.id || ""} ${item.file || ""} ${item.type || ""}`.toLowerCase();
  if (item.type === "trigger" || /\.(?:jsp|jspx|asp|aspx|ascx|xaml|razor|cshtml|vbhtml)$/.test(value)) return "view";
  if (/(controller|router|route|endpoint|action)/.test(value)) return "endpoint";
  if (/(view|component|page|screen|activity|fragment|form|jsp|tsx|vue)/.test(value)) return "view";
  if (/(dao|repository|mapper|persistence)/.test(value)) return "dao";
  if (/(dto|entity|model|config|util|helper|constant|filter|middleware)/.test(value)) return "util";
  return "function";
}

function dbRelations(project) {
  const relations = [...asArray(project.indexes.schema.relations)];
  if (!relations.some((item) => item.type === "foreign_key")) {
    for (const table of asArray(project.indexes.schema.tables)) for (const foreignKey of asArray(table.foreign_keys)) relations.push({
      type: "foreign_key", name: foreignKey.name || "", from_table: table.name, from_columns: asArray(foreignKey.columns),
      to_table: foreignKey.references_table, to_columns: asArray(foreignKey.references_columns),
      file: table.source_file, line: foreignKey.line, evidence: foreignKey.name || "DDL FOREIGN KEY",
      origin: foreignKey.origin || table.origin, confidence: foreignKey.confidence || "HIGH",
    });
  }
  const seen = new Set();
  return relations.filter((item) => {
    if (!item?.from_table || !item?.to_table) return false;
    const key = `${item.type}:${item.from_table}:${asArray(item.from_columns).join(",")}:${item.to_table}:${asArray(item.to_columns).join(",")}:${item.file || ""}:${item.line || ""}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

const CARDINALITY_LABEL = {
  one_to_one: "1:1", one_to_many: "1:N", many_to_one: "N:1", many_to_many: "N:M", unknown: "다중성 미확정",
};

function cardinalityLabel(relation) {
  return CARDINALITY_LABEL[relation?.cardinality] || CARDINALITY_LABEL.unknown;
}

// 관계는 근거 종류가 서로 다르므로 색·선 모양·신뢰도 배지를 분리한다.
// DDL FK와 ORM 매핑은 선언된 근거이고 SQL JOIN은 쿼리에서 추론한 논리 관계다.
function relationStyle(type) {
  if (type === "query_join") return { label: "SQL JOIN 추론", color: "#f0b72f", dashes: true, badge: "medium" };
  if (type === "orm_relation") return { label: "ORM 매핑", color: "#4493f8", dashes: [7, 4], badge: "high" };
  return { label: "DDL FK", color: "#56c596", dashes: false, badge: "high" };
}

function derivedRelations(project) {
  return asArray(project.indexes.schema.derived_relations).filter((item) => item?.from_table && item?.to_table && item?.via_table);
}

function buildGraph(projects) {
  const nodeMap = new Map(); const edges = []; const edgeKeys = new Set();
  const endpointMap = new Map(); const consumerMap = new Map();
  const endpointRecords = []; const consumerRecords = []; const deadRecords = new Map();
  const backendId = projects.find((project) => project.role === "backend")?.id;
  // 1:N에서는 백엔드 인덱스에 여러 클라이언트의 external 항목이 섞이므로
  // external_repo_path로 실제 소유 클라이언트를 찾아 귀속시킨다.
  const clientProjects = projects.filter((project) => project.role === "client");
  const clientByRoot = new Map(clientProjects.map((project) => [slash(project.root).toLowerCase(), project.id]));
  const clientById = new Map(clientProjects.map((project) => [project.id, project.id]));
  const ownerOf = (item, project) => {
    if (item.source !== "external") return project.id;
    return clientByRoot.get(slash(resolve(String(item.external_repo_path || ""))).toLowerCase())
      || clientById.get(item.external_repo_id)
      || clientProjects[0]?.id
      || project.id;
  };
  const addNode = (node) => {
    const current = nodeMap.get(node.id);
    nodeMap.set(node.id, current ? { ...current, ...Object.fromEntries(Object.entries(node).filter(([, value]) => value !== undefined && value !== "")) } : node);
  };
  const addEdge = (edge) => {
    const relationKey = edge.type === "table_relation" ? `:${asArray(edge.from_columns).join(",")}:${asArray(edge.to_columns).join(",")}:${edge.relation_type || ""}` : "";
    const key = `${edge.from}->${edge.to}:${edge.type || edge.label}${relationKey}`;
    if (!edgeKeys.has(key) && (edge.from !== edge.to || edge.type === "table_relation")) { edgeKeys.add(key); edges.push(edge); }
  };

  for (const project of projects) {
    for (const item of asArray(project.indexes.call_graph.nodes)) {
      const id = ns(project.id, item.id);
      addNode({
        id, label: labelOf(item.id), group: classifyNode(item), raw_type: item.type,
        project: project.id, workspace: item.workspace, file: item.file, line: item.line,
        signature: item.signature, visibility: item.visibility, static: item.static,
        annotations: asArray(item.annotations), original_id: item.id,
        origin: item.origin, confidence: item.confidence,
        title: `${project.id}\n${item.id}\n${item.file || ""}:${item.line || ""}`,
      });
    }
    for (const item of asArray(project.indexes.call_graph.edges)) {
      const from = ns(project.id, item.from); const to = ns(project.id, item.to);
      addNode({ id: from, label: labelOf(item.from), group: "function", project: project.id, original_id: item.from });
      addNode({ id: to, label: labelOf(item.to), group: "function", project: project.id, original_id: item.to });
      addEdge({ from, to, label: item.type || "call", type: item.type || "call", arrows: "to", project: project.id, file: item.file, line: item.line, evidence: item.evidence, origin: item.origin, confidence: item.confidence });
    }
    for (const item of asArray(project.indexes.dead_code.unused_methods)) deadRecords.set(ns(project.id, item.id), item);

    for (const endpoint of asArray(project.indexes.api_contracts.endpoints)) {
      const ownerId = endpoint.source === "external" && backendId ? backendId : project.id;
      const handler = endpoint.handler && nodeMap.has(ns(ownerId, endpoint.handler)) ? ns(ownerId, endpoint.handler) : ns(ownerId, `endpoint:${endpoint.id}`);
      addNode({ id: handler, label: `${endpoint.method || ""} ${endpoint.path || endpoint.path_pattern || endpoint.id}`, group: "endpoint", project: ownerId, file: endpoint.file, line: endpoint.line, original_id: endpoint.handler || endpoint.id, signature: `${endpoint.method || ""} ${endpoint.path || endpoint.path_pattern || ""}`, title: `${ownerId}\n${endpoint.method || ""} ${endpoint.path || ""}` });
      if (!endpointMap.has(endpoint.id) || endpoint.source !== "external") endpointMap.set(endpoint.id, handler);
      if (endpoint.source !== "external") endpointRecords.push({ ...endpoint, project: ownerId, nodeId: handler });
    }
    for (const consumer of asArray(project.indexes.api_contracts.consumers)) {
      const ownerId = ownerOf(consumer, project);
      const id = ns(ownerId, `consumer:${consumer.id}`);
      addNode({ id, label: consumer.function || `${consumer.method || ""} ${consumer.path_literal || consumer.id}`, group: "view", project: ownerId, file: consumer.file, line: consumer.line, original_id: consumer.id, signature: `${consumer.method || ""} ${consumer.path_literal || consumer.path_pattern || ""}` });
      if (!consumerMap.has(consumer.id) || consumer.source !== "external") consumerMap.set(consumer.id, id);
      if (consumer.source !== "external") consumerRecords.push({ ...consumer, project: ownerId, nodeId: id });
    }

    for (const communication of asArray(project.indexes.external_io.communications)) {
      const id = ns(project.id, `external:${communication.id}`);
      addNode({ id, label: communication.target || communication.topic || communication.type || communication.id, group: "external", project: project.id, file: communication.file, line: communication.line, original_id: communication.id, signature: communication.type, target: communication.target || communication.topic });
      if (communication.method) {
        const from = ns(project.id, communication.method);
        addNode({ id: from, label: labelOf(communication.method), group: "function", project: project.id, original_id: communication.method });
        addEdge({ from, to: id, label: communication.type || "external_io", type: "external_io", arrows: "to", project: project.id, file: communication.file, line: communication.line });
      }
    }

    const tables = new Map();
    for (const table of asArray(project.indexes.schema.tables)) tables.set(String(table.name).toLowerCase(), table);
    for (const sql of asArray(project.indexes.sql_usage.sqls)) for (const name of asArray(sql.tables)) if (!tables.has(String(name).toLowerCase())) tables.set(String(name).toLowerCase(), { name });
    for (const table of tables.values()) addNode({ id: ns(project.id, `table:${table.name}`), label: table.name, group: "db_table", project: project.id, file: table.source_file, original_id: table.name, signature: `${asArray(table.columns).length} columns` });
    const sqlById = new Map(asArray(project.indexes.sql_usage.sqls).map((sql) => [sql.id, sql]));
    for (const usage of asArray(project.indexes.sql_usage.usages)) {
      const sql = sqlById.get(usage.sql_id); if (!sql) continue;
      const from = ns(project.id, usage.method || `sql:${usage.sql_id}`);
      addNode({ id: from, label: labelOf(usage.method || usage.sql_id), group: usage.method ? "dao" : "function", project: project.id, file: usage.file, line: usage.line, original_id: usage.method || usage.sql_id });
      for (const table of asArray(sql.tables)) {
        const canonical = tables.get(String(table).toLowerCase())?.name || table;
        addEdge({ from, to: ns(project.id, `table:${canonical}`), label: "sql", type: "sql", arrows: "to", project: project.id, file: usage.file, line: usage.line });
      }
    }
    const resolveTable = (name) => {
      const exact = tables.get(String(name || "").toLowerCase());
      if (exact) return exact.name;
      const simple = String(name || "").split(".").at(-1).toLowerCase();
      return [...tables.values()].find((table) => String(table.name).split(".").at(-1).toLowerCase() === simple)?.name || name;
    };
    for (const relation of dbRelations(project)) {
      const fromName = resolveTable(relation.from_table); const toName = resolveTable(relation.to_table);
      const from = ns(project.id, `table:${fromName}`); const to = ns(project.id, `table:${toName}`);
      addNode({ id: from, label: fromName, group: "db_table", project: project.id, original_id: fromName });
      addNode({ id: to, label: toName, group: "db_table", project: project.id, original_id: toName });
      const style = relationStyle(relation.type);
      addEdge({
        from, to, label: `${style.label} ${cardinalityLabel(relation)}`, type: "table_relation", relation_type: relation.type,
        arrows: relation.type === "query_join" ? undefined : "to", dashes: style.dashes, color: style.color,
        project: project.id, file: relation.file, line: relation.line, evidence: relation.evidence,
        from_columns: asArray(relation.from_columns), to_columns: asArray(relation.to_columns),
        cardinality: relation.cardinality || "unknown", cardinality_basis: relation.cardinality_basis || "",
        confidence: relation.confidence, origin: relation.origin,
      });
    }
  }

  for (const project of projects) for (const match of asArray(project.indexes.api_contracts.matches)) {
    const from = consumerMap.get(match.consumer_id); const to = endpointMap.get(match.endpoint_id);
    if (from && to) addEdge({ from, to, label: "api_contract", type: "api_contract", arrows: "to", dashes: true, color: "#ffcc66", confidence: match.confidence });
  }
  for (const consumer of consumerRecords) for (const endpoint of endpointRecords) {
    if (endpoint.prefix_resolved === false) continue;
    const methodMatches = endpoint.method === "ANY" || consumer.method === "ANY" || endpoint.method === consumer.method;
    if (methodMatches && endpoint.path_pattern && endpoint.path_pattern === consumer.path_pattern) addEdge({ from: consumer.nodeId, to: endpoint.nodeId, label: "api_contract", type: "api_contract", arrows: "to", dashes: true, color: "#ffcc66", confidence: "HIGH" });
  }

  const nodes = [...nodeMap.values()];
  const inDegree = new Map(nodes.map((node) => [node.id, 0]));
  const outDegree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    inDegree.set(edge.to, (inDegree.get(edge.to) || 0) + 1);
    outDegree.set(edge.from, (outDegree.get(edge.from) || 0) + 1);
  }
  const hubThreshold = Math.max(5, Math.ceil(nodes.length * 0.15));
  const analysisNotes = projects.flatMap(graphAnalysisNotes);
  for (const node of nodes) {
    const dead = deadRecords.get(node.id);
    const verifiedDead = String(dead?.confidence || "").toUpperCase() === "HIGH" && Boolean(dead?.evidence);
    node.dead = verifiedDead; node.dead_reason = verifiedDead ? dead.reason : undefined; node.dead_evidence = verifiedDead ? dead.evidence : undefined;
    node.in_degree = inDegree.get(node.id) || 0; node.out_degree = outDegree.get(node.id) || 0; node.hub = node.in_degree >= hubThreshold;
    node.opacity = node.dead ? 0.4 : 1; if (node.hub) { node.size = 28; node.borderWidth = 3; }
    const matchedNotes = analysisNotes.filter((note) => graphNoteMatchesNode(note, node));
    if (matchedNotes.length) node.analysis_notes = matchedNotes;
  }
  return { nodes, edges, hubThreshold, visual: VISUAL, projectLabels: Object.fromEntries(projects.map((project) => [project.id, projectRoleLabel(project)])) };
}

function deriveDomains(projects, narrative) {
  const result = []; const seen = new Set();
  const ignored = /(개요|기술|역할|책임|흐름|위험|불변|용어|주의|워크스페이스|프로젝트|도메인 지식|domain knowledge)/i;
  const add = (item) => { const key = `${item.project}:${item.name}`; if (!seen.has(key)) { seen.add(key); result.push(item); } };
  for (const project of projects) {
    for (const part of sections(project.domain)) {
      if (/(도메인|용어|glossary)/i.test(part.title)) {
        for (const line of part.body.split(/\r?\n/)) {
          const cells = /^\|.*\|$/.test(line) ? line.split("|").slice(1, -1).map((x) => x.trim()) : [];
          if (cells.length >= 2 && !/^[-:]+$/.test(cells[0]) && !/(용어|도메인|name|term)/i.test(cells[0])) add({ project: project.id, name: cells[0], summary: cells.slice(1).join(" · ").slice(0, 500), body: cells.slice(1).join("\n") });
          const bullet = line.match(/^\s*[-*]\s*([^:：]{2,40})[:：]\s*(.+)$/);
          if (bullet) add({ project: project.id, name: bullet[1].trim(), summary: bullet[2].trim().slice(0, 500), body: bullet[2].trim() });
        }
      }
      if (ignored.test(part.title) || part.body.length < 20) continue;
      add({ project: project.id, name: part.title, summary: part.body.slice(0, 500), body: part.body });
    }
  }
  for (const item of asArray(narrative.domains)) {
    add({ project: "system", name: item.name, summary: item.summary || "", body: `${item.summary || ""}\n\n${asArray(item.evidence).map((x) => `- ${x}`).join("\n")}` });
  }
  return result.map((item, index) => ({ ...item, slug: `${slugify(item.project)}-${slugify(item.name, `domain-${index + 1}`)}` }));
}

function collectApiPairs(projects) {
  const endpoints = projects.flatMap((project) => asArray(project.indexes.api_contracts.endpoints).filter((x) => x.source !== "external").map((x) => ({ ...x, project: project.id })));
  const consumers = projects.flatMap((project) => asArray(project.indexes.api_contracts.consumers).filter((x) => x.source !== "external").map((x) => ({ ...x, project: project.id })));
  const pairs = []; const matchedEndpoints = new Set(); const matchedConsumers = new Set();
  for (const consumer of consumers) for (const endpoint of endpoints) {
    if (endpoint.prefix_resolved === false) continue;
    const methodMatches = endpoint.method === "ANY" || consumer.method === "ANY" || endpoint.method === consumer.method;
    if (!methodMatches || !endpoint.path_pattern || endpoint.path_pattern !== consumer.path_pattern) continue;
    matchedEndpoints.add(endpoint.id); matchedConsumers.add(consumer.id); pairs.push({ consumer, endpoint, confidence: "HIGH", match_type: "deterministic pair match" });
  }
  return { endpoints, consumers, pairs, unmatchedEndpoints: endpoints.filter((x) => !matchedEndpoints.has(x.id)), unmatchedConsumers: consumers.filter((x) => !matchedConsumers.has(x.id)) };
}

function pageCatalog(projects, narrative, system) {
  const has = (name, key) => projects.some((project) => asArray(project.indexes[name]?.[key]).length);
  const analyzerHas = (patterns) => projects.some((project) => sectionText(project.analyzer, patterns).trim());
  const domains = deriveDomains(projects, narrative);
  const documents = projects.flatMap((project) => project.documents);
  const analyzerText = projects.map((project) => project.analyzer).join("\n");
  const workflowText = projects.map((project) => `${project.claude}\n${project.guide}`).join("\n");
  const pages = [
    { id: "overview", title: "시스템 개요", url: "pages/overview.html", kind: "page", navGroup: "start", text: sectionText(analyzerText, ["프로젝트 기본", "coverage", "탐지 신뢰도"]) },
    { id: "business", title: "업무 이해", url: "pages/business.html", kind: "page", navGroup: "start", text: narrativeText(narrative, ["system_overview", "business_capabilities", "critical_user_journeys", "domains"]) },
    { id: "onboarding", title: "신규 담당자 시작하기", url: "pages/onboarding.html", kind: "page", navGroup: "start", text: narrativeText(narrative, ["onboarding", "operations"]) },
    { id: "architecture", title: "아키텍처", url: "pages/architecture.html", kind: "page", navGroup: "start", text: sectionText(analyzerText, ["아키텍처", "주요 흐름", "요청 흐름"]) },
    { id: "workflows", title: "개발 워크플로우", url: "pages/workflows.html", kind: "page", navGroup: "quality", text: workflowText },
    { id: "qa", title: "QA / 검증", url: "pages/qa.html", kind: "page", navGroup: "quality", text: projects.map((project) => `${project.validatorReport}\n${JSON.stringify(qualitySignals(project))}`).join("\n") },
    { id: "coverage", title: "분석 커버리지", url: "pages/coverage.html", kind: "page", navGroup: "system", text: projects.map((project) => JSON.stringify(project.meta.adapter_coverage || {})).join("\n") },
    { id: "artifacts", title: "산출물 대시보드", url: "pages/artifacts.html", kind: "page", navGroup: "system", text: projects.map((project) => `${project.id} ${project.documents.map((document) => document.path).join(" ")} ${INDEX_NAMES.join(" ")}`).join("\n") },
  ];
  if (documents.length) {
    pages.push({ id: "documents", title: "프로젝트 문서", url: "pages/documents.html", kind: "page", navGroup: "system", text: documents.map((document) => `${document.project} ${document.path} ${document.title}`).join("\n") });
    for (const document of documents) pages.push({ id: `document:${document.project}:${document.path}`, title: document.title, url: document.url, kind: "document", project: document.project, text: document.plain, document, nav: false });
  }
  if (has("schema", "tables") || has("schema", "relations") || analyzerHas(["데이터와 저장소", "DB 스키마", "데이터 모델", "data model", "데이터 접근"])) pages.push({ id: "data-model", title: "데이터 모델", url: "pages/data-model.html", kind: "page", navGroup: "system" });
  if (has("sql_usage", "sqls") || has("sql_usage", "usages") || has("api_contracts", "endpoints") || analyzerHas(["데이터와 저장소", "API와 외부 연동", "SQL", "API contract", "인증/인가 경로"])) pages.push({ id: "sql", title: "SQL / API", url: "pages/sql.html", kind: "page", navGroup: "system" });
  if (has("transactions", "boundaries") || analyzerHas(["트랜잭션", "원자성"])) pages.push({ id: "transactions", title: "트랜잭션", url: "pages/transactions.html", kind: "page", navGroup: "system" });
  if (has("external_io", "communications") || analyzerHas(["외부 통신", "외부 연동", "external I/O"])) pages.push({ id: "external-io", title: "외부 연동", url: "pages/external-io.html", kind: "page", navGroup: "system" });
  if (projects.some((project) => project.patterns.length) || analyzerHas(["패턴 근거", "코드 컨벤션", "convention"])) {
    pages.push({ id: "conventions", title: "코드 패턴", url: "pages/conventions.html", kind: "page", navGroup: "quality" });
    for (const project of projects) for (const [index, pattern] of project.patterns.entries()) {
      const slug = `${slugify(project.id)}-${slugify(pattern.file.replace(/\.md$/i, ""), `pattern-${index + 1}`)}`;
      pages.push({ id: `pattern:${project.id}:${pattern.file}`, title: markdownTitle(pattern.file, pattern.text), url: `pages/patterns/${slug}.html`, kind: "pattern", project: project.id, pattern, text: markdownText(pattern.text), nav: false });
    }
  }
  if (has("dead_code", "unused_methods") || has("env_branches", "branches") || projects.some((p) => p.meta.unresolved_count || extractRisks(p).length) || analyzerHas(["유지보수 위험과 개선 우선순위", "미해결 사항과 확인 방법", "인증·인가와 보안", "운영·환경·배치", "보완 권장", "위험", "데드 코드", "환경 분기"]) || asArray(narrative.risks).length) pages.push({ id: "risks", title: "위험과 미해결", url: "pages/risks.html", kind: "page", navGroup: "system" });
  for (const domain of domains) pages.push({ id: `domain:${domain.slug}`, title: domain.name, url: `pages/domains/${domain.slug}.html`, kind: "domain", project: domain.project, domain });
  if (system) pages.push({ id: "api-contracts", title: "API 계약", url: "api-contracts.html", kind: "page", navGroup: "system" });
  for (const project of projects) pages.push({ id: `repository:${project.id}`, title: `${projectRoleLabel(project)} 저장소`, url: `pages/repositories/${project.id === "root" ? "root" : project.id}.html`, kind: "repository", project: project.id });
  return { pages, domains, documents };
}

function makeSearch(projects, pages, graph) {
  const items = [];
  for (const page of pages) items.push({
    kind: page.kind || "page", id: `page:${page.id}`, title: page.title,
    text: page.domain?.summary || page.text || page.title,
    keywords: tokenize(`${page.title} ${page.domain?.name || ""} ${page.document?.path || ""}`),
    url: page.url, project: page.project || "system", source_file: page.document?.path,
    category: page.document?.category, origin: page.document?.source,
  });
  for (const project of projects) {
    for (const symbol of asArray(project.indexes.symbols.symbols)) {
      const graphNode = ns(project.id, symbol.id);
      items.push({ kind: "symbol", id: `symbol:${graphNode}`, title: labelOf(symbol.id), text: `${symbol.id} ${symbol.type || ""} ${symbol.package || ""} ${symbol.file || ""}`, keywords: tokenize(`${symbol.id} ${symbol.file}`), url: `call-graph.html#node=${encodeURIComponent(graphNode)}`, graph_node: graphNode, project: project.id, source_file: symbol.file, line: symbol.line });
    }
    for (const sql of asArray(project.indexes.sql_usage.sqls)) items.push({ kind: "sql", id: `sql:${ns(project.id, sql.id)}`, title: sql.id, text: `${sql.type || ""} ${asArray(sql.tables).join(" ")} ${sql.text_preview || ""}`, keywords: tokenize(`${sql.id} ${asArray(sql.tables).join(" ")}`), url: "pages/sql.html", project: project.id, source_file: sql.file, line: sql.line });
    for (const table of asArray(project.indexes.schema.tables)) items.push({ kind: "table", id: `table:${ns(project.id, table.name)}`, title: table.name, text: asArray(table.columns).map((x) => `${x.name} ${x.type || ""}`).join(" "), keywords: tokenize(table.name), url: "pages/data-model.html", graph_node: ns(project.id, `table:${table.name}`), project: project.id, source_file: table.source_file });
    for (const endpoint of asArray(project.indexes.api_contracts.endpoints).filter((x) => x.source !== "external")) items.push({ kind: "api", id: `api:${ns(project.id, endpoint.id)}`, title: `${endpoint.method} ${endpoint.path || endpoint.path_pattern}`, text: `${endpoint.handler || ""} ${endpoint.file || ""}`, keywords: tokenize(`${endpoint.method} ${endpoint.path || endpoint.path_pattern} ${endpoint.handler}`), url: `call-graph.html#node=${encodeURIComponent(ns(project.id, endpoint.handler || `endpoint:${endpoint.id}`))}`, project: project.id, source_file: endpoint.file, line: endpoint.line });
  }
  const terms = Object.create(null);
  for (const item of items) {
    const tokens = tokenize(`${item.title} ${item.id} ${item.text} ${asArray(item.keywords).join(" ")}`);
    item.tokens = tokens;
    for (const token of tokens) (terms[token] ||= []).push(item.id);
  }
  return { _meta: { generator: "deterministic-wiki", projects: projects.map((p) => p.id), item_count: items.length, graph_node_count: graph.nodes.length, graph_edge_count: graph.edges.length }, items, terms };
}

const CSS = `
:root{color-scheme:dark;--bg:#0f1419;--panel:#161b22;--panel2:#1c222b;--line:#272e3a;--text:#e6edf3;--muted:#8b98a5;--accent:#4493f8;--chip:#1f6feb33;--warn:#f0b72f;--danger:#f85149;--ok:#3fb950}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans KR",sans-serif}
.layout{min-height:100vh}.sidebar{position:fixed;inset:0 auto 0 0;width:240px;background:var(--panel);border-right:1px solid var(--line);box-shadow:8px 0 24px #0003;padding:18px 14px;overflow:auto;z-index:1000;isolation:isolate}.brand{font-size:16px;font-weight:800;line-height:1.3;margin:0 2px 3px}.brand-sub{color:var(--muted);font-size:12px;margin:0 2px 13px}.brand span{color:var(--accent)}
.nav-search{margin-bottom:12px}.nav-search input{width:100%;min-width:0;background:#0d1117}.nav a{display:block;color:var(--text);text-decoration:none;padding:7px 10px;border-radius:7px;font-size:14px}.nav a:hover,.nav a.active{background:var(--chip);color:var(--accent)}.nav-tools{margin-bottom:8px}.nav-tree{margin:5px 0}.nav-tree>summary{list-style:none;display:flex;align-items:center;gap:7px;padding:8px 9px;border-radius:7px;color:var(--text);font-size:13px;font-weight:750;cursor:pointer;user-select:none}.nav-tree>summary::-webkit-details-marker{display:none}.nav-tree>summary:before{content:"▸";width:12px;color:var(--muted);transition:transform .15s}.nav-tree[open]>summary:before{transform:rotate(90deg);color:var(--accent)}.nav-tree>summary:hover{background:var(--panel2)}.nav-count{margin-left:auto;color:var(--muted);font-size:11px;font-weight:500}.tree-items{padding:2px 0 5px 13px;border-left:1px solid var(--line);margin-left:14px}.tree-items a{font-size:13px;padding:6px 8px}.nav-subtree{margin:2px 0}.nav-subtree>summary{font-weight:650;color:#c9d1d9}.nav-subtree .tree-items{margin-left:11px}.nav .section{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:14px 9px 5px}
main{margin-left:240px;max-width:1320px;padding:36px 40px 64px}h1,h2,h3{line-height:1.3}h1{font-size:29px;margin:0 0 8px}h2{font-size:20px;margin:30px 0 12px;border-bottom:1px solid var(--line);padding-bottom:7px}h3{font-size:16px;margin:20px 0 8px}a{color:var(--accent)}.muted{color:var(--muted)}
.grid,.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(235px,1fr));gap:14px;margin:14px 0}.card{display:block;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;overflow:auto}.card-link{text-decoration:none;color:var(--text)}.card-link:hover{border-color:var(--accent)}.card h3{margin:0 0 6px;color:var(--text)}.metric{font-size:27px;font-weight:750;color:var(--accent)}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:12px;margin:16px 0}.stat-box{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px;text-align:center}.stat-box .metric{display:block}.stat-label{font-size:12px;color:var(--muted);margin-top:3px}.two-col{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}
.table-wrap{position:relative;z-index:0;width:100%;overflow-x:auto;margin:12px 0}table{width:100%;border-collapse:collapse;background:var(--panel);font-size:14px}th,td{padding:8px 10px;border:1px solid var(--line);text-align:left;vertical-align:top}th{background:var(--panel2);color:var(--text)}
code,pre{font-family:"Cascadia Code",Consolas,ui-monospace,monospace}code{background:#1f242c;color:#c9d1d9;padding:2px 5px;border-radius:5px;font-size:.9em}pre{white-space:pre-wrap;background:#0d1117;border:1px solid var(--line);padding:14px;border-radius:8px;overflow:auto}.line{margin:2px 0;padding:4px 8px}
input,select{background:#0d1117;color:var(--text);border:1px solid var(--line);padding:9px;border-radius:8px}button{padding:8px 11px;border:1px solid var(--line);border-radius:8px;background:var(--panel2);color:var(--text);font-weight:650;cursor:pointer}button.active,button:hover{border-color:var(--accent);color:var(--accent)}
.badge,.chip{display:inline-block;padding:2px 9px;border-radius:999px;background:var(--chip);color:var(--accent);font-size:12px;margin:2px 4px 2px 0}.badge.high{background:#3fb95033;color:var(--ok)}.badge.medium{background:#f0b72f33;color:var(--warn)}.badge.low{background:#8b98a533;color:var(--muted)}.badge.danger{background:#f8514933;color:var(--danger)}
.flow{font-size:16px;padding:14px 16px;border-left:4px solid var(--accent);background:var(--panel);border-radius:0 8px 8px 0}.alert{border:1px solid #f8514966;background:#f8514918;border-radius:10px;padding:13px 16px;margin:16px 0}.alert.warn{border-color:#f0b72f66;background:#f0b72f14}.warning{border-left:4px solid var(--warn)}.danger{color:var(--danger)}
.eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);font-weight:750}.evidence{font-size:12px;color:var(--muted);margin-top:12px}.timeline{counter-reset:step;display:grid;gap:10px}.timeline .step{position:relative;padding:14px 16px 14px 50px;background:var(--panel);border:1px solid var(--line);border-radius:10px}.timeline .step:before{counter-increment:step;content:counter(step);position:absolute;left:14px;top:14px;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;background:var(--accent);color:white;font-weight:800}.cta{border-color:#4493f877;background:linear-gradient(135deg,#1f6feb24,#161b22)}
.prose{max-width:1080px}.prose p{white-space:normal}.prose ul,.prose ol{padding-left:22px}.prose blockquote{margin:14px 0;padding:10px 14px;border-left:4px solid var(--accent);background:var(--panel);color:var(--muted)}.prose hr{border:0;border-top:1px solid var(--line);margin:24px 0}.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.pill{font-size:12px;padding:5px 9px}.source-note{margin-top:30px;font-size:12px;color:var(--muted)}
.node-detail-title{font-size:18px;margin:12px 0 3px;overflow-wrap:anywhere}.node-meta{display:flex;gap:4px;flex-wrap:wrap;margin:8px 0}.node-location{margin:4px 0 12px;overflow-wrap:anywhere}.node-signature{border-left:3px solid var(--accent);padding:8px 10px;background:#0d1117;border-radius:0 6px 6px 0;overflow-wrap:anywhere}.relation-section{margin-top:18px}.relation-section h4{margin:0 0 7px;font-size:14px}.relation-list{list-style:none;padding:0;margin:0}.relation-list li{border-top:1px solid var(--line);padding:8px 0}.relation-link{display:block;width:100%;padding:0;border:0;background:none;color:var(--accent);font:inherit;font-weight:650;text-align:left;overflow-wrap:anywhere}.relation-link:hover{border:0;text-decoration:underline}.relation-evidence{display:block;color:var(--muted);font-size:12px;margin-top:2px;overflow-wrap:anywhere}.analysis-note{border-left:4px solid var(--warn);background:#f0b72f14;padding:10px 12px;margin-top:10px;border-radius:0 7px 7px 0}.analysis-note b{color:var(--warn)}
@media(max-width:900px){.two-col,.graph-layout{grid-template-columns:1fr!important}.graph-layout aside{position:static!important;max-height:none!important}.sidebar{position:static;width:auto;max-height:none}.layout{display:block}.nav{columns:1}main{margin:0;padding:24px}.brand-sub{margin-bottom:10px}}
`;

function shell(title, body, pages, prefix = "") {
  const site = pages.site || { title: "AX-Harness", system: false };
  const visible = pages.filter((page) => page.nav !== false);
  const domains = visible.filter((page) => page.kind === "domain");
  const repositories = visible.filter((page) => page.kind === "repository");
  const patterns = pages.filter((page) => page.kind === "pattern");
  const link = (page) => `<a href="${prefix}${page.url}" data-nav>${escapeHtml(page.title)}</a>`;
  const tree = (key, label, items, nested = "", open = false) => items.length || nested ? `<details class="nav-tree" data-tree-key="${key}"${open ? " open" : ""}><summary>${label}<span class="nav-count">${items.length + (nested ? 1 : 0)}</span></summary><div class="tree-items">${items.map(link).join("")}${nested}</div></details>` : "";
  const start = visible.filter((page) => page.navGroup === "start");
  const quality = visible.filter((page) => page.navGroup === "quality" && page.id !== "conventions");
  const systemPages = visible.filter((page) => page.navGroup === "system");
  const conventions = visible.find((page) => page.id === "conventions");
  const patternTree = conventions ? `<details class="nav-tree nav-subtree" data-tree-key="patterns"><summary>🧩 코드 패턴<span class="nav-count">${patterns.length}</span></summary><div class="tree-items">${link(conventions)}${patterns.map(link).join("")}</div></details>` : "";
  const systemRoles = site.system ? site.projectItems.map((item) => projectRoleLabel(item.project)).join(" · ") : "프로젝트 지식 베이스";
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · ${escapeHtml(site.title)}</title><style>${CSS}</style></head><body><div class="layout"><aside class="sidebar" data-wiki-sidebar><div class="brand">${escapeHtml(site.title)}</div><div class="brand-sub">${escapeHtml(systemRoles)}</div><form class="nav-search"><input type="search" placeholder="검색: 업무 용어 / 식별자" aria-label="위키 검색"></form><nav class="nav"><div class="nav-tools"><a href="${prefix}index.html" data-nav>🏠 홈</a><a href="${prefix}search.html" data-nav>🔎 통합 검색</a><a href="${prefix}call-graph.html" data-nav>🕸️ 호출 그래프 ↗ 새 창</a></div>${tree("start", "📘 시작하기", start)}${tree("quality", "🧪 개발·품질", quality, patternTree)}${tree("system", "⚙️ 시스템 상세", systemPages)}${tree("domains", "🏷️ 도메인", domains)}${tree("repositories", "🗄️ 저장소", repositories)}</nav></aside><main>${body}</main></div><script>const form=document.querySelector('.nav-search');form.addEventListener('submit',function(e){e.preventDefault();var q=this.querySelector('input').value.trim();if(q)location.href='${prefix}search.html?q='+encodeURIComponent(q);});document.addEventListener('keydown',function(e){if(e.key==='/'&&document.activeElement.tagName!=='INPUT'&&document.activeElement.tagName!=='TEXTAREA'){e.preventDefault();form.querySelector('input').focus();}});const here=location.pathname,active=[];document.querySelectorAll('[data-nav]').forEach(function(a){const target=new URL(a.href,location.href).pathname;if(target===here){a.classList.add('active');active.push(a);}});const treeScope='AXHarnessTree:'+${scriptJson(site.title)}+':';document.querySelectorAll('details[data-tree-key]').forEach(function(tree){const hasActive=active.some(function(link){return tree.contains(link);});try{const saved=localStorage.getItem(treeScope+tree.dataset.treeKey);if(hasActive)tree.open=true;else if(saved!==null)tree.open=saved==='1';tree.addEventListener('toggle',function(){localStorage.setItem(treeScope+tree.dataset.treeKey,tree.open?'1':'0');});}catch(e){if(hasActive)tree.open=true;}});const sidebar=document.querySelector('[data-wiki-sidebar]'),scrollKey=treeScope+'sidebar-scroll';function saveSidebarScroll(){if(!sidebar)return;try{localStorage.setItem(scrollKey,String(sidebar.scrollTop));}catch(e){}}if(sidebar){try{const savedScroll=Number(localStorage.getItem(scrollKey));if(Number.isFinite(savedScroll)&&savedScroll>0)sidebar.scrollTop=Math.min(savedScroll,Math.max(0,sidebar.scrollHeight-sidebar.clientHeight));}catch(e){}let scrollTimer;sidebar.addEventListener('scroll',function(){clearTimeout(scrollTimer);scrollTimer=setTimeout(saveSidebarScroll,80);},{passive:true});document.addEventListener('click',function(e){if(e.target.closest('[data-nav]'))saveSidebarScroll();},true);window.addEventListener('pagehide',saveSidebarScroll);const primaryActive=active[0];if(primaryActive)requestAnimationFrame(function(){const sidebarRect=sidebar.getBoundingClientRect(),activeRect=primaryActive.getBoundingClientRect();if(activeRect.top<sidebarRect.top||activeRect.bottom>sidebarRect.bottom){primaryActive.scrollIntoView({block:'nearest'});saveSidebarScroll();}});}document.addEventListener('click',function(e){const link=e.target.closest('[data-call-graph-link]');if(!link||e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;const opened=window.open('about:blank','AXHarnessCallGraph','popup=yes,width=1600,height=1000,resizable=yes,scrollbars=yes');if(opened){e.preventDefault();opened.opener=null;opened.location.replace(link.href);}});</script></body></html>`;
  return callGraphLinksInNewTab(html);
}

function standaloneGraphShell(title, body, pages) {
  const site = pages.site || { title: "AX-Harness" };
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · ${escapeHtml(site.title)}</title><style>${CSS}
  body.graph-window{overflow:hidden}.graph-window main{margin:0;max-width:none;padding:18px 20px 20px}.graph-window h1{font-size:24px}.graph-window .graph-layout{height:calc(100vh - 88px)}.graph-window .graph-layout>section{min-width:0}.graph-window #network{height:calc(100vh - 235px)!important}.graph-window .graph-layout>aside{max-height:calc(100vh - 108px)!important}
  @media(max-width:900px){body.graph-window{overflow:auto}.graph-window main{padding:16px}.graph-window .graph-layout{height:auto}.graph-window #network{height:65vh!important}}
  </style></head><body class="graph-window"><main>${body}</main></body></html>`;
}

function table(headers, rows) {
  if (!rows.length) return '<p class="muted">데이터 없음</p>';
  return `<div class="card"><table><thead><tr>${headers.map((item) => `<th>${escapeHtml(item)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((item) => `<td>${item ?? ""}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function graphHtml(graph, pages) {
  return standaloneGraphShell("통합 호출 그래프", `<h1>통합 호출 그래프</h1><p class="muted">전체 노드와 엣지를 유지한 채 저장소·노드 타입·엣지 타입을 조합해 탐색합니다. 더블클릭하면 이웃만 강조됩니다.</p>
  <div class="graph-layout" style="display:grid;grid-template-columns:minmax(0,1fr) minmax(360px,420px);gap:12px"><section><div class="card toolbar"><input id="graph-search" list="graph-options" placeholder="심볼 또는 파일 검색" style="min-width:280px"><datalist id="graph-options"></datalist><select id="project-filter"><option value="">모든 저장소</option></select><button id="graph-find">찾기</button><button id="graph-reset">강조 초기화</button><button id="physics-toggle" class="active">물리엔진 ON</button></div><div id="node-filter" class="card toolbar" style="margin-top:10px"><b>노드</b></div><div id="edge-filter" class="card toolbar" style="margin-top:10px"><b>엣지</b></div><div id="network" style="height:72vh;margin-top:10px;background:#050c16;border:1px solid #263854;border-radius:12px"></div><div id="graph-fallback" class="card" hidden></div></section><aside class="card" style="max-height:calc(100vh - 24px);height:max-content;position:sticky;top:12px"><h2 style="margin-top:0">그래프 정보</h2><div id="graph-stats"></div><h3>범례</h3><div id="graph-legend"></div><h3>선택 노드</h3><div id="node-detail" class="muted">노드를 클릭하세요.</div></aside></div>
  <script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script><script>
const RAW=${scriptJson(graph)}, VISUAL=${scriptJson(VISUAL)}; const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const projects=[...new Set(RAW.nodes.map(n=>n.project).filter(Boolean))], types=[...new Set(RAW.nodes.map(n=>n.group))], edgeTypes=[...new Set(RAW.edges.map(e=>e.type||e.label))];
const project=document.getElementById('project-filter');projects.forEach(p=>project.add(new Option(RAW.projectLabels?.[p]||p,p)));const nodeFilter=document.getElementById('node-filter'),edgeFilter=document.getElementById('edge-filter');let activeNodes=new Set(types),activeEdges=new Set(edgeTypes),physics=true,network,nodes,edges;
types.forEach(t=>{const b=document.createElement('button');b.className='pill active';b.dataset.type=t;b.textContent=(VISUAL[t]?.label||t);b.addEventListener('click',()=>{activeNodes.has(t)?activeNodes.delete(t):activeNodes.add(t);b.classList.toggle('active',activeNodes.has(t));applyFilters();});nodeFilter.appendChild(b);});
edgeTypes.forEach(t=>{const b=document.createElement('button');b.className='pill active';b.dataset.type=t;b.textContent=t;b.addEventListener('click',()=>{activeEdges.has(t)?activeEdges.delete(t):activeEdges.add(t);b.classList.toggle('active',activeEdges.has(t));applyFilters();});edgeFilter.appendChild(b);});
const verifiedDeadCount=RAW.nodes.filter(n=>n.dead).length;document.getElementById('graph-legend').innerHTML=types.map(t=>'<div><span class="badge" style="background:'+(VISUAL[t]?.color||'#777')+'">●</span> '+esc(VISUAL[t]?.label||t)+'</div>').join('')+'<div>◎ 허브(in-degree ≥ '+RAW.hubThreshold+')</div>'+(verifiedDeadCount?'<div style="opacity:.75">☠ 근거 확인된 미사용 후보</div>':'');
const opts=document.getElementById('graph-options');RAW.nodes.forEach(n=>{const o=document.createElement('option');o.value=n.id;o.label=(n.label||'')+' · '+(n.file||'');opts.appendChild(o);});
function visualNode(n){const v=VISUAL[n.group]||VISUAL.function;return {...n,color:{background:v.color,border:n.hub?'#ffffff':v.color},shape:v.shape,font:{color:'#e8f0fb'},opacity:n.opacity??1,title:n.title||n.id};}
function applyFilters(){if(!nodes||!edges)return;const p=project.value;nodes.update(RAW.nodes.map(n=>({id:n.id,hidden:!!((p&&n.project!==p)||!activeNodes.has(n.group))})));edges.update(RAW.edges.map((e,i)=>({id:i,hidden:!activeEdges.has(e.type||e.label)})));stats();}
function stats(){const p=project.value;const visible=RAW.nodes.filter(n=>(!p||n.project===p)&&activeNodes.has(n.group));const ids=new Set(visible.map(n=>n.id));const es=RAW.edges.filter(e=>ids.has(e.from)&&ids.has(e.to)&&activeEdges.has(e.type||e.label));const verified=visible.filter(n=>n.dead).length;document.getElementById('graph-stats').innerHTML='<div class="metric">'+visible.length+'</div>노드 · '+es.length+' 엣지<br>허브 '+visible.filter(n=>n.hub).length+(verified?' · 근거 확인 미사용 '+verified:'');}
function resetHighlight(){if(!nodes)return;nodes.update(RAW.nodes.map(n=>({id:n.id,opacity:n.opacity??1})));}
const nodeById=new Map(RAW.nodes.map(n=>[n.id,n]));
function selectNode(id){const n=nodeById.get(id);if(!n)return;if(network){network.selectNodes([id]);network.focus(id,{scale:1.35,animation:true});}document.getElementById('graph-search').value=id;showDetail(n);location.hash='node='+encodeURIComponent(id);}
function focusNode(){const q=document.getElementById('graph-search').value.toLowerCase().trim();const p=project.value;const n=RAW.nodes.find(x=>(!p||x.project===p)&&(x.id.toLowerCase()===q||(x.original_id||'').toLowerCase()===q||(x.label||'').toLowerCase().includes(q)||(x.file||'').toLowerCase().includes(q)||x.id.toLowerCase().includes(q)));if(n)selectNode(n.id);}
function nodeName(n){return n?(n.original_id||n.label||n.id):'알 수 없는 노드';}
function edgeEvidence(e){const source=(e.file||'')+(e.line?':'+e.line:'');return [e.type||e.label,e.evidence,source,e.origin,e.confidence].filter(Boolean).join(' · ');}
function relationHtml(title,direction,items){if(!items.length)return '<section class="relation-section"><h4>'+title+' (0)</h4><p class="muted">관계 없음</p></section>';return '<section class="relation-section"><h4>'+title+' ('+items.length+')</h4><ul class="relation-list">'+items.map(e=>{const target=nodeById.get(direction==='out'?e.to:e.from);return '<li><button type="button" class="relation-link" data-node-id="'+esc(target?.id||'')+'">'+esc(nodeName(target))+'</button><span class="relation-evidence">'+esc(edgeEvidence(e))+'</span></li>';}).join('')+'</ul></section>';}
function notesForNode(n){return Array.isArray(n.analysis_notes)?n.analysis_notes:[];}
function showDetail(n){const outgoing=RAW.edges.filter(e=>e.from===n.id),incoming=RAW.edges.filter(e=>e.to===n.id),notes=notesForNode(n);const badges=(n.hub?'<span class="badge">◎ 허브</span>':'')+(n.dead?'<span class="badge danger">☠ 근거 확인 미사용 후보</span>':'')+'<span class="badge">'+esc(VISUAL[n.group]?.label||n.group||'unknown')+'</span>'+(n.raw_type?'<span class="badge">'+esc(n.raw_type)+'</span>':'')+(n.visibility?'<span class="badge">'+esc(n.visibility)+'</span>':'')+(n.static===true?'<span class="badge">static</span>':'')+(n.confidence?'<span class="badge '+String(n.confidence).toLowerCase()+'">신뢰도 '+esc(n.confidence)+'</span>':'');const identity='<h3 class="node-detail-title">'+esc(nodeName(n))+'</h3><div class="node-location"><code>'+esc((n.file||'파일 정보 없음')+(n.line?':'+n.line:''))+'</code></div><div class="node-meta">'+badges+'</div>'+(n.signature?'<div class="node-signature"><b>시그니처</b><br><code>'+esc(n.signature)+'</code></div>':'')+(n.annotations?.length?'<p><b>어노테이션</b><br>'+n.annotations.map(x=>'<code>'+esc(x)+'</code>').join(' ')+'</p>':'')+'<p class="muted">저장소 '+esc(RAW.projectLabels?.[n.project]||n.project||'-')+(n.workspace?' · workspace '+esc(n.workspace):'')+(n.origin?' · '+esc(n.origin):'')+'<br>식별자 '+esc(n.id)+'</p>';const deadWarning=n.dead?'<div class="analysis-note"><b>근거 확인 미사용 후보</b><br>'+esc(n.dead_reason)+(n.dead_evidence?'<br>근거: '+esc(n.dead_evidence):'')+'</div>':'';const analysis=notes.length?'<section class="relation-section"><h4>분석 주의·인덱서 한계 ('+notes.length+')</h4>'+notes.map(note=>'<div class="analysis-note"><b>⚠ '+esc(note.title)+'</b><br>'+esc(note.text)+'<span class="relation-evidence">근거: '+esc(note.source)+'</span></div>').join('')+'</section>':'';document.getElementById('node-detail').classList.remove('muted');document.getElementById('node-detail').innerHTML=identity+relationHtml('호출함 (out)','out',outgoing)+relationHtml('호출됨 (in)','in',incoming)+deadWarning+analysis;}
if(!window.vis){document.getElementById('graph-fallback').hidden=false;document.getElementById('graph-fallback').innerHTML='vis-network CDN을 불러오지 못했습니다. 사내 미러로 교체하세요. <a href="search.html">텍스트 검색은 계속 사용할 수 있습니다.</a>';}
else{nodes=new vis.DataSet(RAW.nodes.map(visualNode));edges=new vis.DataSet(RAW.edges.map((e,i)=>({id:i,...e,color:e.color||'#607a9d',font:{color:'#b8c7da',size:10}})));network=new vis.Network(document.getElementById('network'),{nodes,edges},{physics:{stabilization:false},interaction:{hover:true,multiselect:true},edges:{smooth:{type:'dynamic'}}});network.on('click',p=>{if(p.nodes.length)selectNode(p.nodes[0]);});network.on('doubleClick',p=>{if(!p.nodes.length)return;const keep=new Set([p.nodes[0],...network.getConnectedNodes(p.nodes[0])]);nodes.update(RAW.nodes.map(n=>({id:n.id,opacity:keep.has(n.id)?(n.opacity??1):0.15})));});const hash=new URLSearchParams(location.hash.slice(1)).get('node');if(hash)selectNode(hash);applyFilters();}
project.addEventListener('change',applyFilters);document.getElementById('graph-find').addEventListener('click',focusNode);document.getElementById('graph-search').addEventListener('keydown',e=>{if(e.key==='Enter')focusNode();});document.getElementById('graph-reset').addEventListener('click',resetHighlight);document.getElementById('physics-toggle').addEventListener('click',function(){physics=!physics;this.textContent='물리엔진 '+(physics?'ON':'OFF');this.classList.toggle('active',physics);if(network)network.setOptions({physics:{enabled:physics}});});
document.getElementById('node-detail').addEventListener('click',e=>{const button=e.target.closest('[data-node-id]');if(button?.dataset.nodeId)selectNode(button.dataset.nodeId);});
  </script>`, pages);
}

function searchHtml(search, pages) {
  return shell("통합 검색", `<h1>통합 검색</h1><p class="muted">도메인 용어, camelCase/snake_case 식별자, SQL·테이블·API를 한 번에 검색합니다.</p><div class="card toolbar"><input id="wiki-query" style="width:min(720px,70%)" placeholder="예: 수강취소, cancelOrder, TBL_ORDER"><select id="search-project"><option value="">모든 저장소</option></select><select id="search-kind"><option value="">모든 종류</option></select></div><p id="search-summary" class="muted"></p><div id="search-results" class="grid"></div><script>
const INDEX=${scriptJson(search)};const q=document.getElementById('wiki-query'),project=document.getElementById('search-project'),kind=document.getElementById('search-kind'),results=document.getElementById('search-results'),summary=document.getElementById('search-summary'),byId=new Map(INDEX.items.map(x=>[x.id,x]));const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
[...new Set(INDEX.items.map(x=>x.project).filter(Boolean))].forEach(x=>project.add(new Option(x,x)));[...new Set(INDEX.items.map(x=>x.kind))].forEach(x=>kind.add(new Option(x,x)));
function tokens(v){const normalized=String(v||'').normalize('NFKC'),raw=normalized.toLowerCase();return [...new Set([raw,...normalized.replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/[_.$/\\:-]+/g,' ').toLowerCase().split(/[^\p{L}\p{N}]+/u)].filter(x=>x.length>1))];}
function candidates(ts){if(!ts.length)return INDEX.items;const ids=new Set();for(const t of ts){for(const id of INDEX.terms[t]||[])ids.add(id);if(!(INDEX.terms[t]||[]).length)for(const [term,values] of Object.entries(INDEX.terms))if(term.includes(t)||t.includes(term))for(const id of values)ids.add(id);}return [...ids].map(id=>byId.get(id)).filter(Boolean);}
function run(){const value=q.value.trim(),ts=tokens(value),p=project.value,k=kind.value;let rows=candidates(ts).filter(x=>(!p||x.project===p)&&(!k||x.kind===k)).map(x=>{if(!ts.length)return{x,score:1};const title=x.title.toLowerCase(),id=x.id.toLowerCase(),text=(x.text||'').toLowerCase(),xt=new Set(x.tokens||[]);let score=0;for(const t of ts){if(title===t)score+=20;else if(title.includes(t))score+=10;if(id.includes(t))score+=7;if(xt.has(t))score+=5;if(text.includes(t))score+=2;}return{x,score};}).filter(r=>r.score>0).sort((a,b)=>b.score-a.score||a.x.title.localeCompare(b.x.title));const total=rows.length;rows=rows.slice(0,200);summary.textContent=total+'건'+(total>200?' 중 상위 200건 표시 — 검색어를 구체화하세요.':'');results.innerHTML=rows.map(({x,score})=>{const graph=/call-graph\\.html(?:#|$)/.test(x.url),target=graph?' data-call-graph-link target="_blank" rel="noopener noreferrer"':'';return '<a class="card" style="color:inherit;text-decoration:none" href="'+x.url+'"'+target+'><span class="badge">'+esc(x.kind)+'</span><span class="badge">'+esc(x.project)+'</span><h3>'+esc(x.title)+(graph?' ↗ 새 창':'')+'</h3><div class="muted">'+esc((x.source_file||'')+(x.line?':'+x.line:''))+' · score '+score+'</div><p>'+esc((x.text||'').slice(0,280))+'</p></a>';}).join('')||'<p>검색 결과 없음</p>';}
q.addEventListener('input',run);project.addEventListener('change',run);kind.addEventListener('change',run);const initial=new URLSearchParams(location.search).get('q');if(initial)q.value=initial;run();
  </script>`, pages);
}

function relatedItems(project, domain) {
  const tokens = tokenize(`${domain.name} ${domain.summary || ""}`).filter((x) => x.length > 2 && !/^(service|system|domain|관리|처리|업무)$/.test(x)).slice(0, 20);
  const matches = (value) => tokens.some((token) => String(value || "").toLowerCase().includes(token));
  return {
    symbols: asArray(project.indexes.symbols.symbols).filter((x) => matches(`${x.id} ${x.file}`)).slice(0, 100),
    sql: asArray(project.indexes.sql_usage.sqls).filter((x) => matches(`${x.id} ${asArray(x.tables).join(" ")} ${x.text_preview}`)).slice(0, 100),
    apis: [
      ...asArray(project.indexes.api_contracts.endpoints).map((item) => ({ ...item, api_kind: "endpoint" })),
      ...asArray(project.indexes.api_contracts.consumers).map((item) => ({ ...item, api_kind: "consumer" })),
    ].filter((x) => matches(`${x.id} ${x.method} ${x.path || x.path_pattern} ${x.handler} ${x.file}`)).slice(0, 100),
  };
}

function dbRelationshipSection(projects) {
  const nodes = [];
  const edges = [];
  const rows = [];
  const derivedRows = [];
  const connected = new Set();
  let foreignKeys = 0;
  let inferredJoins = 0;
  let ormMappings = 0;
  let manyToMany = 0;
  let resolvedCardinality = 0;

  for (const project of projects) {
    const knownNames = new Map();
    const register = (name) => {
      const clean = String(name || "").replace(/["`]/g, "").trim();
      if (!clean) return "";
      knownNames.set(clean.toLowerCase(), clean);
      const short = clean.split(".").pop();
      if (short && !knownNames.has(short.toLowerCase())) knownNames.set(short.toLowerCase(), clean);
      return clean;
    };
    for (const item of asArray(project.indexes.schema.tables)) register(item.name);
    for (const sql of asArray(project.indexes.sql_usage.sqls)) for (const name of asArray(sql.tables)) register(name);
    for (const relation of dbRelations(project)) {
      register(relation.from_table);
      register(relation.to_table);
    }
    const canonical = (name) => knownNames.get(String(name || "").toLowerCase()) || String(name || "");
    const tableNames = [...new Set(knownNames.values())];
    for (const name of tableNames) nodes.push({
      id: ns(project.id, `table:${name}`), label: name, project: project.id, title: `${project.id} · ${name}`,
    });

    for (const relation of dbRelations(project)) {
      const fromName = canonical(relation.from_table);
      const toName = canonical(relation.to_table);
      if (!fromName || !toName) continue;
      const from = ns(project.id, `table:${fromName}`);
      const to = ns(project.id, `table:${toName}`);
      connected.add(from);
      connected.add(to);
      const inferred = relation.type === "query_join";
      if (inferred) inferredJoins += 1;
      else if (relation.type === "orm_relation") ormMappings += 1;
      else foreignKeys += 1;
      const fromColumns = asArray(relation.from_columns);
      const toColumns = asArray(relation.to_columns);
      const style = relationStyle(relation.type);
      const cardinality = cardinalityLabel(relation);
      if (relation.cardinality && relation.cardinality !== "unknown") resolvedCardinality += 1;
      const location = [relation.file, relation.line].filter(Boolean).join(":");
      const evidence = relation.evidence || relation.name || relation.sql_id || "";
      const defaultConfidence = relation.confidence || (inferred ? "MEDIUM" : "HIGH");
      edges.push({
        id: `db-edge-${edges.length}`, from, to, label: `${style.label} ${cardinality}`,
        arrows: inferred ? undefined : "to", dashes: style.dashes, color: style.color,
        project: project.id, relation_type: relation.type, relation_label: style.label,
        from_table: fromName, to_table: toName,
        from_columns: fromColumns, to_columns: toColumns,
        cardinality: relation.cardinality || "unknown", cardinality_label: cardinality,
        cardinality_basis: relation.cardinality_basis || "", framework: relation.framework || "",
        file: relation.file, line: relation.line, evidence,
        confidence: defaultConfidence,
        title: [`${style.label} · ${cardinality}`, `${fromName}.${fromColumns.join(",")} → ${toName}.${toColumns.join(",")}`, relation.cardinality_basis, location, evidence].filter(Boolean).join("\n"),
      });
      rows.push([
        escapeHtml(project.id),
        `<span class="badge ${style.badge}">${style.label}</span>`,
        `<span class="badge ${relation.cardinality && relation.cardinality !== "unknown" ? "high" : "medium"}">${escapeHtml(cardinality)}</span>`,
        `<code>${escapeHtml(fromName)}${fromColumns.length ? "." + escapeHtml(fromColumns.join(",")) : ""}</code>`,
        `<code>${escapeHtml(toName)}${toColumns.length ? "." + escapeHtml(toColumns.join(",")) : ""}</code>`,
        escapeHtml(relation.cardinality_basis || "-"),
        `<span class="badge ${String(defaultConfidence).toLowerCase()}">${escapeHtml(defaultConfidence)}</span>`,
        location ? `<code>${escapeHtml(location)}</code>` : "-",
        escapeHtml(evidence),
      ]);
    }

    for (const relation of derivedRelations(project)) {
      manyToMany += 1;
      const location = [relation.file, relation.line].filter(Boolean).join(":");
      derivedRows.push([
        escapeHtml(project.id),
        `<code>${escapeHtml(canonical(relation.from_table) || relation.from_table)}</code>`,
        `<code>${escapeHtml(canonical(relation.to_table) || relation.to_table)}</code>`,
        `<code>${escapeHtml(relation.via_table)}</code>`,
        escapeHtml(asArray(relation.via_columns).join(", ") || "-"),
        escapeHtml(relation.cardinality_basis || "-"),
        location ? `<code>${escapeHtml(location)}</code>` : "-",
      ]);
    }
  }

  const uniqueNodes = [...new Map(nodes.map((item) => [item.id, item])).values()];
  const isolated = uniqueNodes.filter((item) => !connected.has(item.id)).length;
  const stats = [
    [uniqueNodes.length, "관계도 테이블"],
    [foreignKeys, "DDL 외래키"],
    [ormMappings, "ORM 매핑"],
    [inferredJoins, "SQL JOIN 추론"],
    [manyToMany, "N:M (조인 테이블)"],
    [`${resolvedCardinality}/${edges.length}`, "다중성 확정"],
    [isolated, "관계 미탐지"],
  ].map(([value, label]) => `<div class="stat-box"><span class="metric">${escapeHtml(value)}</span><div class="stat-label">${label}</div></div>`).join("");
  const empty = edges.length ? "" : '<div class="alert warn"><b>탐지된 테이블 관계가 없습니다.</b> DDL에 FOREIGN KEY가 없고 SQL JOIN도 정적으로 확인되지 않았습니다. 관계가 없다는 뜻이 아니라 동적 SQL·프로시저·애플리케이션 조합 조건을 추가 확인해야 합니다.</div>';
  const graph = { nodes: uniqueNodes, edges };

  const derivedSection = derivedRows.length
    ? `<h2>N:M 관계 (조인 테이블 경유)</h2>
  <div class="alert"><b>판정 기준</b> — 외래키 2개 이상의 컬럼 합집합이 그 테이블에서 유일(PK 또는 UNIQUE)하면 양쪽 부모 테이블은 서로 N:M입니다. 아래 관계는 조인 테이블 DDL에서 파생한 것이며 물리 FK 선언 자체는 각각 N:1로 위 표에 있습니다.</div>
  ${table(["프로젝트", "테이블 A", "테이블 B", "조인 테이블", "조인 컬럼", "판정 근거", "파일:라인"], derivedRows)}`
    : "";
  return `<h2>테이블 관계도</h2>
  <div class="alert warn"><b>관계 해석 기준</b><br>초록 실선 <b>DDL FK</b>는 스키마에 선언된 물리 외래키, 파랑 파선 <b>ORM 매핑</b>은 소스의 매핑 애노테이션(@OneToMany·models.ForeignKey·relationship 등)에 선언된 관계, 노랑 점선 <b>SQL JOIN 추론</b>은 실제 SQL의 컬럼 동등 조건에서 찾은 논리 관계입니다. SQL JOIN은 물리 FK 선언을 의미하지 않습니다.<br><b>다중성(1:1·1:N·N:1·N:M)</b>은 from → to 방향 기준이며, FK는 자식 쪽 유일 제약(PK·UNIQUE·UNIQUE INDEX) 유무로, ORM은 애노테이션 종류로 판정합니다. 근거가 없으면 임의로 추정하지 않고 <b>다중성 미확정</b>으로 표시합니다.</div>
  <div class="stat-grid">${stats}</div>${empty}
  <div class="graph-layout" style="display:grid;grid-template-columns:minmax(0,1fr) minmax(320px,400px);gap:12px">
    <section><div class="card toolbar"><button id="db-fit">전체 보기</button><button id="db-physics" class="active">물리엔진 ON</button><button id="db-fk" class="active">DDL FK</button><button id="db-orm" class="active">ORM 매핑</button><button id="db-join" class="active">SQL JOIN 추론</button></div><div id="db-network" style="height:68vh;margin-top:10px;background:#050c16;border:1px solid #263854;border-radius:12px"></div><div id="db-fallback" class="card" hidden></div></section>
    <aside class="card" style="height:max-content;position:sticky;top:12px"><h3 style="margin-top:0">관계 상세</h3><div id="db-relation-detail" class="muted">테이블 또는 관계선을 클릭하세요.</div></aside>
  </div>
  ${derivedSection}
  <h2>관계 근거 전체</h2>${table(["프로젝트", "구분", "다중성", "출발 테이블·컬럼", "대상 테이블·컬럼", "다중성 판정 근거", "신뢰도", "파일:라인", "근거"], rows)}
  <script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script><script>
  (function(){const RAW=${scriptJson(graph)},esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const detail=document.getElementById('db-relation-detail'),fallback=document.getElementById('db-fallback');let network,nodes,edges,physics=true,showFk=true,showJoin=true,showOrm=true;
  const ORIGIN_NOTE={query_join:'SQL의 컬럼 동등 JOIN 조건에서 추론한 논리 관계이며 물리 FK를 뜻하지 않습니다.',orm_relation:'ORM 매핑 애노테이션에 선언된 관계입니다. 다중성은 애노테이션 종류에서 그대로 읽었습니다.',foreign_key:'DDL에 선언된 FOREIGN KEY 관계입니다.'};
  function relationText(e){const from=e.from_table+(e.from_columns?.length?'.'+e.from_columns.join(','):'');const to=e.to_table+(e.to_columns?.length?'.'+e.to_columns.join(','):'');const location=(e.file||'')+(e.line?':'+e.line:'');const resolved=e.cardinality&&e.cardinality!=='unknown';return '<span class="badge '+(e.relation_type==='query_join'?'medium':'high')+'">'+esc(e.relation_label||e.label)+'</span> <span class="badge '+(resolved?'high':'medium')+'">'+esc(e.cardinality_label||'다중성 미확정')+'</span><h3 class="node-detail-title">'+esc(from)+' → '+esc(to)+'</h3><p><b>다중성</b> '+esc(e.cardinality_label||'-')+(e.framework?' · <b>ORM</b> '+esc(e.framework):'')+'</p>'+(e.cardinality_basis?'<p><b>다중성 판정 근거</b><br>'+esc(e.cardinality_basis)+'</p>':'')+'<p><b>신뢰도</b> '+esc(e.confidence||'-')+'</p>'+(location?'<p><b>근거 위치</b><br><code>'+esc(location)+'</code></p>':'')+(e.evidence?'<div class="node-signature"><b>추출 근거</b><br>'+esc(e.evidence)+'</div>':'')+'<p class="muted">'+(ORIGIN_NOTE[e.relation_type]||ORIGIN_NOTE.foreign_key)+'</p>';}
  function tableText(id){const node=RAW.nodes.find(n=>n.id===id),related=RAW.edges.filter(e=>e.from===id||e.to===id);return '<h3 class="node-detail-title">'+esc(node?.label||id)+'</h3><p><span class="badge">'+esc(node?.project||'-')+'</span> 연결 관계 '+related.length+'개</p><ul class="relation-list">'+related.map(e=>'<li>'+relationText(e)+'</li>').join('')+'</ul>';}
  function filters(){if(!edges)return;const visible=t=>t==='query_join'?showJoin:t==='orm_relation'?showOrm:showFk;edges.update(RAW.edges.map(e=>({id:e.id,hidden:!visible(e.relation_type)})));}
  if(!window.vis){fallback.hidden=false;fallback.textContent='vis-network CDN을 불러오지 못했습니다. 아래 관계 근거 표에서 전체 관계를 확인할 수 있습니다.';}
  else{nodes=new vis.DataSet(RAW.nodes.map(n=>({...n,shape:'box',color:{background:'#182b3a',border:'#4493f8'},font:{color:'#e6edf3'}})));edges=new vis.DataSet(RAW.edges.map(e=>({...e,font:{color:'#c8d6e5',size:10}})));network=new vis.Network(document.getElementById('db-network'),{nodes,edges},{physics:{stabilization:false},interaction:{hover:true},edges:{smooth:{type:'dynamic'}}});network.on('click',p=>{if(p.edges.length&&!p.nodes.length){const edge=RAW.edges.find(e=>e.id===p.edges[0]);if(edge){detail.classList.remove('muted');detail.innerHTML=relationText(edge);}}else if(p.nodes.length){detail.classList.remove('muted');detail.innerHTML=tableText(p.nodes[0]);}});}
  document.getElementById('db-fit').addEventListener('click',()=>network?.fit({animation:true}));document.getElementById('db-physics').addEventListener('click',function(){physics=!physics;this.textContent='물리엔진 '+(physics?'ON':'OFF');this.classList.toggle('active',physics);network?.setOptions({physics:{enabled:physics}});});document.getElementById('db-fk').addEventListener('click',function(){showFk=!showFk;this.classList.toggle('active',showFk);filters();});document.getElementById('db-orm').addEventListener('click',function(){showOrm=!showOrm;this.classList.toggle('active',showOrm);filters();});document.getElementById('db-join').addEventListener('click',function(){showJoin=!showJoin;this.classList.toggle('active',showJoin);filters();});
  })();
  </script>`;
}

function renderWiki(projects, owner, system, pairRefresh = null) {
  const wikiDir = resolve(owner, ".claude", "wiki");
  const rel = relative(owner, wikiDir);
  if (rel.startsWith("..") || resolve(owner, rel) !== wikiDir) throw new Error(`안전하지 않은 wiki 출력 경로: ${wikiDir}`);
  if (existsSync(wikiDir)) rmSync(wikiDir, { recursive: true, force: true });
  mkdirSync(join(wikiDir, "pages", "repositories"), { recursive: true });
  mkdirSync(join(wikiDir, "pages", "domains"), { recursive: true });
  mkdirSync(join(wikiDir, "pages", "patterns"), { recursive: true });

  const narrative = readJson(join(owner, "_workspace", "wiki-narrative.json"), {});
  const narrativeStatus = validateNarrative(narrative, projects);
  const stats = projects.map((project) => ({ project, stats: projectStats(project) }));
  const graph = buildGraph(projects); const api = collectApiPairs(projects);
  const { pages, domains, documents } = pageCatalog(projects, narrative, system);
  const site = siteIdentity(projects, system); pages.site = site;
  const search = makeSearch(projects, pages, graph);
  const apiEdges = graph.edges.filter((edge) => edge.type === "api_contract").length;
  const apiContractStatus = system
    ? (api.endpoints.length > 0 && api.consumers.length > 0 && api.unmatchedConsumers.length === 0 && apiEdges > 0 ? "PASS" : "WARN")
    : "NOT_APPLICABLE";
  const coverageStatuses = projects.map((project) => project.meta.adapter_coverage?.status || "UNKNOWN");
  const analysisCoverageStatus = coverageStatuses.includes("WARN") ? "WARN" : coverageStatuses.includes("PARTIAL") ? "PARTIAL" : coverageStatuses.every((status) => status === "FULL") ? "FULL" : "UNKNOWN";
  const overallStatus = apiContractStatus === "WARN" || ["PARTIAL", "WARN"].includes(analysisCoverageStatus) ? "WARN" : "PASS";

  const statBox = (value, label) => `<div class="stat-box"><span class="metric">${escapeHtml(value)}</span><div class="stat-label">${escapeHtml(label)}</div></div>`;
  const primaryRisk = site.risks.find((risk) => risk.severity === "HIGH") || site.risks.find((risk) => risk.severity === "MEDIUM") || site.risks[0];
  const riskCallout = primaryRisk ? `<div class="alert ${primaryRisk.severity === "HIGH" ? "" : "warn"}"><span class="badge ${primaryRisk.severity === "HIGH" ? "danger" : "medium"}">${escapeHtml(primaryRisk.severity)}</span> <b>${escapeHtml(primaryRisk.project)}</b> — ${escapeHtml(primaryRisk.text)} <a href="pages/risks.html">위험 페이지</a></div>` : "";
  const coverageCallout = analysisCoverageStatus !== "FULL" ? `<div class="alert warn"><span class="badge medium">${escapeHtml(analysisCoverageStatus)}</span> 결정적 분석 커버리지에 부분지원 또는 미지원 파일이 있습니다. <a href="pages/coverage.html">커버리지 상세</a></div>` : "";
  const featurePages = pages.filter((page) => page.nav !== false && !page.id.startsWith("repository:") && !page.id.startsWith("domain:") && page.id !== "api-contracts");
  const featureCards = featurePages.map((page) => `<a class="card card-link" href="${page.url}"><h3>${escapeHtml(page.title)}</h3><div class="muted">${escapeHtml(pageSummary(page)).slice(0, 180)}</div></a>`).join("");
  const domainCards = domains.map((domain) => `<a class="card card-link" href="pages/domains/${domain.slug}.html"><h3>${escapeHtml(domain.name)}</h3><div class="muted">${escapeHtml(markdownText(domain.summary || domain.body)).slice(0, 150)}</div></a>`).join("");
  const repositoryCards = site.projectItems.map((item) => {
    const s = projectStats(item.project); const file = item.id === "root" ? "root" : item.id;
    return `<a class="card card-link" href="pages/repositories/${file}.html"><span class="badge">${escapeHtml(projectRoleLabel(item.project))}</span><h3>${escapeHtml(item.title)}</h3><div class="muted">${escapeHtml(item.summary).slice(0, 180)}</div><p>${s.symbols} symbols · ${s.endpoints + s.consumers} API · ${item.project.documents.length} docs</p></a>`;
  }).join("");
  const pairStatus = system ? `<h2>페어링 · API 계약 <span class="badge ${apiContractStatus === "PASS" ? "low" : "medium"}">${apiContractStatus}</span></h2>${apiContractStatus === "WARN" ? '<div class="alert warn"><b>API 계약이 완전하게 연결되지 않았습니다.</b> 미매칭 클라이언트 호출과 백엔드 endpoint 경로를 API 계약 페이지에서 확인하세요.</div>' : ""}<div class="stat-grid">${statBox(api.pairs.length, "매칭 계약")}${statBox(api.unmatchedConsumers.length, "미매칭 클라이언트 호출")}${statBox(api.unmatchedEndpoints.length, "미사용 endpoint")}${statBox(apiEdges, "그래프 API 엣지")}</div><p><a href="api-contracts.html">API 계약 상세 보기 →</a></p>` : "";
  const stackChips = site.stacks.length ? `<h2>기술 스택</h2><p>${site.stacks.map((stack) => `<span class="chip">${escapeHtml(stack)}</span>`).join("")}</p>` : "";
  const indexArtifactCount = projects.reduce((sum, project) => sum + INDEX_NAMES.filter((name) => project.indexAvailability[name]).length + 1 + (Object.keys(project.analysisInput || {}).length ? 1 : 0) + (project.unresolvedAvailable ? 1 : 0), 0);
  const narrativePurpose = narrative.system_overview?.purpose || narrative.overview || site.summary;
  const narrativeBadge = `<span class="badge ${narrativeStatus.status === "PASS" ? "high" : "medium"}">서술 ${escapeHtml(narrativeStatus.status)}</span>`;
  const home = `<h1>${escapeHtml(site.title)}</h1><p class="muted">${escapeHtml(narrativePurpose)}</p><p>${narrativeBadge}</p><div class="cards"><a class="card card-link cta" href="pages/business.html"><div class="eyebrow">업무부터 이해하기</div><h3>이 시스템은 누구의 어떤 문제를 푸는가?</h3><div class="muted">업무 역량·사용자 여정·성공과 실패 조건</div></a><a class="card card-link cta" href="pages/onboarding.html"><div class="eyebrow">신규 담당자</div><h3>첫날과 첫 주 시작 가이드</h3><div class="muted">읽기 순서·로컬 실행·안전한 첫 작업·디버깅 시작점</div></a><a class="card card-link cta" href="pages/architecture.html"><div class="eyebrow">설계 이해</div><h3>책임·경계·런타임 흐름·설계 결정</h3><div class="muted">구조 통계가 아니라 왜 이렇게 동작하는지 설명</div></a></div>${riskCallout}<div class="stat-grid">${statBox(pages.filter((page) => page.nav !== false).length, "위키 문서")}${statBox(stats.reduce((sum, item) => sum + item.stats.symbols, 0), "심볼")}${statBox(graph.nodes.length, "그래프 노드")}${statBox(graph.edges.length, "그래프 엣지")}${statBox(indexArtifactCount, "Index 산출물")}${statBox(documents.length, "Markdown 원문")}</div>${stackChips}${system ? `<h2>저장소</h2><div class="cards">${repositoryCards}</div>` : ""}${pairStatus}<h2>둘러보기</h2><div class="cards">${featureCards}</div>${domainCards ? `<h2>도메인</h2><div class="cards">${domainCards}</div>` : ""}<h2>도구</h2><div class="cards"><a class="card card-link" href="call-graph.html"><h3>🕸️ 호출 그래프</h3><div class="muted">전체 노드·엣지, 저장소·타입 필터, 이웃 관계와 file:line 탐색</div></a><a class="card card-link" href="search.html"><h3>🔎 통합 검색</h3><div class="muted">문서·도메인·심볼·SQL·테이블·API를 한 번에 검색</div></a><a class="card card-link" href="pages/artifacts.html"><h3>📦 산출물 대시보드</h3><div class="muted">모든 Markdown·index JSON의 수집 상태와 위키 반영 위치 확인</div></a>${system ? '<a class="card card-link" href="api-contracts.html"><h3>🔗 API 계약</h3><div class="muted">클라이언트 호출과 백엔드 endpoint 매칭·미매칭 현황</div></a>' : ""}</div><p class="source-note">출처: <code>CLAUDE.md</code>, 하네스 Markdown 전체, <code>_workspace/index/*.json</code>, 검증된 <code>_workspace/wiki-narrative.json</code>. <a href="pages/artifacts.html">산출물 대시보드</a>에서 입력과 반영 위치를 확인할 수 있습니다.</p>`;
  atomicWrite(join(wikiDir, "index.html"), shell(system ? "통합 시스템 위키" : "프로젝트 위키", `${coverageCallout}${home}`, pages));
  atomicWrite(join(wikiDir, "call-graph.html"), graphHtml(graph, pages));
  atomicWrite(join(wikiDir, "search.html"), searchHtml(search, pages));
  atomicWrite(join(wikiDir, "search-index.json"), `${JSON.stringify(search, null, 2)}\n`);

  const overviewRows = stats.map(({ project, stats: s }) => [escapeHtml(project.id), escapeHtml(projectIdentity(project).title), escapeHtml(project.meta.tier || ""), String(project.meta.source_file_count || 0), String(s.symbols), String(s.endpoints + s.consumers), String(s.unresolved)]);
  const overviewEvidence = projects.map((project) => `<h2>${escapeHtml(project.id)}</h2>${markdownHtml(sectionText(project.analyzer, ["분석 개요", "분석 범위와 커버리지", "시스템 목적과 업무 범위", "기술 스택과 실행 구조", "분석 신뢰도", "프로젝트 기본", "coverage ledger", "탐지 신뢰도"]))}`).join("");
  atomicWrite(join(wikiDir, "pages", "overview.html"), shell("시스템 개요", `<h1>시스템 개요</h1><p class="muted">${escapeHtml(site.summary)}</p>${stackChips.replace("<h2>기술 스택</h2>", "<h2>기술 스택</h2>")}${table(["프로젝트", "이름", "Tier", "소스 파일", "심볼", "API", "미해결"], overviewRows)}<section class="prose">${overviewEvidence}</section>`, pages, "../"));

  atomicWrite(join(wikiDir, "pages", "business.html"), shell("업무 이해", businessNarrativeHtml(narrative, projects, narrativeStatus), pages, "../"));
  atomicWrite(join(wikiDir, "pages", "onboarding.html"), shell("신규 담당자 시작하기", onboardingNarrativeHtml(narrative, projects, narrativeStatus), pages, "../"));

  const coverageRows = projects.flatMap((project) => asArray(project.meta.adapter_coverage?.extensions).map((item) => [escapeHtml(project.id), `<code>${escapeHtml(item.extension)}</code>`, `<span class="badge ${item.level === "FULL" ? "low" : "medium"}">${escapeHtml(item.level)}</span>`, String(item.files)]));
  const unsupportedRows = projects.flatMap((project) => asArray(project.meta.adapter_coverage?.unsupported_files).map((file) => [escapeHtml(project.id), `<code>${escapeHtml(file)}</code>`, '<span class="badge danger">UNSUPPORTED</span>']));
  atomicWrite(join(wikiDir, "pages", "coverage.html"), shell("분석 커버리지", `<h1>분석 커버리지</h1><div class="alert warn"><b>PARTIAL은 결정적 기본 추출 후 analyzer 근거 보강이 필요한 형식입니다.</b> UNSUPPORTED 파일은 전용 변환기나 내보내기 결과 없이는 내용을 분석했다고 간주하지 않습니다.</div>${table(["프로젝트", "확장자", "수준", "파일"], coverageRows)}${unsupportedRows.length ? `<h2>미지원 전용·바이너리 파일</h2>${table(["프로젝트", "파일", "상태"], unsupportedRows)}` : ""}`, pages, "../"));

  const indexPage = (name) => {
    const target = {
      symbols: ["call-graph.html", "호출 그래프"], call_graph: ["call-graph.html", "호출 그래프"],
      sql_usage: ["pages/sql.html", "SQL / API"], api_contracts: system ? ["api-contracts.html", "API 계약"] : ["pages/sql.html", "SQL / API"],
      transactions: ["pages/transactions.html", "트랜잭션"], external_io: ["pages/external-io.html", "외부 연동"],
      schema: ["pages/data-model.html", "데이터 모델"], env_branches: ["pages/risks.html", "위험과 미해결"], dead_code: ["pages/risks.html", "위험과 미해결"],
    }[name];
    const href = target?.[0].startsWith("pages/") ? target[0].slice("pages/".length) : `../${target?.[0] || ""}`;
    return target && pages.some((page) => page.url === target[0]) ? `<a href="${href}">${target[1]}</a>` : '<a href="coverage.html">분석 커버리지</a>';
  };
  const indexRows = projects.flatMap((project) => {
    const rows = INDEX_NAMES.map((name) => {
      const summary = indexArraySummary(project.indexes[name]);
      const present = project.indexAvailability[name];
      const declared = asArray(project.meta.indexes).includes(name);
      const status = present ? "LOADED" : declared ? "MISSING" : "NO SIGNAL";
      const statusClass = present ? "high" : declared ? "danger" : "low";
      return [escapeHtml(project.id), `<code>${name}.json</code>`, `<span class="badge ${statusClass}">${status}</span>`, String(summary.total), escapeHtml(summary.detail), indexPage(name)];
    });
    const candidates = asArray(project.analysisInput?.pattern_candidates?.categories);
    rows.unshift(
      [escapeHtml(project.id), "<code>_meta.json</code>", '<span class="badge high">LOADED</span>', String(project.meta.source_file_count || 0), `tier ${escapeHtml(project.meta.tier || "-")} · unresolved ${escapeHtml(project.meta.unresolved_count || 0)}`, '<a href="coverage.html">분석 커버리지</a>'],
      [escapeHtml(project.id), "<code>_analysis_input.json</code>", `<span class="badge ${Object.keys(project.analysisInput || {}).length ? "high" : "danger"}">${Object.keys(project.analysisInput || {}).length ? "LOADED" : "MISSING"}</span>`, String(candidates.length), `패턴 후보 ${candidates.map((item) => escapeHtml(item.slug)).join(", ") || "없음"}`, '<a href="overview.html">시스템 개요</a>'],
      [escapeHtml(project.id), "<code>_unresolved.jsonl</code>", `<span class="badge ${project.unresolvedAvailable ? "high" : "danger"}">${project.unresolvedAvailable ? "LOADED" : "MISSING"}</span>`, String(project.unresolvedCount), "미해결 관계 전체", pages.some((page) => page.id === "risks") ? '<a href="risks.html">위험과 미해결</a>' : '<a href="coverage.html">분석 커버리지</a>'],
    );
    return rows;
  });
  const markdownRows = projects.flatMap((project) => [...new Set(project.documents.map((document) => document.category))].map((category) => {
    const items = project.documents.filter((document) => document.category === category);
    return [escapeHtml(project.id), escapeHtml(category), String(items.length), items.slice(0, 5).map((item) => `<code>${escapeHtml(item.path)}</code>`).join("<br>") + (items.length > 5 ? `<br><span class="muted">외 ${items.length - 5}개</span>` : ""), project.documents.length ? '<a href="documents.html">문서 표·본문</a>' : "-"];
  }));
  atomicWrite(join(wikiDir, "pages", "artifacts.html"), shell("산출물 대시보드", `<h1>산출물 대시보드</h1><p class="muted">하네스가 수집한 Markdown과 결정적 index 파일을 누락 없이 나열하고, 각 산출물이 구조화되어 표시되는 위키 페이지를 연결합니다.</p><div class="stat-grid">${statBox(documents.length, "Markdown")}${statBox(indexArtifactCount, "Index·메타")}${statBox(projects.reduce((sum, project) => sum + project.patterns.length, 0), "패턴 문서")}${statBox(projects.reduce((sum, project) => sum + project.unresolvedCount, 0), "미해결 관계")}</div><h2>Index·분석 입력 반영 현황</h2>${table(["프로젝트", "산출물", "상태", "레코드", "세부", "위키 반영"], indexRows)}<h2>Markdown 반영 현황</h2>${markdownRows.length ? table(["프로젝트", "분류", "문서 수", "대표 원본", "위키 반영"], markdownRows) : '<div class="alert warn">수집된 Markdown 문서가 없습니다.</div>'}`, pages, "../"));

  const workspaceRows = projects.flatMap((project) => asArray(project.meta.workspaces).map((workspace) => [escapeHtml(project.id), escapeHtml(workspace.id || "root"), escapeHtml(workspace.kind || project.role), escapeHtml(workspace.stack || "unknown"), escapeHtml(workspace.path || ".")]));
  const architectureEvidence = projects.map((project) => `<h2>${escapeHtml(project.id)}</h2>${markdownHtml(sectionText(project.analyzer, ["아키텍처와 모듈 책임", "주요 업무 흐름", "기술 스택과 실행 구조", "아키텍처", "주요 흐름", "요청 흐름"]))}`).join("");
  const layerCounts = [...new Set(graph.nodes.map((node) => `${node.project}\0${node.group}`))].map((key) => { const [project, group] = key.split("\0"); return [project, group, graph.nodes.filter((node) => node.project === project && node.group === group).length]; });
  const hubRows = [...graph.nodes].sort((a, b) => b.in_degree - a.in_degree).filter((node) => node.in_degree > 0).slice(0, 15).map((node) => [escapeHtml(node.project), `<a href="../call-graph.html#node=${encodeURIComponent(node.id)}">${escapeHtml(node.label || node.id)}</a>`, escapeHtml(node.group), String(node.in_degree), `<code>${escapeHtml(node.file || "")}${node.line ? `:${escapeHtml(node.line)}` : ""}</code>`]);
  atomicWrite(join(wikiDir, "pages", "architecture.html"), shell("아키텍처", `<h1>아키텍처</h1><p class="flow">${system ? "Frontend (Client) → API contract → Backend (Server) → Service → DB / External" : "Entry point → Service → Data / External I/O"}</p>${architectureNarrativeHtml(narrative, projects, system)}<h2>결정적 구조 지도</h2>${table(["프로젝트", "workspace", "kind", "stack", "path"], workspaceRows)}<h2>레이어 분포</h2>${table(["프로젝트", "레이어", "노드"], layerCounts.map((row) => row.map(escapeHtml)))}<h2>핵심 연결 노드</h2>${table(["프로젝트", "노드", "종류", "in-degree", "근거"], hubRows)}<section class="prose">${architectureEvidence}</section>`, pages, "../"));

  const workflowBody = projects.map((project) => `<h2>${escapeHtml(project.id)}</h2><h3>자동 워크플로우</h3>${markdownHtml(sectionText(project.claude, ["자동 워크플로우"]))}<h3>ITO Guide</h3>${markdownHtml(project.guide)}`).join("");
  atomicWrite(join(wikiDir, "pages", "workflows.html"), shell("개발 워크플로우", `<h1>개발·유지보수 워크플로우</h1><p class="muted">사용자 업무 여정은 <a href="business.html">업무 이해</a>에서, 코드 변경 절차는 이 페이지에서 확인합니다.</p><section class="prose">${workflowBody}</section>`, pages, "../"));

  const qaSections = projects.map((project) => {
    const quality = qualitySignals(project);
    const validatorStatus = project.validator.status || (/\bPASS\b/i.test(project.validatorReport) ? "PASS" : "UNKNOWN");
    const commandRows = quality.commands.map((item) => [`<code>${escapeHtml(item.command)}</code>`, `<code>${escapeHtml(item.purpose)}</code>`]);
    const testRows = quality.files.map((item) => [`<code>${escapeHtml(item.file)}</code>`, String(item.cases.length), item.cases.length ? item.cases.map((name) => escapeHtml(name)).join("<br>") : '<span class="muted">이름 자동 추출 없음</span>']);
    const reportRows = quality.reports.map((document) => [`<a href="documents/${slugify(document.project)}/${document.slug}.html">${escapeHtml(document.title)}</a>`, `<code>${escapeHtml(document.path)}</code>`, escapeHtml(document.source)]);
    const coverageMeasured = quality.reports.some((document) => /(?:coverage|커버리지)/i.test(`${document.path} ${document.title}`));
    return `<section><h2>${escapeHtml(project.id)} <span class="badge ${validatorStatus === "PASS" ? "high" : "medium"}">validator ${escapeHtml(validatorStatus)}</span></h2><div class="stat-grid">${statBox(project.validator.score ?? "-", "validator 점수")}${statBox(project.validator.failures ?? 0, "검증 실패")}${statBox(project.validator.warnings ?? 0, "검증 경고")}${statBox(quality.files.length, "테스트 파일")}${statBox(quality.files.reduce((sum, item) => sum + item.cases.length, 0), "테스트 케이스")}${statBox(quality.reports.length, "QA 문서")}</div>${coverageMeasured ? '<div class="alert warn">커버리지 관련 문서가 존재합니다. 실제 측정값과 기준은 해당 보고서를 확인하세요.</div>' : '<div class="alert warn"><b>코드 커버리지 측정값 없음</b> — 테스트 파일·케이스 존재와 실행 성공은 커버리지 수치를 대신하지 않습니다.</div>'}<h3>실행 가능한 품질 명령</h3>${commandRows.length ? table(["명령", "실제 script/task"], commandRows) : '<p class="muted">프로젝트 manifest에서 test/lint/check/validate 명령을 찾지 못했습니다.</p>'}<h3>테스트 인벤토리</h3>${testRows.length ? table(["테스트 파일", "케이스", "자동 추출한 테스트 이름"], testRows) : '<p class="muted">인덱스·패턴 후보·표준 테스트 디렉터리에서 테스트 파일을 찾지 못했습니다.</p>'}<h3>QA·검증 보고서</h3>${reportRows.length ? table(["보고서", "원본", "수집"], reportRows) : '<p class="muted">별도 QA 보고서 없음</p>'}<h3>하네스 validator 상세</h3><article class="card prose">${markdownHtml(project.validatorReport || "validator 보고서 없음")}</article></section>`;
  }).join("");
  atomicWrite(join(wikiDir, "pages", "qa.html"), shell("QA / 검증", `<h1>QA / 검증</h1><p class="muted">검증 상태와 테스트 자산을 한곳에서 확인합니다. 명령이 존재한다는 사실과 실제 최신 실행 성공은 구분해서 판단합니다.</p>${qaSections}`, pages, "../"));

  if (documents.length) {
    const documentSections = projects.map((project) => {
      const categories = [...new Set(project.documents.map((document) => document.category))];
      const groups = categories.map((category) => {
        const rows = project.documents.filter((document) => document.category === category).map((document) => [
          `<a href="documents/${slugify(project.id)}/${document.slug}.html">${escapeHtml(document.title)}</a>`,
          `<code>${escapeHtml(document.path)}</code>`, escapeHtml(document.source),
        ]);
        return `<h3>${escapeHtml(category)} <span class="badge">${rows.length}</span></h3>${table(["문서", "원본 경로", "수집 방식"], rows)}`;
      }).join("");
      return `<section><h2>${escapeHtml(project.id)} <span class="badge">${project.documents.length}</span></h2>${groups}</section>`;
    }).join("");
    atomicWrite(join(wikiDir, "pages", "documents.html"), shell("프로젝트 문서", `<h1>프로젝트 Markdown 문서</h1><p class="muted">Git 추적 Markdown 전체와 하네스가 생성한 비추적 지식·보고서를 포함합니다. 캐시, 빌드 산출물, 이전 위키와 백업은 제외합니다.</p>${documentSections}`, pages, "../"));
    for (const document of documents) {
      const body = `<p><a href="../../documents.html">← 프로젝트 문서 목록</a></p><h1>${escapeHtml(document.title)}</h1><p><span class="badge">${escapeHtml(document.project)}</span><span class="badge">${escapeHtml(document.category)}</span><span class="badge">${escapeHtml(document.source)}</span></p><p class="muted">원본: <code>${escapeHtml(document.path)}</code></p><article class="card prose">${markdownHtml(document.text)}</article>`;
      atomicWrite(join(wikiDir, ...document.url.split("/")), shell(document.title, body, pages, "../../../"));
    }
  }

  if (pages.some((page) => page.id === "data-model")) {
    const rows = projects.flatMap((project) => asArray(project.indexes.schema.tables).map((item) => [escapeHtml(project.id), `<a href="../call-graph.html#node=${encodeURIComponent(ns(project.id, `table:${item.name}`))}">${escapeHtml(item.name)}</a>`, asArray(item.columns).map((column) => `<code>${escapeHtml(column.name)}</code> ${escapeHtml(column.type || "")}${column.primary_key ? " PK" : ""}`).join("<br>"), escapeHtml(asArray(item.primary_key).join(", ")), asArray(item.foreign_keys).map((fk) => `${escapeHtml(asArray(fk.columns).join(","))} → ${escapeHtml(fk.references_table)}`).join("<br>"), asArray(item.indexes).map((index) => escapeHtml(index.name || asArray(index.columns).join(","))).join("<br>"), `<code>${escapeHtml(item.source_file || "")}</code>`]));
    const evidence = projects.map((project) => `<h2>${escapeHtml(project.id)}</h2>${markdownHtml(sectionText(project.analyzer, ["데이터와 저장소", "트랜잭션과 데이터 일관성", "DB 스키마", "데이터 모델", "데이터 접근 패턴"]))}`).join("");
    atomicWrite(join(wikiDir, "pages", "data-model.html"), shell("데이터 모델", `<h1>데이터 모델</h1><p class="muted">DDL 외래키와 실제 SQL JOIN 조건을 분리해 관계를 표시합니다. 구조화된 schema index에 없는 DB 설명은 analyzer 근거를 함께 제공합니다.</p>${dbRelationshipSection(projects)}<h2>테이블 상세</h2>${rows.length ? table(["프로젝트", "테이블", "컬럼", "PK", "FK", "인덱스", "근거"], rows) : ""}<section class="prose">${evidence}</section>`, pages, "../"));
  }
  if (pages.some((page) => page.id === "sql")) {
    const rows = projects.flatMap((project) => asArray(project.indexes.sql_usage.sqls).map((item) => [escapeHtml(project.id), escapeHtml(item.id), escapeHtml(item.type), asArray(item.tables).map((name) => `<a href="../call-graph.html#node=${encodeURIComponent(ns(project.id, `table:${name}`))}">${escapeHtml(name)}</a>`).join(", "), `<code>${escapeHtml(item.file)}:${escapeHtml(item.line)}</code>`, escapeHtml(item.text_preview)]));
    const endpointRows = projects.flatMap((project) => asArray(project.indexes.api_contracts.endpoints).filter((endpoint) => endpoint.source !== "external").map((endpoint) => [escapeHtml(project.id), `<span class="badge">${escapeHtml(endpoint.method || "ANY")}</span>`, `<code>${escapeHtml(endpoint.path || endpoint.path_pattern || "")}</code>`, endpoint.handler ? `<a href="../call-graph.html#node=${encodeURIComponent(ns(project.id, endpoint.handler))}">${escapeHtml(endpoint.handler)}</a>` : "-", `<code>${escapeHtml(endpoint.file || "")}:${escapeHtml(endpoint.line || "")}</code>`]));
    const evidence = projects.map((project) => `<h2>${escapeHtml(project.id)} 근거</h2>${markdownHtml(sectionText(project.analyzer, ["데이터와 저장소", "API와 외부 연동", "인증·인가와 보안", "SQL", "API contract", "인증/인가 경로"]))}`).join("");
    atomicWrite(join(wikiDir, "pages", "sql.html"), shell("SQL / API", `<h1>SQL / API 엔드포인트</h1>${rows.length ? `<h2>SQL 사용</h2>${table(["프로젝트", "ID", "종류", "테이블", "근거", "미리보기"], rows)}` : ""}${endpointRows.length ? `<h2>API 엔드포인트</h2>${table(["프로젝트", "Method", "Path", "Handler", "근거"], endpointRows)}` : ""}<section class="prose">${evidence}</section>`, pages, "../"));
  }
  if (pages.some((page) => page.id === "transactions")) {
    const rows = projects.flatMap((project) => asArray(project.indexes.transactions.boundaries).map((item) => [escapeHtml(project.id), `<a href="../call-graph.html#node=${encodeURIComponent(ns(project.id, item.entry_method || item.id))}">${escapeHtml(item.entry_method || item.id)}</a>`, escapeHtml(item.marker || ""), escapeHtml(item.propagation || ""), escapeHtml(item.isolation || ""), asArray(item.external_io_calls).length ? `<span class="danger">⚠ ${asArray(item.external_io_calls).map((x) => escapeHtml(x.target || x.type)).join(", ")}</span>` : "-", `<code>${escapeHtml(item.file)}:${escapeHtml(item.line)}</code>`]));
    const evidence = projects.map((project) => `<h2>${escapeHtml(project.id)}</h2>${markdownHtml(sectionText(project.analyzer, ["트랜잭션과 데이터 일관성", "주요 업무 흐름", "트랜잭션", "원자성"]))}`).join("");
    atomicWrite(join(wikiDir, "pages", "transactions.html"), shell("트랜잭션", `<h1>트랜잭션 경계</h1><div class="alert warn"><b>원격 호출과 로컬 DB 변경이 같은 흐름에 있으면 부분 실패와 보상 처리 여부를 확인해야 합니다.</b></div>${rows.length ? table(["프로젝트", "진입 메서드", "표식", "Propagation", "Isolation", "외부 I/O", "근거"], rows) : ""}<section class="prose">${evidence}</section>`, pages, "../"));
  }
  if (pages.some((page) => page.id === "external-io")) {
    const rows = projects.flatMap((project) => asArray(project.indexes.external_io.communications).map((item) => [escapeHtml(project.id), escapeHtml(item.type), escapeHtml(item.target || item.topic || item.path_pattern || ""), item.method ? `<a href="../call-graph.html#node=${encodeURIComponent(ns(project.id, item.method))}">${escapeHtml(item.method)}</a>` : "-", escapeHtml(item.timeout_ms || ""), escapeHtml(item.retry_policy || ""), item.in_transaction ? '<span class="danger">YES</span>' : "NO", `<code>${escapeHtml(item.file)}:${escapeHtml(item.line)}</code>`]));
    const evidence = projects.map((project) => `<h2>${escapeHtml(project.id)}</h2>${markdownHtml(sectionText(project.analyzer, ["API와 외부 연동", "운영·환경·배치", "외부 통신", "외부 연동", "external I/O"]))}`).join("");
    atomicWrite(join(wikiDir, "pages", "external-io.html"), shell("외부 연동", `<h1>외부 연동</h1>${rows.length ? table(["프로젝트", "종류", "대상", "호출 메서드", "Timeout", "Retry", "TX 내부", "근거"], rows) : ""}<section class="prose">${evidence}</section>`, pages, "../"));
  }
  if (pages.some((page) => page.id === "conventions")) {
    const body = projects.map((project) => {
      const summaryRows = project.patterns.map((pattern) => {
        const evidence = new Set([...pattern.text.matchAll(/(?:^|[\s`(])([\w.@+%~\-/\\]+\.[A-Za-z0-9]+):(\d+)(?=$|[\s`),.;])/gm)].map((match) => `${match[1]}:${match[2]}`));
        const examples = [...pattern.text.matchAll(/```[^\n]*\n[\s\S]*?```/g)].length;
        const page = pages.find((item) => item.id === `pattern:${project.id}:${pattern.file}`);
        return [`<a href="${escapeHtml(page?.url.replace(/^pages\//, "") || "#")}"><code>${escapeHtml(pattern.file)}</code></a>`, String(evidence.size), String(examples), escapeHtml(firstParagraph(pattern.text) || "패턴 문서")];
      });
      const cards = project.patterns.map((pattern) => { const page = pages.find((item) => item.id === `pattern:${project.id}:${pattern.file}`); return `<a class="card card-link" href="${escapeHtml(page?.url.replace(/^pages\//, "") || "#")}"><div class="eyebrow">${escapeHtml(project.id)}</div><h3>${escapeHtml(markdownTitle(pattern.file, pattern.text))}</h3><p class="muted">${escapeHtml(firstParagraph(pattern.text) || pattern.file)}</p><code>${escapeHtml(pattern.file)}</code></a>`; }).join("") || '<p class="muted">별도 패턴 문서 없음</p>';
      return `<h2>${escapeHtml(project.id)}</h2>${summaryRows.length ? table(["패턴 파일", "file:line 근거", "코드 예시", "설명"], summaryRows) : ""}<section class="prose">${markdownHtml(sectionText(project.analyzer, ["패턴 후보 검토", "패턴 근거", "코드 컨벤션", "convention"]))}</section><div class="cards">${cards}</div>`;
    }).join("");
    atomicWrite(join(wikiDir, "pages", "conventions.html"), shell("코드 패턴", `<h1>코드 패턴</h1><p class="muted">초기화에서 실제 소스 근거와 코드 예시로 추출한 구현 패턴입니다. 왼쪽 트리에서 패턴별 상세 문서를 바로 열 수 있습니다.</p>${body}`, pages, "../"));
    for (const page of pages.filter((item) => item.kind === "pattern")) {
      const pattern = page.pattern;
      const evidence = new Set([...pattern.text.matchAll(/(?:^|[\s`(])([\w.@+%~\-/\\]+\.[A-Za-z0-9]+):(\d+)(?=$|[\s`),.;])/gm)].map((match) => `${match[1]}:${match[2]}`));
      const examples = [...pattern.text.matchAll(/```[^\n]*\n[\s\S]*?```/g)].length;
      const body = `<p><a href="../conventions.html">← 코드 패턴 전체</a></p><h1>${escapeHtml(page.title)}</h1><p><span class="badge">${escapeHtml(page.project)}</span><span class="badge high">근거 ${evidence.size}</span><span class="badge">코드 예시 ${examples}</span></p><p class="muted">원본: <code>.claude/patterns/${escapeHtml(pattern.file)}</code></p><article class="card prose">${markdownHtml(pattern.text)}</article>`;
      atomicWrite(join(wikiDir, ...page.url.split("/")), shell(page.title, body, pages, "../../"));
    }
  }
  if (pages.some((page) => page.id === "risks")) {
    const rows = [];
    for (const project of projects) {
      for (const item of asArray(project.indexes.dead_code.unused_methods)) rows.push([escapeHtml(project.id), "dead_code", `<a href="../call-graph.html#node=${encodeURIComponent(ns(project.id, item.id))}">${escapeHtml(item.id)}</a>`, `<code>${escapeHtml(item.file)}:${escapeHtml(item.line)}</code>`, escapeHtml(item.reason)]);
      for (const item of asArray(project.indexes.dead_code.unused_sql_ids)) rows.push([escapeHtml(project.id), "unused_sql", escapeHtml(item.id), `<code>${escapeHtml(item.file)}:${escapeHtml(item.line)}</code>`, escapeHtml(item.reason)]);
      for (const item of asArray(project.indexes.env_branches.branches)) rows.push([escapeHtml(project.id), "env_branch", escapeHtml(item.marker), `<code>${escapeHtml(item.file)}:${escapeHtml(item.line)}</code>`, escapeHtml(item.type)]);
      if (project.meta.unresolved_count) rows.push([escapeHtml(project.id), "unresolved", String(project.meta.unresolved_count), "_workspace/index/_unresolved.jsonl", "런타임 또는 의미 판정 필요"]);
    }
    for (const item of asArray(narrative.risks)) rows.push(["system", "narrative", escapeHtml(item.title), asArray(item.evidence).map(escapeHtml).join("<br>"), escapeHtml(item.description)]);
    const authoredRisks = site.risks.map((risk) => `<div class="alert ${risk.severity === "HIGH" ? "" : "warn"}"><span class="badge ${risk.severity === "HIGH" ? "danger" : risk.severity === "MEDIUM" ? "medium" : "low"}">${escapeHtml(risk.severity)}</span> <b>${escapeHtml(risk.project)}</b> — ${escapeHtml(risk.text)}</div>`).join("");
    const evidence = projects.map((project) => `<h2>${escapeHtml(project.id)} 분석 근거</h2>${markdownHtml(sectionText(project.analyzer, ["유지보수 위험과 개선 우선순위", "미해결 사항과 확인 방법", "인증·인가와 보안", "운영·환경·배치", "분석 신뢰도", "보완 권장", "위험", "데드 코드", "환경 분기", "탐지 신뢰도"]))}`).join("");
    atomicWrite(join(wikiDir, "pages", "risks.html"), shell("위험과 미해결", `<h1>위험과 미해결</h1>${authoredRisks}<div class="alert warn"><b>dead-code와 미해결 관계는 정적 분석 후보입니다.</b> 리플렉션·프레임워크 진입점·외부 트리거를 확인하기 전 자동 삭제하지 않습니다.</div>${rows.length ? table(["프로젝트", "종류", "대상", "근거", "사유"], rows) : ""}<section class="prose">${evidence}</section>`, pages, "../"));
  }

  for (const domain of domains) {
    const project = projects.find((item) => item.id === domain.project) || projects[0]; const related = relatedItems(project, domain);
    const symbolRows = related.symbols.map((item) => [`<a href="../../call-graph.html#node=${encodeURIComponent(ns(project.id, item.id))}">${escapeHtml(item.id)}</a>`, escapeHtml(item.type), `<code>${escapeHtml(item.file)}:${escapeHtml(item.line)}</code>`]);
    const sqlRows = related.sql.map((item) => [escapeHtml(item.id), escapeHtml(asArray(item.tables).join(", ")), `<code>${escapeHtml(item.file)}:${escapeHtml(item.line)}</code>`]);
    const apiRows = related.apis.map((item) => [escapeHtml(item.api_kind), `<span class="badge">${escapeHtml(item.method || "ANY")}</span>`, `<code>${escapeHtml(item.path || item.path_pattern || item.url || "")}</code>`, escapeHtml(item.handler || item.id), `<code>${escapeHtml(item.file || "")}:${escapeHtml(item.line || "")}</code>`]);
    atomicWrite(join(wikiDir, "pages", "domains", `${domain.slug}.html`), shell(domain.name, `<h1>${escapeHtml(domain.name)}</h1><span class="badge">${escapeHtml(domain.project)}</span><section class="card prose">${markdownHtml(domain.body)}</section><h2>관련 심볼</h2>${symbolRows.length ? table(["심볼", "종류", "근거"], symbolRows) : '<p class="muted">인덱스에서 직접 연결된 심볼 없음</p>'}<h2>관련 API</h2>${apiRows.length ? table(["종류", "Method", "Path", "Handler / ID", "근거"], apiRows) : '<p class="muted">인덱스에서 직접 연결된 API 없음</p>'}<h2>관련 SQL</h2>${sqlRows.length ? table(["SQL", "테이블", "근거"], sqlRows) : '<p class="muted">인덱스에서 직접 연결된 SQL 없음</p>'}`, pages, "../../"));
  }

  for (const project of projects) {
    const file = project.id === "root" ? "root.html" : `${project.id}.html`;
    const identity = projectIdentity(project); const s = projectStats(project);
    const validatorStatus = project.validator.status || (/\bPASS\b/i.test(project.validatorReport) ? "PASS" : "UNKNOWN");
    const repositoryRisks = extractRisks(project).slice(0, 5).map((risk) => `<div class="alert ${risk.severity === "HIGH" ? "" : "warn"}"><span class="badge ${risk.severity === "HIGH" ? "danger" : risk.severity === "MEDIUM" ? "medium" : "low"}">${escapeHtml(risk.severity)}</span> ${escapeHtml(risk.text)}</div>`).join("");
    const keyEvidence = sectionText(project.analyzer, ["분석 개요", "시스템 목적과 업무 범위", "기술 스택과 실행 구조", "아키텍처와 모듈 책임", "주요 업무 흐름", "데이터와 저장소", "API와 외부 연동", "유지보수 위험과 개선 우선순위", "프로젝트 기본", "아키텍처", "주요 흐름", "요청 흐름", "데이터", "외부 통신", "보완 권장", "위험"]);
    const documentRows = project.documents.slice(0, 30).map((document) => [`<a href="../documents/${slugify(project.id)}/${document.slug}.html">${escapeHtml(document.title)}</a>`, `<code>${escapeHtml(document.path)}</code>`, escapeHtml(document.category)]);
    const stacks = identity.stacks.length ? `<p>${identity.stacks.map((stack) => `<span class="chip">${escapeHtml(stack)}</span>`).join("")}</p>` : "";
    const body = `<h1>${escapeHtml(identity.title)}</h1><p class="muted">${escapeHtml(identity.summary)}</p><p><span class="badge">${escapeHtml(projectRoleLabel(project))}</span><span class="badge ${validatorStatus === "PASS" ? "low" : "medium"}">validator ${escapeHtml(validatorStatus)}</span> <code>${escapeHtml(project.root)}</code></p>${stacks}<div class="stat-grid">${statBox(s.symbols, "심볼")}${statBox(s.nodes, "그래프 노드")}${statBox(s.edges, "그래프 엣지")}${statBox(s.endpoints + s.consumers, "API")}${statBox(s.sql, "SQL")}${statBox(project.documents.length, "Markdown 문서")}</div>${repositoryRisks}<h2>핵심 분석 근거</h2><section class="card prose">${markdownHtml(keyEvidence || project.analyzer)}</section>${project.domain ? `<h2>도메인 지식</h2><section class="card prose">${markdownHtml(project.domain)}</section>` : ""}${documentRows.length ? `<h2>프로젝트 문서</h2>${table(["문서", "원본 경로", "분류"], documentRows)}${project.documents.length > documentRows.length ? '<p><a href="../documents.html">전체 문서 보기 →</a></p>' : ""}` : ""}`;
    atomicWrite(join(wikiDir, "pages", "repositories", file), shell(`${identity.title} 저장소`, body, pages, "../../"));
  }

  if (system) {
    const rows = api.pairs.map(({ consumer, endpoint, match_type, confidence }) => [`<a href="call-graph.html#node=${encodeURIComponent(ns(consumer.project, `consumer:${consumer.id}`))}">${escapeHtml(`${consumer.project}::${consumer.id}`)}</a>`, `<a href="call-graph.html#node=${encodeURIComponent(ns(endpoint.project, endpoint.handler || `endpoint:${endpoint.id}`))}">${escapeHtml(`${endpoint.project}::${endpoint.id}`)}</a>`, escapeHtml(`${endpoint.method} ${endpoint.path_pattern}`), `<span class="badge ${Number(confidence) >= 0.9 ? "low" : Number(confidence) >= 0.7 ? "medium" : "danger"}">${escapeHtml(confidence)}</span>`, `<code>${escapeHtml(JSON.stringify(endpoint.request_shape || {}))}</code>`, `<code>${escapeHtml(JSON.stringify(endpoint.response_shape || {}))}</code>`, escapeHtml(match_type)]);
    const unmatched = [...api.unmatchedConsumers.map((x) => `${x.project}: client call ${x.id}`), ...api.unmatchedEndpoints.map((x) => `${x.project}: endpoint ${x.id}`)];
    atomicWrite(join(wikiDir, "api-contracts.html"), shell("API 계약", `<h1>API 계약</h1><p class="flow">Frontend (Client) → API contract → Backend (Server)</p><div class="stat-grid">${statBox(api.pairs.length, "매칭")}${statBox(api.unmatchedConsumers.length, "미매칭 클라이언트 호출")}${statBox(api.unmatchedEndpoints.length, "미사용 endpoint")}${statBox(apiEdges, "그래프 API 엣지")}</div>${rows.length ? table(["Client call", "Endpoint", "Method / Path", "신뢰도", "Request", "Response", "매칭"], rows) : '<div class="alert warn">클라이언트 호출과 백엔드 endpoint 사이에서 확인된 계약이 없습니다.</div>'}<h2>미매칭</h2><pre>${escapeHtml(unmatched.join("\n") || "없음")}</pre>`, pages));
  }

  const reportName = system ? "08_system_wiki_report.md" : "07_wiki_report.md";
  const visualTypes = [...new Set(graph.nodes.map((node) => node.group))];
  const documentInventory = documents.map((document) => `| ${document.project} | \`${document.path}\` | ${document.category} | ${document.source} |`).join("\n") || "| - | 없음 | - | - |";
  const reportIndexRows = projects.flatMap((project) => INDEX_NAMES.map((name) => {
    const summary = indexArraySummary(project.indexes[name]);
    const status = project.indexAvailability[name] ? "LOADED" : asArray(project.meta.indexes).includes(name) ? "MISSING" : "NO SIGNAL";
    return `| ${project.id} | \`${name}.json\` | ${status} | ${summary.total} | ${summary.detail} |`;
  })).join("\n");
  const narrativeFindings = narrativeStatus.findings.map((finding) => `- ${finding}`).join("\n") || "- 없음";
  const report = `# ${system ? "통합 시스템" : "프로젝트"} 위키 생성 보고서\n\n## 생성 결과\n\n| 항목 | 결과 |\n|---|---|\n| 전체 상태 | **${overallStatus}** |\n| HTML 렌더링 | **PASS** |\n| 분석 커버리지 | **${analysisCoverageStatus}** |\n| API 계약 | **${apiContractStatus}** |\n| Pair 갱신 | **${pairRefresh?.status || "해당 없음"}** |\n| 서술 보강 | **${narrativeStatus.status}** |\n| 서술 근거 | **${narrativeStatus.evidenceCount}개** |\n| AI 호출 | **${narrativeStatus.aiCalls}회** |\n| 위키 위치 | \`${slash(wikiDir)}\` |\n\n## 서술 보강 검증\n\n${narrativeFindings}\n\n## 반영한 지식\n\n- 대상 프로젝트: ${projects.map((p) => p.id).join(", ")}\n- 위키 페이지: ${pages.length}개\n- Markdown 원문: ${documents.length}개(Git ${documents.filter((document) => document.source === "git").length}, 하네스 생성 ${documents.filter((document) => document.source === "generated").length}, 파일시스템 ${documents.filter((document) => document.source === "filesystem").length})\n- Index·메타 산출물: ${indexArtifactCount}개\n- 호출 그래프: 노드 ${graph.nodes.length}개, 엣지 ${graph.edges.length}개, 허브 ${graph.nodes.filter((node) => node.hub).length}개\n- API: endpoint ${api.endpoints.length}개, consumer ${api.consumers.length}개, 계약 edge ${apiEdges}개\n- 미매칭: consumer ${api.unmatchedConsumers.length}개, endpoint ${api.unmatchedEndpoints.length}개\n\n## 생성한 페이지\n\n${pages.map((page) => `- ${page.title}: \`${page.url}\``).join("\n")}\n\n## Index 산출물 인벤토리\n\n| 프로젝트 | Index | 상태 | 레코드 | 세부 |\n|---|---|---|---:|---|\n${reportIndexRows}\n\n## Markdown 문서 인벤토리\n\n| 프로젝트 | 원본 경로 | 분류 | 수집 방식 |\n|---|---|---|---|\n${documentInventory}\n\n## 기계 판정값\n\n\`\`\`text\nstatus: ${overallStatus}\nrender_status: PASS\nanalysis_coverage_status: ${analysisCoverageStatus}\napi_contract_status: ${apiContractStatus}\npair_refresh_status: ${pairRefresh?.status || "NOT_APPLICABLE"}\nmode: ${system ? "system" : "full"}\ngenerator: scripts/build-wiki.mjs\nnarrative_status: ${narrativeStatus.status}\nnarrative_version: ${Number(narrative.version || 0)}\nnarrative_evidence: ${narrativeStatus.evidenceCount}\nnarrative_findings: ${narrativeStatus.findings.length}\nai_calls: ${narrativeStatus.aiCalls}\ncanonical_wiki_root: ${slash(wikiDir)}\nprojects: ${projects.map((p) => p.id).join(", ")}\npages: ${pages.length}\nmarkdown_documents: ${documents.length}\nmarkdown_git: ${documents.filter((document) => document.source === "git").length}\nmarkdown_generated: ${documents.filter((document) => document.source === "generated").length}\nmarkdown_filesystem: ${documents.filter((document) => document.source === "filesystem").length}\nindex_artifacts: ${indexArtifactCount}\ngraph_nodes: ${graph.nodes.length}\ngraph_edges: ${graph.edges.length}\napi_contract_edges: ${apiEdges}\napi_unmatched_consumers: ${api.unmatchedConsumers.length}\napi_unmatched_endpoints: ${api.unmatchedEndpoints.length}\n${system ? "consumer_wiki_written: false\n" : ""}\`\`\`\n`;
  atomicWrite(join(owner, "_workspace", reportName), report);
  return { status: overallStatus, render_status: "PASS", analysis_coverage_status: analysisCoverageStatus, api_contract_status: apiContractStatus, pair_refresh_status: pairRefresh?.status || "NOT_APPLICABLE", narrative_status: narrativeStatus.status, narrative_evidence: narrativeStatus.evidenceCount, narrative_findings: narrativeStatus.findings.length, mode: system ? "system" : "full", owner, wiki: wikiDir, projects: projects.map((p) => p.root), pages: pages.length, markdown_documents: documents.length, index_artifacts: indexArtifactCount, graph_nodes: graph.nodes.length, graph_edges: graph.edges.length, graph_hubs: graph.nodes.filter((node) => node.hub).length, api_contract_edges: apiEdges, api_endpoints: api.endpoints.length, api_consumers: api.consumers.length, api_unmatched_consumers: api.unmatchedConsumers.length, api_unmatched_endpoints: api.unmatchedEndpoints.length, search_items: search.items.length, ai_calls: narrativeStatus.aiCalls };
}

export function buildWiki({ root = null, backend = null, frontend = null, frontends = null, client = null, consumer = null } = {}) {
  const clientInputs = (frontends?.length ? frontends : [frontend || client || consumer].filter(Boolean)).map((item) => resolve(item));
  const system = Boolean(backend && clientInputs.length);
  const backendRoot = system ? resolve(backend) : null;
  const pairRefresh = system ? refreshPair({ backend: backendRoot, consumers: clientInputs }) : null;
  // 클라이언트가 여러 개면 프로젝트 ID가 겹칠 수 있어 중복 시 경로 basename을 덧붙인다.
  const usedIds = new Set(["backend"]);
  const uniqueClientId = (clientRoot) => {
    const base = clientProjectId(clientRoot);
    if (!usedIds.has(base)) { usedIds.add(base); return base; }
    let candidate = `${base}-${basename(clientRoot)}`;
    let suffix = 2;
    while (usedIds.has(candidate)) { candidate = `${base}-${basename(clientRoot)}-${suffix}`; suffix += 1; }
    usedIds.add(candidate); return candidate;
  };
  const projects = system
    ? [loadProject(backendRoot, "backend", "backend"), ...clientInputs.map((clientRoot) => loadProject(clientRoot, uniqueClientId(clientRoot), "client"))]
    : [loadProject(resolve(root), "root", "project")];
  return renderWiki(projects, system ? backendRoot : resolve(root), system, pairRefresh);
}

function help() { return "AX-Harness deterministic wiki\n\n단일: node scripts/build-wiki.mjs --root <project>\npair(1:1): node scripts/build-wiki.mjs --backend <server> --frontend <client>\npair(1:N): node scripts/build-wiki.mjs --backend <server> --frontend <web> --frontend <mobile>\n호환 별칭: --client, --consumer\n"; }

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) { process.stdout.write(help()); return; }
    const result = buildWiki(args); if (!args.quiet) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) { process.stderr.write(`위키 생성 실패: ${error.message}\n`); process.exitCode = 1; }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
if (isMain) main();
