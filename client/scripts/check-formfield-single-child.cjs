#!/usr/bin/env node
/**
 * Regression guard for the Campus Profile Edit blank-page bug.
 *
 * Root cause: components/ui/FormField.jsx wraps a single form control and
 * calls `Children.only(children)`, which THROWS if it receives more than
 * one child. SettingsCampusesTab.jsx passed three sibling elements to one
 * <FormField>; the exception fired the instant the Campus Profile edit
 * modal rendered, and because nothing in the app had an ErrorBoundary at
 * the time (see components/ui/ErrorBoundary.jsx / layout/AppShell.jsx),
 * that one exception unmounted the entire React tree — a fully blank page,
 * not just a broken widget.
 *
 * The client has no test runner (no vitest/jest configured) to write a
 * real render test against, so this parses every JSX file with a real
 * parser (@babel/parser — an earlier regex-based version of this script
 * produced false positives on things like a lone {/* comment *\/} child
 * and ternaries) and fails if any <FormField> JSX element has more than
 * one meaningful child, using the same rules JSX itself uses to build the
 * children array: whitespace-only text and a JSX comment-only expression
 * container don't count; everything else — elements, `{expr}` containers
 * (regardless of what they evaluate to at runtime), and non-whitespace
 * text — does.
 *
 * Run with: node client/scripts/check-formfield-single-child.cjs
 * Exits non-zero (and prints every offending file:line) on any violation.
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("@babel/parser");
const traverseModule = require("@babel/traverse");
const traverse = traverseModule.default || traverseModule;

const SRC_DIR = path.join(__dirname, "..", "src");

function listJsxFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsxFiles(full));
    else if (entry.name.endsWith(".jsx")) out.push(full);
  }
  return out;
}

// Mirrors what Babel's JSX transform actually drops from the children
// array: whitespace-only JSXText, and a JSXExpressionContainer whose
// expression is a JSXEmptyExpression (i.e. a container holding only a
// comment, `{/* ... */}`, or literally empty `{}`).
function isMeaningfulChild(node) {
  if (node.type === "JSXText") return node.value.trim().length > 0;
  if (node.type === "JSXExpressionContainer") return node.expression.type !== "JSXEmptyExpression";
  return true; // elements, fragments, spreads — all real children
}

function checkFile(file, violations) {
  const code = fs.readFileSync(file, "utf8");
  let ast;
  try {
    ast = parse(code, { sourceType: "module", plugins: ["jsx"] });
  } catch (e) {
    violations.push({ file, line: 0, message: `parse error: ${e.message}` });
    return;
  }
  traverse(ast, {
    JSXElement(nodePath) {
      const opening = nodePath.node.openingElement;
      if (opening.name.type !== "JSXIdentifier" || opening.name.name !== "FormField") return;
      if (opening.selfClosing) return;
      const meaningful = nodePath.node.children.filter(isMeaningfulChild);
      if (meaningful.length > 1) {
        violations.push({ file, line: opening.loc.start.line, count: meaningful.length });
      }
    },
  });
}

const files = listJsxFiles(SRC_DIR);
const violations = [];
for (const f of files) checkFile(f, violations);

if (violations.length) {
  console.error("FormField single-child contract violated (React.Children.only will throw at render — see FormField.jsx):\n");
  for (const v of violations) {
    console.error(`  ${path.relative(SRC_DIR, v.file)}:${v.line}  ${v.message || `(${v.count} children)`}`);
  }
  console.error("\nWrap the children in one wrapping element (e.g. <div>) to fix.");
  process.exit(1);
} else {
  console.log(`OK — checked ${files.length} .jsx files, every <FormField> has exactly one child.`);
}
