#!/usr/bin/env node
/*
 * AX-Harness deterministic indexer
 *
 * AI에게 전체 소스와 대형 JSON 생성을 맡기지 않기 위한 zero-dependency 1차 인덱서다.
 * 언어별 구문/프레임워크에서 확실하게 추출 가능한 사실은 이 스크립트가 기록하고,
 * 하나로 결정할 수 없는 호출 관계만 _unresolved.jsonl로 넘겨 analyzer가 보강한다.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const INDEXER_VERSION = "1.6.0";

const SOURCE_EXTENSIONS = new Set([
  ".java", ".kt", ".kts", ".js", ".jsx", ".ts", ".tsx", ".vue", ".py", ".cs", ".go",
  ".xml", ".sql", ".jsp", ".jspx", ".tag", ".asp", ".aspx", ".ascx", ".ashx", ".asmx",
  ".vb", ".vbs", ".xaml", ".cshtml", ".vbhtml", ".razor", ".php", ".rb",
  ".cbl", ".cob", ".cpy", ".abap", ".html", ".htm",
  ".properties", ".yml", ".yaml", ".json",
]);
const MANIFEST_FILES = new Set(["pom.xml", "go.mod", "package.json", "build.gradle", "build.gradle.kts", "Cargo.toml", "Gemfile", "composer.json"]);
const DISCOVERY_ONLY_EXTENSIONS = new Set([".fmb", ".mmb", ".olb", ".pbl", ".pbw", ".rpt"]);
const FULL_ADAPTER_EXTENSIONS = new Set([".java", ".kt", ".kts", ".js", ".jsx", ".ts", ".tsx", ".vue", ".py", ".cs", ".go", ".sql"]);
const EXCLUDED_DIRS = new Set([
  ".git", "node_modules", "vendor", "dist", "build", "target", "out", ".next", ".nuxt",
  "coverage", "_workspace", "_workspace_prev", ".claude", ".idea", ".vscode", "bin", "obj",
  ".venv", "venv", "env", ".tox", "site-packages", "__pycache__", ".pytest_cache", ".mypy_cache",
]);
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const CALL_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "throw", "new", "super", "this", "typeof",
  "sizeof", "await", "yield", "require", "import", "function", "class", "def", "func", "when",
]);

function parseArgs(argv) {
  const result = { root: process.cwd(), mode: "init", tier: "Auto", config: null, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") result.root = argv[++i];
    else if (arg === "--mode") result.mode = argv[++i];
    else if (arg === "--tier") result.tier = argv[++i];
    else if (arg === "--config") result.config = argv[++i];
    else if (arg === "--apply-ai-patch") result.applyAiPatch = argv[++i];
    else if (arg === "--quiet") result.quiet = true;
    else if (arg === "--help" || arg === "-h") result.help = true;
    else throw new Error(`알 수 없는 인자: ${arg}`);
  }
  if (!result.applyAiPatch && !new Set(["init", "incremental", "feature-scoped"]).has(result.mode)) {
    throw new Error(`지원하지 않는 mode: ${result.mode}`);
  }
  if (!new Set(["Auto", "Lite", "Standard", "Full"]).has(result.tier)) {
    throw new Error(`지원하지 않는 tier: ${result.tier}`);
  }
  return result;
}

function recommendedTier(score) {
  if (score <= 50) return "Lite";
  if (score <= 120) return "Standard";
  return "Full";
}

function calculateComplexity(facts, config, sourceFileCount) {
  const rels = facts.map((item) => item.rel);
  const sourceScore = sourceFileCount;
  const db = facts.some((item) => item.sqls.length || item.tables.length || item.boundaries.length)
    || config.workspaces.some((item) => /sql|jpa|hibernate|mybatis|ibatis|prisma|sequelize|typeorm/i.test(item.stack));
  const legacy = rels.some((rel) => /(^|\/)WEB-INF\/web\.xml$/i.test(rel))
    || rels.filter((rel) => /\.jsp$/i.test(rel)).length >= 50
    || config.workspaces.some((item) => /struts|ibatis|jsp|egov/i.test(item.stack));
  const manifestCount = rels.filter((rel) => /(^|\/)(pom\.xml|build\.gradle|package\.json)$/i.test(rel)).length;
  const multiModule = config.workspace_mode || manifestCount >= 2;
  const external = facts.some((item) => item.communications.length || item.consumers.length);
  const signals = {
    source_files: sourceScore,
    db_or_orm: db ? 30 : 0,
    legacy_stack: legacy ? 40 : 0,
    multi_module: multiModule ? 20 : 0,
    external_system: external ? 20 : 0,
  };
  const score = Object.values(signals).reduce((sum, value) => sum + value, 0);
  return { score, signals, recommended_tier: recommendedTier(score) };
}

function slash(path) {
  return path.split(sep).join("/");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    renameSync(temp, path);
  } catch (error) {
    if (!existsSync(path) || !["EEXIST", "EPERM"].includes(error.code)) {
      rmSync(temp, { force: true });
      throw error;
    }
    try {
      rmSync(path, { force: true });
      renameSync(temp, path);
    } catch (replaceError) {
      rmSync(temp, { force: true });
      throw replaceError;
    }
  }
}

function isIncluded(rel, includePaths) {
  return includePaths.some((scope) => !scope || rel === scope || rel.startsWith(`${scope}/`));
}

function listFiles(root, includePaths = [""]) {
  const output = [];
  function walk(dir, relDir = "") {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        if (relDir === "plugins" && entry.name === "AX-Harness") continue;
        walk(join(dir, entry.name), join(relDir, entry.name));
        continue;
      }
      const full = join(dir, entry.name);
      const ext = extname(entry.name).toLowerCase();
      if (!SOURCE_EXTENSIONS.has(ext) && !MANIFEST_FILES.has(entry.name)) continue;
      const rel = slash(relative(root, full));
      if (!isIncluded(rel, includePaths)) continue;
      const stats = statSync(full);
      if (stats.size <= MAX_FILE_BYTES) output.push({ full, rel, stats });
    }
  }
  walk(root);
  return output.sort((a, b) => a.rel.localeCompare(b.rel));
}

function discoverUnsupportedFiles(root, includePaths = [""]) {
  const output = [];
  function walk(dir, relDir = "") {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        if (relDir === "plugins" && entry.name === "AX-Harness") continue;
        walk(join(dir, entry.name), join(relDir, entry.name));
        continue;
      }
      const ext = extname(entry.name).toLowerCase();
      if (!DISCOVERY_ONLY_EXTENSIONS.has(ext)) continue;
      const rel = slash(relative(root, join(dir, entry.name)));
      if (isIncluded(rel, includePaths)) output.push(rel);
    }
  }
  walk(root);
  return output.sort();
}

function adapterCoverage(facts, unsupportedFiles) {
  const extensions = new Map();
  for (const fact of facts) {
    const ext = extname(fact.rel).toLowerCase() || basename(fact.rel);
    const hasNestedPythonRouting = ext === ".py" && fact.endpoints?.some((item) => ["django", "flask"].includes(item.framework));
    const level = FULL_ADAPTER_EXTENSIONS.has(ext) && !hasNestedPythonRouting ? "FULL" : "PARTIAL";
    const current = extensions.get(ext) || { extension: ext, level, files: 0 };
    current.files += 1;
    if (level === "PARTIAL") current.level = "PARTIAL";
    extensions.set(ext, current);
  }
  const partialFiles = [...extensions.values()].filter((item) => item.level === "PARTIAL").reduce((sum, item) => sum + item.files, 0);
  const fullFiles = [...extensions.values()].filter((item) => item.level === "FULL").reduce((sum, item) => sum + item.files, 0);
  return {
    status: unsupportedFiles.length ? "WARN" : partialFiles ? "PARTIAL" : "FULL",
    full_files: fullFiles, partial_files: partialFiles, unsupported_files: unsupportedFiles,
    extensions: [...extensions.values()].sort((a, b) => a.extension.localeCompare(b.extension)),
  };
}

function loadConfig(root, configArg) {
  const configPath = configArg ? (isAbsolute(configArg) ? configArg : join(root, configArg)) : join(root, "_workspace", "indexer-config.json");
  const config = readJson(configPath, {}) || {};
  const includePaths = Array.isArray(config.include_paths) && config.include_paths.length
    ? config.include_paths
      .map((item) => slash(String(item).trim().replace(/^\.\//, "").replace(/\/$/, "")))
      .map((item) => item === "." ? "" : item)
      .filter((item) => item !== ".." && !item.startsWith("../"))
    : [""];
  const workspaces = Array.isArray(config.workspaces) && config.workspaces.length
    ? config.workspaces.map((item) => ({
        id: item.id || "root",
        path: slash((item.path || "").replace(/^\.\//, "").replace(/\/$/, "")),
        kind: item.kind || "unknown",
        stack: item.stack || "unknown",
        calls_backend_api: Boolean(item.calls_backend_api),
      }))
    : [{ id: "root", path: "", kind: config.kind || "unknown", stack: config.stack || "unknown", calls_backend_api: false }];
  const allowedLayouts = new Set(["single-root", "monorepo", "paired-roots", "selected-paths"]);
  const initLayout = allowedLayouts.has(config.init_layout)
    ? config.init_layout
    : (config.workspace_mode ? "monorepo" : (includePaths.some(Boolean) ? "selected-paths" : "single-root"));
  return { init_layout: initLayout, workspace_mode: Boolean(config.workspace_mode), workspaces, include_paths: includePaths.length ? includePaths : [""] };
}

function workspaceFor(rel, config) {
  const matches = config.workspaces
    .filter((item) => !item.path || rel === item.path || rel.startsWith(`${item.path}/`))
    .sort((a, b) => b.path.length - a.path.length);
  return matches[0] || config.workspaces[0];
}

function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let low = 0;
    let high = starts.length;
    while (low + 1 < high) {
      const mid = (low + high) >> 1;
      if (starts[mid] <= offset) low = mid;
      else high = mid;
    }
    return low + 1;
  };
}

// 문자열과 줄바꿈은 보존하고 주석 문자만 공백으로 바꿔 line/offset을 안정적으로 유지한다.
function stripComments(text, ext) {
  let output = "";
  let state = "code";
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const n = text[i + 1];
    if (state === "line") {
      if (c === "\n") { state = "code"; output += c; } else output += " ";
    } else if (state === "block") {
      if (c === "*" && n === "/") { output += "  "; i += 1; state = "code"; }
      else output += c === "\n" ? "\n" : " ";
    } else if (state === "string") {
      output += c;
      if (c === "\\") { output += n || ""; i += 1; }
      else if (c === quote) state = "code";
    } else if (c === "/" && n === "/") {
      output += "  "; i += 1; state = "line";
    } else if (c === "/" && n === "*") {
      output += "  "; i += 1; state = "block";
    } else if (c === "#" && ext === ".py") {
      output += " "; state = "line";
    } else if (c === "\"" || c === "'" || c === "`") {
      output += c; quote = c; state = "string";
    } else output += c;
  }
  return output;
}

function matchingBrace(text, open) {
  if (open < 0 || text[open] !== "{") return text.length;
  let depth = 0;
  let quote = "";
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "\"" || c === "'" || c === "`") quote = c;
    else if (c === "{") depth += 1;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return text.length;
}

function packageName(text, ext, rel) {
  if (ext === ".java" || ext === ".kt" || ext === ".kts") return text.match(/\bpackage\s+([\w.]+)/)?.[1] || "";
  if (ext === ".cs") return text.match(/\bnamespace\s+([\w.]+)/)?.[1] || "";
  if (ext === ".py") return rel.replace(/\.py$/, "").replace(/\/__init__$/, "").replaceAll("/", ".");
  if (ext === ".go") return text.match(/\bpackage\s+(\w+)/)?.[1] || dirname(rel).replaceAll("/", ".");
  return rel.replace(/\.(?:jsx?|tsx?|vue)$/, "").replaceAll("/", ".");
}

function symbolId(pkg, owner, name) {
  return [pkg, owner, name].filter(Boolean).join(".");
}

function extractLegacySymbols(text, clean, rel, workspace) {
  const ext = extname(rel).toLowerCase(); const atLine = lineIndex(text);
  const pkg = rel.replace(/\.[^.]+$/, "").replaceAll("/", ".");
  const methods = []; const add = (name, offset, type = "function") => {
    const id = symbolId(pkg, "", name);
    if (!methods.some((item) => item.id === id)) methods.push({ id, name, owner: "", package: pkg, file: rel, line: atLine(offset), start: offset, end: clean.length, visibility: "unknown", workspace: workspace.id, type });
  };
  const patterns = [];
  if ([".vb", ".vbs", ".asp"].includes(ext)) patterns.push(/^(?:\s*(?:Public|Private|Protected|Friend|Static)\s+)?(?:Sub|Function)\s+(\w+)/gim);
  if (ext === ".php") patterns.push(/\bfunction\s+([A-Za-z_]\w*)\s*\(/g);
  if (ext === ".rb") patterns.push(/^\s*def\s+([A-Za-z_]\w*[!?=]?)/gm);
  if ([".cbl", ".cob", ".cpy"].includes(ext)) patterns.push(/^\s{0,12}([A-Z0-9][A-Z0-9-]+)\.\s*(?:$|\*>)/gm);
  if (ext === ".abap") patterns.push(/^\s*(?:FORM|METHOD|FUNCTION|MODULE)\s+([A-Za-z_]\w*)/gim);
  for (const regex of patterns) for (const match of clean.matchAll(regex)) {
    if (/^(?:IDENTIFICATION|ENVIRONMENT|DATA|PROCEDURE|WORKING-STORAGE|LINKAGE|END-IF|END-PERFORM)$/i.test(match[1])) continue;
    add(match[1], match.index);
  }
  const markup = new Set([".jsp", ".jspx", ".tag", ".aspx", ".ascx", ".ashx", ".asmx", ".xaml", ".cshtml", ".vbhtml", ".razor", ".html", ".htm"]);
  const symbols = methods.map((method) => ({ id: method.id, type: method.type, file: rel, line: method.line, package: pkg, workspace: workspace.id, origin: "deterministic-indexer", confidence: "MEDIUM" }));
  if (markup.has(ext)) symbols.push({ id: `view:${rel}`, type: "view", file: rel, line: 1, workspace: workspace.id, origin: "deterministic-indexer", confidence: "HIGH" });
  return { symbols, nodes: symbols.map((item) => ({ ...item })), methods, callSites: [], injects: [], classes: [] };
}

function extractSymbols(text, clean, rel, workspace) {
  const ext = extname(rel).toLowerCase();
  if (![".java", ".kt", ".kts", ".js", ".jsx", ".ts", ".tsx", ".vue", ".py", ".cs", ".go"].includes(ext)) {
    return extractLegacySymbols(text, clean, rel, workspace);
  }
  const atLine = lineIndex(text);
  const pkg = packageName(clean, ext, rel);
  const classes = [];
  const classRegex = /(?:^|\s)(?:export\s+)?(?:public\s+|private\s+|protected\s+|abstract\s+|final\s+|sealed\s+|data\s+|internal\s+)*(class|interface|enum|record|object)\s+(\w+)(?:\s+extends\s+([\w.]+))?(?:\s+(?:implements|:)\s*([^\n{]+))?\s*\{/gm;
  for (const match of clean.matchAll(classRegex)) {
    const open = clean.indexOf("{", match.index);
    classes.push({
      name: match[2], type: match[1], start: match.index, end: matchingBrace(clean, open), line: atLine(match.index),
      extends: match[3] || null,
      implements: (match[4] || "").split(",").map((v) => v.trim().replace(/\(.*/, "")).filter(Boolean),
    });
  }
  if (ext === ".py") {
    const pyClasses = [...clean.matchAll(/^(\s*)class\s+(\w+)(?:\(([^)]*)\))?\s*:/gm)];
    const lines = clean.split(/(?<=\n)/);
    const offsets = [];
    let cursor = 0;
    for (const line of lines) { offsets.push(cursor); cursor += line.length; }
    for (const match of pyClasses) {
      const indent = match[1].length;
      const startLine = atLine(match.index) - 1;
      let end = clean.length;
      for (let i = startLine + 1; i < lines.length; i += 1) {
        if (!lines[i].trim()) continue;
        const currentIndent = lines[i].match(/^\s*/)[0].replace(/\t/g, "    ").length;
        if (currentIndent <= indent) { end = offsets[i]; break; }
      }
      classes.push({ name: match[2], type: "class", start: match.index, end, line: atLine(match.index), extends: match[3]?.split(",")[0]?.trim() || null, implements: [] });
    }
  }
  const ownerAt = (offset) => classes.filter((item) => item.start <= offset && offset < item.end).sort((a, b) => b.start - a.start)[0]?.name || "";
  const methods = [];
  const pushMethod = (name, index, open, visibility = "unknown") => {
    if (!name || CALL_KEYWORDS.has(name)) return;
    const owner = ownerAt(index);
    const id = symbolId(pkg, owner, name);
    if (methods.some((item) => item.id === id && item.line === atLine(index))) return;
    methods.push({ id, name, owner, package: pkg, file: rel, line: atLine(index), start: index, end: matchingBrace(clean, open), visibility, workspace: workspace.id });
  };

  if ([".java", ".cs", ".kt", ".kts"].includes(ext)) {
    const methodRegex = /\b(public|protected|private|internal)?\s*(?:static\s+|final\s+|abstract\s+|synchronized\s+|override\s+|open\s+|suspend\s+|async\s+)*(?:fun\s+)?(?:[\w<>,.?\[\]]+\s+)?(\w+)\s*\([^;{}]*\)\s*(?:throws\s+[^\n{]+)?\s*\{/gm;
    for (const match of clean.matchAll(methodRegex)) pushMethod(match[2], match.index, clean.indexOf("{", match.index), match[1] || "package");
  } else if ([".js", ".jsx", ".ts", ".tsx", ".vue"].includes(ext)) {
    const functionRegex = /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)\s*\([^)]*\)\s*\{|\b(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>\s*\{/gm;
    for (const match of clean.matchAll(functionRegex)) pushMethod(match[1] || match[2], match.index, clean.indexOf("{", match.index), "module");
    const classMethodRegex = /^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(\w+)\s*\([^)]*\)\s*\{/gm;
    for (const match of clean.matchAll(classMethodRegex)) if (ownerAt(match.index)) pushMethod(match[1], match.index, clean.indexOf("{", match.index), "unknown");
  } else if (ext === ".py") {
    const pyRegex = /^(\s*)(?:async\s+)?def\s+(\w+)\s*\([^)]*\)\s*(?:->[^:]+)?:/gm;
    const all = [...clean.matchAll(pyRegex)];
    for (let i = 0; i < all.length; i += 1) {
      const match = all[i];
      const indent = match[1].length;
      const next = all.slice(i + 1).find((candidate) => candidate[1].length <= indent);
      const owner = classes.filter((item) => item.start <= match.index && match.index < item.end).sort((a, b) => b.start - a.start)[0]?.name || "";
      const id = symbolId(pkg, owner, match[2]);
      methods.push({ id, name: match[2], owner, package: pkg, file: rel, line: atLine(match.index), start: match.index, end: next?.index || clean.length, visibility: match[2].startsWith("_") ? "private" : "public", workspace: workspace.id });
    }
  } else if (ext === ".go") {
    const goRegex = /\bfunc\s*(?:\([^)]*\)\s*)?(\w+)\s*\([^)]*\)[^{]*\{/gm;
    for (const match of clean.matchAll(goRegex)) pushMethod(match[1], match.index, clean.indexOf("{", match.index), /^[A-Z]/.test(match[1]) ? "public" : "private");
  }

  const symbols = classes.map((item) => ({
    id: symbolId(pkg, "", item.name), type: item.type, file: rel, line: item.line, package: pkg,
    ...(item.extends ? { extends: item.extends } : {}), ...(item.implements.length ? { implements: item.implements } : {}),
    methods: methods.filter((method) => method.owner === item.name).map((method) => ({ name: method.name, id: method.id, line: method.line, visibility: method.visibility })),
    workspace: workspace.id, origin: "deterministic-indexer", confidence: "HIGH",
  }));
  for (const method of methods.filter((item) => !item.owner)) {
    symbols.push({ id: method.id, type: "function", file: rel, line: method.line, package: pkg, workspace: workspace.id, origin: "deterministic-indexer", confidence: "HIGH" });
  }
  const nodes = [
    ...classes.map((item) => ({ id: symbolId(pkg, "", item.name), type: item.type, file: rel, line: item.line, workspace: workspace.id, origin: "deterministic-indexer", confidence: "HIGH" })),
    ...methods.map((item) => ({ id: item.id, type: "method", file: rel, line: item.line, visibility: item.visibility, workspace: workspace.id, origin: "deterministic-indexer", confidence: "HIGH" })),
  ];
  const callSites = [];
  const callRegex = /\b([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?\s*\(/g;
  for (const method of methods) {
    const body = clean.slice(method.start, method.end);
    for (const match of body.matchAll(callRegex)) {
      const name = match[2] || match[1];
      if (CALL_KEYWORDS.has(name) || (!match[2] && name === method.name && match.index < 120)) continue;
      callSites.push({ caller: method.id, name, qualifier: match[2] ? match[1] : "", file: rel, line: atLine(method.start + match.index), workspace: workspace.id });
    }
  }
  const injects = [];
  const injectRegex = /(?:@Autowired|@Inject|@Resource(?:\([^)]*\))?)\s*(?:private|protected|public|lateinit\s+var|val|var)?\s*([A-Z][\w.]*)\s+(\w+)/gm;
  for (const match of clean.matchAll(injectRegex)) {
    const owner = ownerAt(match.index);
    if (owner) injects.push({ owner: symbolId(pkg, "", owner), targetName: match[1].split(".").at(-1), file: rel, line: atLine(match.index), workspace: workspace.id });
  }
  return { symbols, nodes, methods, callSites, injects, classes };
}

function extractBindings(text, clean, rel, workspace, methods) {
  const atLine = lineIndex(text); const bindings = [];
  const add = (trigger, handler, type, offset) => {
    if (!handler) return;
    bindings.push({ trigger: `${rel}#${trigger}`, handler_name: handler, type, file: rel, line: atLine(offset), workspace: workspace.id });
  };
  const dotnetEvent = /(?:this\.)?([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\+=\s*(?:new\s+\w+(?:<[^>]+>)?\s*\(\s*)?(?:this\.)?([A-Za-z_]\w*)/g;
  for (const match of clean.matchAll(dotnetEvent)) add(`${match[1]}.${match[2]}`, match[3], "ui_event", match.index);
  const markupEvent = /<([A-Za-z_:][\w:.-]*)\b[^>]*\b(?:OnClick|Click|OnCommand|Command)\s*=\s*["'](?:\{Binding\s+)?([A-Za-z_]\w*)[^"']*["']/gi;
  for (const match of text.matchAll(markupEvent)) add(`${match[1]}.${match[2]}`, match[2], "markup_event", match.index);
  const scheduled = /@Scheduled\s*\(([^)]*)\)/g;
  for (const match of clean.matchAll(scheduled)) add(`scheduled:${match[1].replace(/\s+/g, " ").slice(0, 80)}`, nextMethod(methods, atLine(match.index))?.name, "scheduler", match.index);
  const main = methods.find((method) => /^(?:main|Main)$/i.test(method.name));
  if (main) add("process-entry", main.name, "process_entry", Math.max(0, main.start));
  return bindings;
}

function quotedValue(value = "") {
  return value.match(/["'`]([^"'`]*)["'`]/)?.[1] || "";
}

function normalizePath(path) {
  const value = (`/${path || ""}`).replace(/\/+/g, "/").replace(/\/\/+/, "/");
  return value.replace(/\$\{[^}]+\}|\{[^}]+\}|:\w+|\[[^\]]+\]/g, "{param}").replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

function pythonModule(rel) {
  return slash(rel).replace(/\.py$/i, "").replace(/\/__init__$/i, "").replaceAll("/", ".");
}

function resolvePythonImport(ownerModule, source) {
  if (!source.startsWith(".")) return source;
  const dots = source.match(/^\.+/)?.[0].length || 0;
  const suffix = source.slice(dots);
  const parts = ownerModule.split(".").slice(0, -1);
  for (let i = 1; i < dots; i += 1) parts.pop();
  return [...parts, suffix].filter(Boolean).join(".");
}

function extractFastApiMeta(text, clean, rel) {
  if (!rel.toLowerCase().endsWith(".py")) return null;
  const module = pythonModule(rel);
  const constants = [];
  for (const match of clean.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*(?::[^=\n]+)?=\s*[rubfRUBF]*(["'])([^\n]*?)\2\s*$/gm)) {
    constants.push({ name: match[1], value: match[3], module });
  }
  const imports = {};
  for (const match of clean.matchAll(/^\s*from\s+([.\w]+)\s+import\s+([^\n#]+)/gm)) {
    const source = resolvePythonImport(module, match[1]);
    for (const entry of match[2].replace(/[()]/g, "").split(",")) {
      const item = entry.trim().match(/^(\w+)(?:\s+as\s+(\w+))?$/);
      if (item) imports[item[2] || item[1]] = `${source}.${item[1]}`;
    }
  }
  for (const match of clean.matchAll(/^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?/gm)) {
    imports[match[2] || match[1].split(".").at(-1)] = match[1];
  }
  const routerPrefixes = {};
  for (const match of clean.matchAll(/^\s*(\w+)\s*=\s*APIRouter\s*\(([^)]*)\)/gm)) {
    const prefix = match[2].match(/\bprefix\s*=\s*([furbFURB]*["'][^"']*["']|[^,\n)]+)/)?.[1]?.trim();
    if (prefix) routerPrefixes[match[1]] = prefix;
  }
  const mounts = [];
  const includeRouter = /\binclude_router\s*\(\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*,([\s\S]*?)\)\s*(?:\n|$)/g;
  for (const match of clean.matchAll(includeRouter)) {
    const reference = match[1]; const head = reference.split(".")[0];
    const imported = imports[head] ? `${imports[head]}${reference.slice(head.length)}` : reference;
    const targetModule = imported.replace(/\.router$/, "");
    const prefixExpression = match[2].match(/\bprefix\s*=\s*([furbFURB]*["'][^"']*["']|[^,\n)]+)/)?.[1]?.trim() || "\"\"";
    mounts.push({ ownerModule: module, targetModule, prefixExpression });
  }
  return { module, constants, imports, routerPrefixes, mounts, appRoot: /\bFastAPI\s*\(/.test(clean) };
}

function resolveStaticPythonString(expression, constants) {
  const value = String(expression || "").trim();
  const literal = value.match(/^[furbFURB]*(["'])([\s\S]*)\1$/);
  if (literal) {
    let resolved = literal[2]; let complete = true;
    resolved = resolved.replace(/\{([^}]+)\}/g, (_, reference) => {
      const name = reference.trim().split(".").at(-1);
      if (!constants.has(name)) { complete = false; return ""; }
      return constants.get(name);
    });
    return complete ? resolved : null;
  }
  const name = value.split(".").at(-1);
  return constants.get(name) ?? null;
}

function joinApiPath(...parts) {
  return normalizePath(parts.filter(Boolean).join("/"));
}

function composeFastApiEndpoints(facts, endpoints) {
  const metas = facts.map((item) => item.fastApi).filter(Boolean);
  if (!metas.length) return endpoints;
  const constants = new Map(); const conflicts = new Set();
  for (const item of metas.flatMap((meta) => meta.constants || [])) {
    if (constants.has(item.name) && constants.get(item.name) !== item.value) conflicts.add(item.name);
    else constants.set(item.name, item.value);
  }
  for (const name of conflicts) constants.delete(name);
  const prefixes = new Map(); const queue = [];
  for (const meta of metas.filter((item) => item.appRoot)) {
    prefixes.set(meta.module, new Set([""])); queue.push(meta.module);
  }
  const resolvedMounts = metas.flatMap((meta) => meta.mounts || []).map((mount) => ({
    ...mount, prefix: resolveStaticPythonString(mount.prefixExpression, constants),
  }));
  const unresolvedTargets = new Set(resolvedMounts.filter((mount) => mount.prefix === null).map((mount) => mount.targetModule));
  const mounts = resolvedMounts.filter((mount) => mount.prefix !== null);
  if (!queue.length) for (const owner of new Set(mounts.map((mount) => mount.ownerModule))) {
    if (mounts.some((mount) => mount.targetModule === owner)) continue;
    prefixes.set(owner, new Set([""])); queue.push(owner);
  }
  while (queue.length) {
    const owner = queue.shift();
    for (const mount of mounts.filter((item) => item.ownerModule === owner)) {
      const target = prefixes.get(mount.targetModule) || new Set(); const before = target.size;
      for (const base of prefixes.get(owner) || [""]) target.add(joinApiPath(base, mount.prefix));
      prefixes.set(mount.targetModule, target);
      if (target.size > before) queue.push(mount.targetModule);
    }
  }
  const metaByModule = new Map(metas.map((meta) => [meta.module, meta]));
  return endpoints.flatMap((endpoint) => {
    if (endpoint.framework !== "fastapi") return [endpoint];
    const module = pythonModule(endpoint.file); const meta = metaByModule.get(module);
    const mounted = [...(prefixes.get(module) || new Set([""]))];
    const localExpression = meta?.routerPrefixes?.[endpoint.router];
    const localPrefix = localExpression ? resolveStaticPythonString(localExpression, constants) : "";
    if ((localExpression && localPrefix === null) || (unresolvedTargets.has(module) && !prefixes.has(module))) {
      return [{ ...endpoint, prefix_resolved: false, confidence: "LOW" }];
    }
    return mounted.map((base) => {
      const path = joinApiPath(base, localPrefix || "", endpoint.path);
      return { ...endpoint, path, path_pattern: normalizePath(path), prefix_resolved: true, id: `${endpoint.workspace}::${endpoint.method} ${normalizePath(path)}::${endpoint.handler}` };
    });
  });
}

function nextMethod(methods, line) {
  return methods.filter((item) => item.line >= line).sort((a, b) => a.line - b.line)[0];
}

function extractApi(text, clean, rel, workspace, methods, classes = []) {
  const atLine = lineIndex(text);
  const endpoints = [];
  const consumers = [];
  const addEndpoint = (method, path, handler, offset, extra = {}) => endpoints.push({
    id: `${workspace.id}::${method.toUpperCase()} ${normalizePath(path)}::${handler || basename(rel)}`,
    workspace: workspace.id, source: "local", method: method.toUpperCase(), path: path || "/", path_pattern: normalizePath(path),
    handler: handler || basename(rel), file: rel, line: atLine(offset), origin: "deterministic-indexer", confidence: "HIGH", ...extra,
  });
  const addConsumer = (callType, method, path, offset, fn = "") => consumers.push({
    id: `${workspace.id}::${rel}:${atLine(offset)}::${method.toUpperCase()} ${normalizePath(path)}`,
    workspace: workspace.id, source: "local", call_type: callType, method: method.toUpperCase(), path_literal: path,
    path_pattern: normalizePath(path), file: rel, line: atLine(offset), ...(fn ? { function: fn } : {}),
    consumer_kind: workspace.kind, origin: "deterministic-indexer", confidence: path.includes("+") ? "MEDIUM" : "HIGH",
  });
  const classBaseAt = (offset) => {
    const owner = classes.filter((item) => item.start <= offset && offset < item.end).sort((a, b) => b.start - a.start)[0];
    if (!owner) return "";
    const prefix = clean.slice(Math.max(0, owner.start - 600), owner.start);
    const java = [...prefix.matchAll(/@RequestMapping\s*(?:\(([^)]*)\))?/g)].at(-1);
    const csharpRoute = [...prefix.matchAll(/\[Route\s*\(([^\]]*)\)\]/g)].at(-1);
    let value = quotedValue(java?.[1] || csharpRoute?.[1]);
    if (csharpRoute && owner) value = value.replace(/\[controller\]/gi, owner.name.replace(/Controller$/i, ""));
    return value;
  };

  const javaRoute = /@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\s*(?:\(([^)]*)\))?/gm;
  for (const match of clean.matchAll(javaRoute)) {
    const after = clean.slice(match.index + match[0].length, match.index + match[0].length + 500);
    if (/^\s*(?:public\s+)?(?:class|interface)\b/.test(after)) continue;
    const routeMethod = match[1] === "RequestMapping"
      ? (match[2]?.match(/RequestMethod\.(GET|POST|PUT|DELETE|PATCH)/)?.[1] || "ANY")
      : match[1].replace("Mapping", "").toUpperCase();
    const path = joinApiPath(classBaseAt(match.index), quotedValue(match[2]) || "/");
    const handler = nextMethod(methods, atLine(match.index))?.id || basename(rel);
    addEndpoint(routeMethod, path, handler, match.index);
  }
  const fastApi = /@(\w+)\.(get|post|put|delete|patch)\s*\(([^)]*)\)/g;
  for (const match of clean.matchAll(fastApi)) addEndpoint(match[2], quotedValue(match[3]), nextMethod(methods, atLine(match.index))?.id, match.index, { framework: "fastapi", router: match[1] });
  const flask = /@(\w+)\.route\s*\(\s*(["'])([^"']+)\2([^)]*)\)/g;
  for (const match of clean.matchAll(flask)) {
    const declared = [...match[4].matchAll(/["'](GET|POST|PUT|DELETE|PATCH)["']/gi)].map((item) => item[1]);
    for (const method of declared.length ? declared : ["GET"]) addEndpoint(method, match[3], nextMethod(methods, atLine(match.index))?.id, match.index, { framework: "flask", router: match[1] });
  }
  const django = /\b(?:path|re_path)\s*\(\s*(["'])([^"']+)\1\s*,\s*([\w.]+)/g;
  for (const match of clean.matchAll(django)) addEndpoint("ANY", `/${match[2]}`, match[3], match.index, { framework: "django" });
  const express = /\b(?:app|router)\s*\.\s*(get|post|put|delete|patch|use)\s*\(\s*(["'`])([^"'`]+)\2\s*,\s*([\w.]+)/g;
  for (const match of clean.matchAll(express)) if (clean[match.index - 1] !== "@") addEndpoint(match[1], match[3], match[4], match.index, { framework: "express" });
  const csharp = /\[Http(Get|Post|Put|Delete|Patch)(?:\(([^\]]*)\))?\]/g;
  for (const match of clean.matchAll(csharp)) addEndpoint(match[1], joinApiPath(classBaseAt(match.index), quotedValue(match[2]) || "/"), nextMethod(methods, atLine(match.index))?.id, match.index, { framework: "aspnet" });
  const struts = /<action\b[^>]*\bpath\s*=\s*["']([^"']+)["'][^>]*\btype\s*=\s*["']([^"']+)["'][^>]*>/gi;
  for (const match of text.matchAll(struts)) addEndpoint("ANY", match[1], match[2], match.index, { framework: "struts" });
  const servletPattern = /<servlet-mapping>[\s\S]*?<servlet-name>\s*([^<]+)\s*<\/servlet-name>[\s\S]*?<url-pattern>\s*([^<]+)\s*<\/url-pattern>[\s\S]*?<\/servlet-mapping>/gi;
  for (const match of text.matchAll(servletPattern)) addEndpoint("ANY", match[2], match[1].trim(), match.index, { framework: "servlet" });
  if (/\.(?:asp|aspx|ashx|asmx)$/i.test(rel)) addEndpoint("ANY", `/${rel}`, basename(rel), 0, { framework: rel.toLowerCase().endsWith(".asp") ? "classic-asp" : "aspnet-webforms" });

  const axios = /\baxios\s*\.\s*(get|post|put|delete|patch)\s*\(\s*(["'`])([^"'`]+)\2/g;
  for (const match of clean.matchAll(axios)) addConsumer("axios", match[1], match[3], match.index);
  const fetchCall = /\b(fetch|useFetch|\$fetch)\s*\(\s*(["'`])([^"'`]+)\2\s*(?:,\s*\{([\s\S]{0,300}?)\})?/g;
  for (const match of clean.matchAll(fetchCall)) {
    const method = match[4]?.match(/method\s*:\s*["'](\w+)["']/i)?.[1] || "GET";
    addConsumer(match[1], method, match[3], match.index);
  }
  const httpClient = /\b(?:GetAsync|PostAsync|PutAsync|DeleteAsync|PatchAsync)\s*\(\s*\$?(["'])([^"']+)\1/g;
  for (const match of clean.matchAll(httpClient)) addConsumer("HttpClient", match[0].match(/(Get|Post|Put|Delete|Patch)Async/)?.[1] || "GET", match[2], match.index);
  const restSharp = /new\s+RestRequest\s*\(\s*(["'])([^"']+)\1\s*,\s*Method\.(Get|Post|Put|Delete|Patch)/g;
  for (const match of clean.matchAll(restSharp)) addConsumer("RestSharp", match[3], match[2], match.index);
  const refit = /\[(Get|Post|Put|Delete|Patch)\s*\(\s*(["'])([^"']+)\2\s*\)\]/g;
  for (const match of clean.matchAll(refit)) addConsumer("Refit", match[1], match[3], match.index, nextMethod(methods, atLine(match.index))?.id);
  const retrofit = /@(GET|POST|PUT|DELETE|PATCH)\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of clean.matchAll(retrofit)) addConsumer("Retrofit", match[1], match[2], match.index, nextMethod(methods, atLine(match.index))?.id);
  const form = /<form\b([^>]*)>/gi;
  for (const match of text.matchAll(form)) {
    const path = match[1].match(/\baction\s*=\s*["']([^"']+)["']/i)?.[1]; if (!path) continue;
    const method = match[1].match(/\bmethod\s*=\s*["'](\w+)["']/i)?.[1] || "GET";
    addConsumer("html-form", method, path, match.index);
  }
  const jqueryAjax = /\$\.ajax\s*\(\s*\{([\s\S]{0,600}?)\}\s*\)/g;
  for (const match of text.matchAll(jqueryAjax)) {
    const path = match[1].match(/\burl\s*:\s*["']([^"']+)["']/i)?.[1]; if (!path) continue;
    const method = match[1].match(/\b(?:type|method)\s*:\s*["'](\w+)["']/i)?.[1] || "GET";
    addConsumer("jquery-ajax", method, path, match.index);
  }
  return { endpoints, consumers };
}

function sqlTables(sql) {
  const tables = [...sql.matchAll(/\b(?:from|join|update|into|table)\s+([\w.$"`]+)/gi)].map((match) => match[1].replace(/["`]/g, ""));
  for (const from of sql.matchAll(/\bfrom\s+([\s\S]*?)(?=\bwhere\b|\bgroup\s+by\b|\border\s+by\b|\bhaving\b|\bunion\b|$)/gi)) {
    for (const part of from[1].split(/,(?![^()]*\))/).slice(1)) {
      const table = part.trim().match(/^([\w.$"`]+)(?:\s+(?:as\s+)?[\w$]+)?/i)?.[1];
      if (table && !/^(?:select|join|left|right|inner|outer|full|cross)$/i.test(table)) tables.push(table.replace(/["`]/g, ""));
    }
  }
  return tables;
}

const SQL_ALIAS_STOP = new Set(["where", "left", "right", "inner", "outer", "full", "cross", "join", "on", "group", "order", "having", "union", "limit", "offset", "connect", "start"]);

function extractSqlRelations(sql, context) {
  const aliases = new Map();
  const addAlias = (tableValue, aliasValue = "") => {
    const table = String(tableValue || "").replace(/["`]/g, "");
    if (!table || table.startsWith("(")) return;
    const simple = table.split(".").at(-1);
    const alias = SQL_ALIAS_STOP.has(String(aliasValue).toLowerCase()) ? "" : String(aliasValue || "");
    aliases.set(simple.toLowerCase(), table);
    aliases.set(table.toLowerCase(), table);
    if (alias) aliases.set(alias.toLowerCase(), table);
  };
  for (const match of sql.matchAll(/\b(?:from|join)\s+([\w.$"`]+)(?:\s+(?:as\s+)?([\w$]+))?/gi)) addAlias(match[1], match[2]);
  for (const from of sql.matchAll(/\bfrom\s+([\s\S]*?)(?=\bwhere\b|\bgroup\s+by\b|\border\s+by\b|\bhaving\b|\bunion\b|$)/gi)) {
    for (const part of from[1].split(/,(?![^()]*\))/)) {
      const match = part.trim().match(/^([\w.$"`]+)(?:\s+(?:as\s+)?([\w$]+))?/i);
      if (match) addAlias(match[1], match[2]);
    }
  }
  const relations = [];
  for (const match of sql.matchAll(/\b([\w$]+)\.([\w$]+)\s*=\s*([\w$]+)\.([\w$]+)\b/gi)) {
    const fromTable = aliases.get(match[1].toLowerCase());
    const toTable = aliases.get(match[3].toLowerCase());
    if (!fromTable || !toTable) continue;
    const line = context.line + sql.slice(0, match.index).split(/\r?\n/).length - 1;
    relations.push({
      type: "query_join", from_table: fromTable, from_columns: [match[2]],
      to_table: toTable, to_columns: [match[4]], sql_id: context.sql_id,
      file: context.file, line, evidence: match[0].replace(/\s+/g, " ").trim(),
      origin: "deterministic-indexer", confidence: "MEDIUM",
    });
  }
  return relations;
}

function extractSql(text, rel, methods) {
  const atLine = lineIndex(text);
  const sqls = [];
  const usages = [];
  const relations = [];
  const mapper = /<(select|insert|update|delete)\b[^>]*\bid\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/\1>/gi;
  const namespace = text.match(/<mapper\b[^>]*namespace\s*=\s*["']([^"']+)["']/i)?.[1] || "";
  for (const match of text.matchAll(mapper)) {
    const id = namespace ? `${namespace}.${match[2]}` : match[2];
    sqls.push({ id, file: rel, line: atLine(match.index), type: match[1].toLowerCase(), tables: [...new Set(sqlTables(match[3]))], text_preview: match[3].replace(/\s+/g, " ").trim().slice(0, 240), origin: "deterministic-indexer", confidence: "HIGH" });
    relations.push(...extractSqlRelations(match[3], { sql_id: id, file: rel, line: atLine(match.index) }));
    if (namespace) usages.push({ sql_id: id, file: rel, line: atLine(match.index), method: id, evidence: "MyBatis mapper namespace + statement id", origin: "deterministic-indexer", confidence: "HIGH" });
  }
  const annotation = /@(Query|Select|Insert|Update|Delete)\s*\(\s*(["'])([\s\S]*?)\2\s*\)/gi;
  for (const match of text.matchAll(annotation)) {
    const keyword = match[3].trim().match(/^(select|insert|update|delete|create|alter|drop)/i)?.[1]?.toLowerCase();
    const type = ["create", "alter", "drop"].includes(keyword) ? "ddl" : keyword || match[1].toLowerCase().replace("query", "select");
    const id = `${rel}:${atLine(match.index)}`;
    sqls.push({ id, file: rel, line: atLine(match.index), type, tables: [...new Set(sqlTables(match[3]))], text_preview: match[3].replace(/\s+/g, " ").slice(0, 240), origin: "deterministic-indexer", confidence: "MEDIUM" });
    relations.push(...extractSqlRelations(match[3], { sql_id: id, file: rel, line: atLine(match.index) }));
  }
  const rawSql = /"((?:\\.|[^"\\]){8,1000})"|'((?:\\.|[^'\\]){8,1000})'|`((?:\\.|[^`\\]){8,1000})`/g;
  for (const match of text.matchAll(rawSql)) {
    const statement = match[1] ?? match[2] ?? match[3] ?? "";
    const normalized = statement.replace(/\\(?:r|n|t)/g, " ").replace(/\s+/g, " ").trim();
    const type = normalized.match(/^select\s+[\s\S]+?\s+from\s+[\w$`"[\].]+(?:\s|$)/i) ? "select"
      : normalized.match(/^insert\s+into\s+[\w$`"[\].]+(?:\s|\()/i) ? "insert"
      : normalized.match(/^update\s+[\w$`"[\].]+\s+set\s+/i) ? "update"
      : normalized.match(/^delete\s+from\s+[\w$`"[\].]+(?:\s|$)/i) ? "delete"
      : null;
    if (!type) continue;
    const id = `${rel}:${atLine(match.index)}:raw`;
    sqls.push({ id, file: rel, line: atLine(match.index), type, tables: [...new Set(sqlTables(statement))], text_preview: normalized.slice(0, 240), origin: "deterministic-indexer", confidence: "MEDIUM" });
    relations.push(...extractSqlRelations(statement, { sql_id: id, file: rel, line: atLine(match.index) }));
  }
  const usage = /\b(?:selectOne|selectList|insert|update|delete|queryForObject|queryForList)\s*\(\s*["']([^"']+)["']/g;
  for (const match of text.matchAll(usage)) usages.push({ sql_id: match[1], file: rel, line: atLine(match.index), method: nextMethod(methods, atLine(match.index))?.id || "unknown", origin: "deterministic-indexer", confidence: "HIGH" });
  return { sqls, usages, relations };
}

function extractTransactions(text, clean, rel, workspace, methods) {
  const atLine = lineIndex(text);
  const boundaries = [];
  const marker = /@Transactional(?:\(([^)]*)\))?|\b(?:session\.begin|\$transaction)\s*\(/g;
  for (const match of clean.matchAll(marker)) {
    const entry = nextMethod(methods, atLine(match.index));
    if (!entry) continue;
    const args = match[1] || "";
    boundaries.push({
      id: `${entry.id}@${entry.line}`, entry_method: entry.id, file: rel, line: atLine(match.index), marker: match[0].split("(")[0],
      ...(args.match(/propagation\s*=\s*(?:Propagation\.)?(\w+)/)?.[1] ? { propagation: args.match(/propagation\s*=\s*(?:Propagation\.)?(\w+)/)[1] } : {}),
      ...(args.match(/isolation\s*=\s*(?:Isolation\.)?(\w+)/)?.[1] ? { isolation: args.match(/isolation\s*=\s*(?:Isolation\.)?(\w+)/)[1] } : {}),
      methods_in_scope: [entry.id], external_io_calls: [], workspace: workspace.id, origin: "deterministic-indexer", confidence: "HIGH",
    });
  }
  return boundaries;
}

function extractExternalIo(text, clean, rel, workspace, methods) {
  const atLine = lineIndex(text);
  const communications = [];
  const patterns = [
    ["http", /\b(RestTemplate|WebClient|HttpClient|RestSharp|axios|fetch|httpx|requests)\b/g],
    ["kafka_producer", /\b(KafkaTemplate|KafkaProducer)\b/g],
    ["kafka_consumer", /@KafkaListener\s*\(([^)]*)\)/g],
    ["rabbit_consumer", /@RabbitListener\s*\(([^)]*)\)/g],
    ["file_io", /\b(FileInputStream|FileOutputStream|Files\.(?:read|write)|readFile|writeFile|open)\s*\(/g],
    ["redis", /\b(RedisTemplate|StringRedisTemplate|ioredis|redis\.createClient)\b/g],
    ["mail", /\b(JavaMailSender|smtplib|nodemailer)\b/g],
  ];
  for (const [type, regex] of patterns) {
    for (const match of clean.matchAll(regex)) {
      communications.push({ id: `${rel}:${atLine(match.index)}:${type}`, type, file: rel, line: atLine(match.index), method: nextMethod(methods, atLine(match.index))?.id || "", target: quotedValue(match[1]) || match[1] || "unknown", workspace: workspace.id, origin: "deterministic-indexer", confidence: "MEDIUM" });
    }
  }
  return communications;
}

function extractEnv(text, clean, rel, workspace) {
  const atLine = lineIndex(text);
  const profiles = [];
  const branches = [];
  const configName = basename(rel).match(/application-([^.]+)\.(?:yml|yaml|properties)$/)?.[1];
  if (configName) {
    profiles.push(configName);
    branches.push({ file: rel, line: 1, type: "config_file", marker: configName, workspace: workspace.id, origin: "deterministic-indexer", confidence: "HIGH" });
  }
  const patterns = [
    ["annotation", /@Profile\s*\(([^)]*)\)|@ConditionalOnProperty\s*\(([^)]*)\)/g],
    ["code_if", /\b(?:process\.env|os\.environ|getenv|Environment\.GetEnvironmentVariable|System\.getenv|import\.meta\.env)\b[^\n;]*/g],
  ];
  for (const [type, regex] of patterns) {
    for (const match of clean.matchAll(regex)) branches.push({ file: rel, line: atLine(match.index), type, marker: match[0].slice(0, 240), workspace: workspace.id, origin: "deterministic-indexer", confidence: "HIGH" });
  }
  return { profiles, branches };
}

function extractSchema(text, rel) {
  const tables = [];
  const create = /create\s+table\s+(?:if\s+not\s+exists\s+)?([\w."`]+)\s*\(([\s\S]*?)\)\s*;/gi;
  for (const match of text.matchAll(create)) {
    const columns = [];
    const primaryKey = [];
    const foreignKeys = [];
    for (const raw of match[2].split(/,(?![^()]*\))/)) {
      const line = raw.trim();
      const pk = line.match(/^primary\s+key\s*\(([^)]+)\)/i);
      if (pk) { primaryKey.push(...pk[1].split(",").map((v) => v.trim().replace(/["`]/g, ""))); continue; }
      const fk = line.match(/^(?:constraint\s+["`]?([\w$]+)["`]?\s+)?foreign\s+key\s*\(([^)]+)\)\s+references\s+([\w."`$]+)\s*\(([^)]+)\)/i);
      if (fk) {
        foreignKeys.push({
          name: fk[1] || "", columns: fk[2].split(",").map((value) => value.trim().replace(/["`]/g, "")),
          references_table: fk[3].replace(/["`]/g, ""), references_columns: fk[4].split(",").map((value) => value.trim().replace(/["`]/g, "")),
          origin: "deterministic-indexer", confidence: "HIGH",
        });
        continue;
      }
      if (/^(constraint|foreign|unique|check)\b/i.test(line)) continue;
      const column = line.match(/^["`]?([\w$]+)["`]?\s+([\w]+(?:\s*\([^)]*\))?)([\s\S]*)$/);
      if (!column) continue;
      const inlinePk = /primary\s+key/i.test(column[3]);
      if (inlinePk) primaryKey.push(column[1]);
      const inlineFk = column[3].match(/\breferences\s+([\w."`$]+)\s*\(([^)]+)\)/i);
      if (inlineFk) foreignKeys.push({
        name: "", columns: [column[1]], references_table: inlineFk[1].replace(/["`]/g, ""),
        references_columns: inlineFk[2].split(",").map((value) => value.trim().replace(/["`]/g, "")),
        origin: "deterministic-indexer", confidence: "HIGH",
      });
      columns.push({ name: column[1], type: column[2], nullable: !/not\s+null/i.test(column[3]), primary_key: inlinePk });
    }
    tables.push({ name: match[1].replace(/["`]/g, ""), columns, primary_key: [...new Set(primaryKey)], foreign_keys: foreignKeys, indexes: [], source_file: rel, origin: "deterministic-indexer", confidence: "MEDIUM" });
  }
  for (const match of text.matchAll(/create\s+(unique\s+)?index\s+(?:if\s+not\s+exists\s+)?["`]?([\w$]+)["`]?\s+on\s+([\w."`$]+)\s*\(([^)]+)\)/gi)) {
    const tableName = match[3].replace(/["`]/g, "");
    const table = tables.find((item) => item.name.toLowerCase() === tableName.toLowerCase() || item.name.split(".").at(-1).toLowerCase() === tableName.split(".").at(-1).toLowerCase());
    if (!table) continue;
    table.indexes.push({ name: match[2], columns: match[4].split(",").map((value) => value.trim().replace(/["`]/g, "").split(/\s+/)[0]), unique: Boolean(match[1]), origin: "deterministic-indexer", confidence: "HIGH" });
  }
  return tables;
}

function analyzeFile(file, root, config) {
  const text = readFileSync(file.full, "utf8");
  const ext = extname(file.rel).toLowerCase();
  const clean = stripComments(text, ext);
  const workspace = workspaceFor(file.rel, config);
  const symbolFacts = extractSymbols(text, clean, file.rel, workspace);
  return {
    rel: file.rel,
    mtime: file.stats.mtime.toISOString(),
    size: file.stats.size,
    symbols: symbolFacts.symbols,
    nodes: symbolFacts.nodes,
    callSites: symbolFacts.callSites,
    injects: symbolFacts.injects,
    bindings: extractBindings(text, clean, file.rel, workspace, symbolFacts.methods),
    fastApi: extractFastApiMeta(text, clean, file.rel),
    ...extractApi(text, clean, file.rel, workspace, symbolFacts.methods, symbolFacts.classes),
    ...extractSql(text, file.rel, symbolFacts.methods),
    boundaries: extractTransactions(text, clean, file.rel, workspace, symbolFacts.methods),
    communications: extractExternalIo(text, clean, file.rel, workspace, symbolFacts.methods),
    env: extractEnv(text, clean, file.rel, workspace),
    tables: ext === ".sql" ? extractSchema(text, file.rel) : [],
  };
}

function unique(items, key) {
  const seen = new Set();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function gitCommit(root) {
  try {
    return execFileSync("git", ["-C", root, "log", "-1", "--format=%H"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function pairConfig(root) {
  const path = join(root, "_workspace", "pair_config.md");
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const value = (name) => text.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]?.trim();
  return { partner_root: value("partner_root"), partner_api_contract: value("partner_api_contract") };
}

function aggregate(facts, options, config, generatedAt, sourceFileCount, latestMtime, complexity, coverage) {
  const symbols = unique(facts.flatMap((item) => item.symbols), (item) => item.id);
  const bindings = facts.flatMap((item) => item.bindings || []);
  const nodes = unique([...facts.flatMap((item) => item.nodes), ...bindings.map((item) => ({ id: `trigger:${item.trigger}`, type: "trigger", file: item.file, line: item.line, workspace: item.workspace, origin: "deterministic-indexer", confidence: "HIGH" }))], (item) => item.id);
  const callSites = facts.flatMap((item) => item.callSites);
  const injects = facts.flatMap((item) => item.injects);
  const nodeBySimple = new Map();
  for (const node of nodes) {
    const simple = node.id.split(".").at(-1);
    if (!nodeBySimple.has(simple)) nodeBySimple.set(simple, []);
    nodeBySimple.get(simple).push(node);
  }
  const edges = [];
  const unresolved = [];
  for (const binding of bindings) {
    const candidates = (nodeBySimple.get(binding.handler_name) || []).filter((item) => item.type !== "trigger");
    if (candidates.length === 1) edges.push({ from: `trigger:${binding.trigger}`, to: candidates[0].id, type: binding.type, file: binding.file, line: binding.line, workspace: binding.workspace, origin: "deterministic-indexer", confidence: "HIGH" });
    else unresolved.push({ kind: "unresolved_trigger", trigger: binding.trigger, handler_name: binding.handler_name, candidates: candidates.map((item) => item.id), file: binding.file, line: binding.line, workspace: binding.workspace });
  }
  for (const call of callSites) {
    let candidates = nodeBySimple.get(call.name) || [];
    if (call.qualifier) {
      const qualified = candidates.filter((item) => item.id.toLowerCase().includes(call.qualifier.toLowerCase()));
      if (qualified.length) candidates = qualified;
    }
    if (candidates.length === 1 && candidates[0].id !== call.caller) {
      edges.push({ from: call.caller, to: candidates[0].id, type: "call", file: call.file, line: call.line, workspace: call.workspace, origin: "deterministic-indexer", confidence: call.qualifier ? "HIGH" : "MEDIUM" });
    } else if (candidates.length > 1) {
      unresolved.push({ kind: "ambiguous_call", caller: call.caller, expression: `${call.qualifier ? `${call.qualifier}.` : ""}${call.name}(...)`, candidates: candidates.map((item) => item.id), file: call.file, line: call.line, workspace: call.workspace });
    }
  }
  for (const injection of injects) {
    const candidates = nodeBySimple.get(injection.targetName) || [];
    if (candidates.length === 1) edges.push({ from: injection.owner, to: candidates[0].id, type: "inject", file: injection.file, line: injection.line, workspace: injection.workspace, origin: "deterministic-indexer", confidence: "HIGH" });
    else if (candidates.length > 1) unresolved.push({ kind: "ambiguous_injection", from: injection.owner, target_name: injection.targetName, candidates: candidates.map((item) => item.id), file: injection.file, line: injection.line, workspace: injection.workspace });
  }

  let endpoints = unique(composeFastApiEndpoints(facts, facts.flatMap((item) => item.endpoints)), (item) => item.id);
  let consumers = unique(facts.flatMap((item) => item.consumers), (item) => item.id);
  const pair = pairConfig(options.root);
  if (pair?.partner_api_contract && existsSync(pair.partner_api_contract)) {
    const partner = readJson(pair.partner_api_contract, {});
    const externalize = (item) => ({ ...item, source: "external", external_repo_path: pair.partner_root, origin: item.origin || "deterministic-indexer" });
    endpoints = unique([...endpoints, ...(partner.endpoints || []).filter((item) => item.source !== "external").map(externalize)], (item) => item.id);
    consumers = unique([...consumers, ...(partner.consumers || []).filter((item) => item.source !== "external").map(externalize)], (item) => item.id);
  }
  const matches = [];
  const matchedEndpoints = new Set();
  const matchedConsumers = new Set();
  for (const endpoint of endpoints) {
    for (const consumer of consumers) {
      if (endpoint.prefix_resolved === false) continue;
      if (endpoint.method !== "ANY" && consumer.method !== endpoint.method) continue;
      if (endpoint.path_pattern !== consumer.path_pattern) continue;
      matches.push({ endpoint_id: endpoint.id, consumer_id: consumer.id, match_type: "path_pattern", confidence: "HIGH", shape_match: "UNKNOWN", origin: "deterministic-indexer" });
      matchedEndpoints.add(endpoint.id); matchedConsumers.add(consumer.id);
    }
  }
  const sqls = unique(facts.flatMap((item) => item.sqls), (item) => item.id);
  const usages = unique(facts.flatMap((item) => item.usages), (item) => `${item.sql_id}:${item.file}:${item.line}`);
  const sqlRelations = unique(facts.flatMap((item) => item.relations || []), (item) => `${item.from_table}:${item.from_columns?.join(",")}:${item.to_table}:${item.to_columns?.join(",")}:${item.file}:${item.line}`);
  const boundaries = unique(facts.flatMap((item) => item.boundaries), (item) => item.id);
  const communications = unique(facts.flatMap((item) => item.communications), (item) => item.id);
  const profiles = [...new Set(facts.flatMap((item) => item.env.profiles))];
  const branches = unique(facts.flatMap((item) => item.env.branches), (item) => `${item.file}:${item.line}:${item.marker}`);
  const tables = unique(facts.flatMap((item) => item.tables), (item) => item.name.toLowerCase());
  const foreignKeyRelations = tables.flatMap((table) => (table.foreign_keys || []).map((foreignKey) => ({
    type: "foreign_key", name: foreignKey.name || "", from_table: table.name, from_columns: foreignKey.columns || [],
    to_table: foreignKey.references_table, to_columns: foreignKey.references_columns || [],
    file: table.source_file, line: null, evidence: foreignKey.name || "DDL FOREIGN KEY",
    origin: foreignKey.origin || "deterministic-indexer", confidence: foreignKey.confidence || "HIGH",
  })));
  const schemaRelations = unique([...foreignKeyRelations, ...sqlRelations], (item) => `${item.type}:${item.from_table}:${item.from_columns?.join(",")}:${item.to_table}:${item.to_columns?.join(",")}:${item.file}:${item.line}`);
  const inDegree = new Map(nodes.map((item) => [item.id, 0]));
  for (const edge of edges) inDegree.set(edge.to, (inDegree.get(edge.to) || 0) + 1);
  const unusedMethods = options.tier === "Full"
    ? nodes.filter((item) => item.type === "method" && item.visibility !== "private" && (inDegree.get(item.id) || 0) === 0)
        .map((item) => ({ id: item.id, file: item.file, line: item.line, reason: "call graph in-degree=0; 동적·외부 호출 검토 필요", confidence: "LOW", origin: "deterministic-indexer" }))
    : [];
  const common = { generated_at: generatedAt, generator: "deterministic-indexer", version: INDEXER_VERSION, source_root: options.root, mode: options.mode };
  const globalMeta = {
    ...common, source_file_count: sourceFileCount, latest_source_commit: gitCommit(options.root), latest_source_mtime: latestMtime,
    tier: options.tier, indexes: [], init_layout: config.init_layout, include_paths: config.include_paths.map((item) => item || "."), workspace_mode: config.workspace_mode, workspaces: config.workspaces,
    unresolved_count: unresolved.length,
    complexity: {
      ...complexity,
      selected_tier: options.tier,
      selection: options.requestedTier === "Auto" ? "deterministic-auto" : "user-override",
    },
    adapter_coverage: coverage,
    analysis_budget: {
      initial_ai_calls_per_target: 2,
      targeted_retries_per_target: 1,
      unresolved_batch_size: 200,
      large_index_direct_read: false,
    },
  };
  const output = {
    symbols: { _meta: { ...common, node_count: symbols.length }, symbols },
    call_graph: { _meta: { ...common, node_count: nodes.length, edge_count: edges.length }, nodes, edges: unique(edges, (item) => `${item.from}:${item.to}:${item.type}`) },
  };
  if (sqls.length || usages.length) output.sql_usage = { _meta: common, sqls, usages };
  if (boundaries.length) output.transactions = { _meta: common, boundaries };
  if (communications.length) output.external_io = { _meta: common, communications };
  if (branches.length) output.env_branches = { _meta: common, profiles, branches };
  if (tables.length || schemaRelations.length) output.schema = { _meta: { ...common, relation_count: schemaRelations.length }, tables, relations: schemaRelations, views: [], procedures: [], functions: [], triggers: [] };
  const pairLinked = existsSync(join(options.root, "_workspace", "pair_config.md"));
  if (config.workspace_mode || pairLinked) output.api_contracts = {
    _meta: common, endpoints, consumers, matches,
    unmatched_endpoints: endpoints.filter((item) => !matchedEndpoints.has(item.id)).map((item) => item.id),
    unmatched_consumers: consumers.filter((item) => !matchedConsumers.has(item.id)).map((item) => item.id),
  };
  if (options.tier === "Full") output.dead_code = { _meta: common, unused_methods: unusedMethods, unused_sql_ids: [], unused_jsps: [] };
  globalMeta.indexes = Object.keys(output);
  return { output, globalMeta, unresolved };
}

function buildPatternCandidates(output) {
  const candidates = new Map();
  const symbols = output.symbols?.symbols || [];
  const localEndpoints = (output.api_contracts?.endpoints || []).filter((item) => item.source !== "external");
  const localConsumers = (output.api_contracts?.consumers || []).filter((item) => item.source !== "external");
  const add = (category, slug, reason, items) => {
    const evidence = [...new Set(items.map((item) => item?.file).filter(Boolean))];
    if (!evidence.length) return;
    const current = candidates.get(slug) || { category, slug, reasons: [], evidence_files: [] };
    if (!current.reasons.includes(reason)) current.reasons.push(reason);
    current.evidence_files = [...new Set([...current.evidence_files, ...evidence])].slice(0, 20);
    candidates.set(slug, current);
  };
  const matchingSymbols = (pattern) => symbols.filter((item) => pattern.test(`${item.id || ""} ${item.file || ""}`));
  const isTestFile = (file) => /(^|[\\/_.-])(?:test|tests|spec|specs|__tests__)(?:[\\/_.-]|$)|(?:Test|Tests|Spec|Specs)\.[A-Za-z0-9]+$/.test(file || "");
  const nonTestSymbols = symbols.filter((item) => !isTestFile(item.file));

  add("진입점 / Controller", "controller", "API endpoint 또는 controller/action/router/handler 식별자가 탐지됨", [
    ...localEndpoints,
    ...matchingSymbols(/(?:controller|action|router|handler|endpoint)/i),
  ]);
  add("Service / 업무 로직", "service", "service/use-case/facade 식별자 또는 트랜잭션 경계가 탐지됨", [
    ...(output.transactions?.boundaries || []),
    ...matchingSymbols(/(?:service|usecase|use_case|interactor|facade|application)/i),
  ]);
  add("DAO / Repository / Mapper", "data_access", "SQL 사용처 또는 DAO/repository/mapper 식별자가 탐지됨", [
    ...(output.sql_usage?.usages || []),
    ...(output.sql_usage?.sqls || []),
    ...matchingSymbols(/(?:dao|repository|repo\b|mapper|store|gateway)/i),
  ]);
  add("DTO / Entity / Model", "data_model", "DTO/entity/model/VO/request/response 식별자가 탐지됨", matchingSymbols(/(?:dto|entity|model|(?:^|[.$_/])vo(?:[.$_/]|$)|request|response|command)/i));
  add("프론트엔드 컴포넌트", "frontend_component", "Vue/React 계열 컴포넌트 파일이 탐지됨", nonTestSymbols.filter((item) => /\.(?:vue|jsx|tsx)$/i.test(item.file || "")));
  add("프론트엔드 API Client", "frontend_api_client", "로컬 API consumer 호출이 탐지됨", localConsumers);
  add("레거시 화면 / Client", "client", "JSP/ASP/HTML 화면 파일이 탐지됨", symbols.filter((item) => /\.(?:jsp|jspx|asp|aspx|html?|cshtml)$/i.test(item.file || "")));
  add("외부 연동 Client", "integration_client", "HTTP/message/file 외부 연동이 탐지됨", output.external_io?.communications || []);
  add("설정 / 환경 분기", "configuration", "환경별 설정 또는 실행 분기가 탐지됨", output.env_branches?.branches || []);
  add("테스트", "test", "test/spec 파일이 탐지됨", symbols.filter((item) => isTestFile(item.file)));

  if (!candidates.size && nonTestSymbols.length) {
    add("공통 코드", "common", "레이어 식별자는 없지만 반복 가능한 소스 심볼이 탐지됨", nonTestSymbols);
  }
  return [...candidates.values()].map((item) => ({
    ...item,
    signal_count: item.evidence_files.length,
  }));
}

function buildAnalysisInput(output, globalMeta, unresolved) {
  const count = (name, key) => Array.isArray(output[name]?.[key]) ? output[name][key].length : 0;
  const evidenceFiles = new Set();
  const collectFiles = (name, key) => {
    for (const item of output[name]?.[key] || []) if (item?.file) evidenceFiles.add(item.file);
  };
  for (const [name, key] of [
    ["symbols", "symbols"], ["call_graph", "edges"], ["sql_usage", "sqls"],
    ["transactions", "boundaries"], ["external_io", "communications"],
    ["env_branches", "branches"], ["api_contracts", "endpoints"], ["api_contracts", "consumers"],
  ]) collectFiles(name, key);
  const patternCandidates = buildPatternCandidates(output);
  return {
    version: 1,
    generated_at: globalMeta.generated_at,
    source_root: globalMeta.source_root,
    tier: globalMeta.tier,
    complexity: globalMeta.complexity,
    adapter_coverage: globalMeta.adapter_coverage,
    coverage: {
      source_file_count: globalMeta.source_file_count,
      indexed_files: globalMeta.indexes,
      unresolved_count: unresolved.length,
      evidence_file_count: evidenceFiles.size,
    },
    counts: {
      symbols: count("symbols", "symbols"),
      graph_nodes: count("call_graph", "nodes"),
      graph_edges: count("call_graph", "edges"),
      sqls: count("sql_usage", "sqls"),
      sql_usages: count("sql_usage", "usages"),
      db_relations: count("schema", "relations"),
      transactions: count("transactions", "boundaries"),
      external_io: count("external_io", "communications"),
      environment_branches: count("env_branches", "branches"),
      endpoints: count("api_contracts", "endpoints"),
      consumers: count("api_contracts", "consumers"),
      api_matches: count("api_contracts", "matches"),
      dead_code_candidates: count("dead_code", "unused_methods"),
    },
    pattern_candidates: {
      policy: "Standard/Full은 탐지 후보마다 Pattern Evidence와 별도 *_pattern.md를 남기고, Lite도 후보가 2개 이상이면 최소 2종을 남긴다.",
      detected_count: patternCandidates.length,
      categories: patternCandidates,
    },
    workspaces: globalMeta.workspaces,
    evidence: {
      representative_files: [...evidenceFiles].slice(0, 50),
      representative_files_truncated: Math.max(0, evidenceFiles.size - 50),
      indexes: globalMeta.indexes.map((name) => `_workspace/index/${name}.json`),
      unresolved: "_workspace/index/_unresolved.jsonl",
      query_tool: "scripts/query-index.mjs",
    },
    analyzer_contract: {
      full_source_rescan: false,
      process_all_unresolved: true,
      unresolved_batch_size: 200,
      require_file_line_evidence: true,
      require_module_coverage: true,
      require_pattern_candidate_coverage: true,
    },
  };
}

function validateOutput(name, value) {
  const required = {
    symbols: ["_meta", "symbols"], call_graph: ["_meta", "nodes", "edges"], sql_usage: ["_meta", "sqls", "usages"],
    transactions: ["_meta", "boundaries"], external_io: ["_meta", "communications"], env_branches: ["_meta", "branches"],
    schema: ["_meta", "tables"], api_contracts: ["_meta", "endpoints", "consumers", "matches", "unmatched_endpoints", "unmatched_consumers"],
    dead_code: ["_meta", "unused_methods", "unused_sql_ids", "unused_jsps"],
  }[name] || [];
  const missing = required.filter((key) => !(key in value));
  if (missing.length) throw new Error(`${name}.json 필수 필드 누락: ${missing.join(", ")}`);
}

export function buildIndex(options) {
  const root = resolve(options.root);
  const normalized = { ...options, root, requestedTier: options.tier || "Auto" };
  const existingPatchPath = join(root, "_workspace", "index", "_ai_patch.json");
  const preservePatch = options.mode === "incremental" && existsSync(existingPatchPath);
  const config = loadConfig(root, options.config);
  const files = listFiles(root, config.include_paths);
  const unsupportedFiles = discoverUnsupportedFiles(root, config.include_paths);
  const cacheDir = join(root, "_workspace", ".index-cache");
  const cacheFiles = join(cacheDir, "files");
  mkdirSync(cacheFiles, { recursive: true });
  let analyzed = 0;
  let reused = 0;
  const facts = [];
  const activeCache = new Set();
  for (const file of files) {
    const content = readFileSync(file.full);
    const hash = sha256(content);
    const cacheName = `${sha256(file.rel).slice(0, 24)}.json`;
    const cachePath = join(cacheFiles, cacheName);
    activeCache.add(cacheName);
    const cached = options.mode !== "init" ? readJson(cachePath) : null;
    if (cached?.version === INDEXER_VERSION && cached?.hash === hash && cached?.workspace_config_hash === sha256(JSON.stringify(config))) {
      facts.push(cached.facts); reused += 1; continue;
    }
    const result = analyzeFile(file, root, config);
    atomicJson(cachePath, { version: INDEXER_VERSION, hash, workspace_config_hash: sha256(JSON.stringify(config)), facts: result });
    facts.push(result); analyzed += 1;
  }
  for (const entry of readdirSync(cacheFiles)) if (entry.endsWith(".json") && !activeCache.has(entry)) rmSync(join(cacheFiles, entry));
  const generatedAt = new Date().toISOString();
  const latestMtime = files.length ? new Date(Math.max(...files.map((item) => item.stats.mtimeMs))).toISOString() : generatedAt;
  const complexity = calculateComplexity(facts, config, files.length);
  const coverage = adapterCoverage(facts, unsupportedFiles);
  normalized.tier = normalized.requestedTier === "Auto" ? complexity.recommended_tier : normalized.requestedTier;
  const { output, globalMeta, unresolved } = aggregate(facts, normalized, config, generatedAt, files.length, latestMtime, complexity, coverage);
  const indexDir = join(root, "_workspace", "index");
  mkdirSync(indexDir, { recursive: true });
  const managed = new Set(["symbols", "call_graph", "sql_usage", "transactions", "external_io", "env_branches", "schema", "api_contracts", "dead_code"]);
  for (const name of managed) {
    const path = join(indexDir, `${name}.json`);
    if (!output[name]) { if (existsSync(path)) rmSync(path); continue; }
    validateOutput(name, output[name]);
    atomicJson(path, output[name]);
  }
  atomicJson(join(indexDir, "_meta.json"), globalMeta);
  atomicJson(join(indexDir, "_analysis_input.json"), buildAnalysisInput(output, globalMeta, unresolved));
  writeFileSync(join(indexDir, "_unresolved.jsonl"), unresolved.map((item) => JSON.stringify(item)).join("\n") + (unresolved.length ? "\n" : ""), "utf8");
  const stalePatch = join(indexDir, "_ai_patch.json");
  if (preservePatch) applyAiPatch(root, stalePatch);
  else if (existsSync(stalePatch)) rmSync(stalePatch);
  atomicJson(join(cacheDir, "manifest.json"), { version: INDEXER_VERSION, generated_at: generatedAt, mode: options.mode, files: files.length, analyzed, reused });
  return { root, files: files.length, analyzed, reused, tier: normalized.tier, complexity, adapter_coverage: coverage, indexes: Object.keys(output), unresolved: unresolved.length };
}

export function applyAiPatch(rootArg, patchArg) {
  const root = resolve(rootArg);
  const patchPath = isAbsolute(patchArg) ? patchArg : join(root, patchArg);
  const patch = readJson(patchPath);
  if (!patch || patch.version !== 1 || !Array.isArray(patch.operations)) throw new Error("AI patch는 version: 1과 operations[]가 필요합니다.");
  const graphPath = join(root, "_workspace", "index", "call_graph.json");
  const graph = readJson(graphPath);
  if (!graph?.nodes || !Array.isArray(graph.edges)) throw new Error("call_graph.json이 없어 AI patch를 적용할 수 없습니다.");
  const nodeIds = new Set(graph.nodes.map((item) => item.id));
  const edgeKeys = new Set(graph.edges.map((item) => `${item.from}:${item.to}:${item.type}`));
  let applied = 0;
  let rejected = 0;
  for (const operation of patch.operations) {
    if (operation?.op !== "add_edge" || !operation.edge) { rejected += 1; continue; }
    const edge = operation.edge;
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to) || !new Set(["call", "inject", "inherit", "reflect"]).has(edge.type)) {
      rejected += 1; continue;
    }
    const key = `${edge.from}:${edge.to}:${edge.type}`;
    if (edgeKeys.has(key)) continue;
    graph.edges.push({
      from: edge.from, to: edge.to, type: edge.type,
      ...(edge.file ? { file: edge.file } : {}),
      ...(Number.isInteger(edge.line) ? { line: edge.line } : {}),
      ...(edge.workspace ? { workspace: edge.workspace } : {}),
      origin: "ai-enrichment", confidence: edge.confidence || "MEDIUM",
      ...(edge.evidence ? { evidence: edge.evidence } : {}),
    });
    edgeKeys.add(key); applied += 1;
  }
  graph._meta.edge_count = graph.edges.length;
  graph._meta.ai_enriched_at = new Date().toISOString();
  graph._meta.ai_patch_applied = applied;
  atomicJson(graphPath, graph);
  const metaPath = join(root, "_workspace", "index", "_meta.json");
  const meta = readJson(metaPath, {});
  meta.ai_enrichment = { applied_at: graph._meta.ai_enriched_at, applied, rejected, patch: slash(relative(root, patchPath)) };
  atomicJson(metaPath, meta);
  return { applied, rejected, edges: graph.edges.length };
}

function printHelp() {
  process.stdout.write(`AX-Harness deterministic indexer\n\n` +
    `node scripts/build-index.mjs --root <project> [--mode init|incremental|feature-scoped] [--tier Lite|Standard|Full] [--config <json>]\n` +
    `node scripts/build-index.mjs --root <project> --apply-ai-patch _workspace/index/_ai_patch.json\n`);
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { printHelp(); return 0; }
    const result = options.applyAiPatch ? applyAiPatch(options.root, options.applyAiPatch) : buildIndex(options);
    if (!options.quiet) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`인덱스 생성 실패: ${error.stack || error.message}\n`);
    return 1;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
if (isMain) process.exit(main());
