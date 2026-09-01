// The descriptions are training-conditioned: Claude's tool-calling behavior
// is fragile to paraphrase, so we ship the exact strings the Piebald
// system-prompt scrape captured. Do not "improve" these.

export const READ_DESCRIPTION = `Reads a file from the workspace. You can access any text file directly by using this tool.

Usage:
- The file_path parameter must be a workspace-relative path (no leading slash, no \`..\`).
- By default, reads up to ~256KB of the file's contents (UTF-8).
- You can optionally specify a 1-indexed \`offset\` (line to start at) and \`limit\` (max lines to read) to read a slice of the file. When a slice is requested, lines are returned in \`<line-number>\\t<content>\` format (cat -n style) so Edit/MultiEdit can target them unambiguously.
- Images (png/jpg/gif/webp) return a note, never pixels. The note says either that the image is attached for you to look at on a following step, or exactly why it cannot be shown and what to tell the user. Never guess an image's contents.
- Other binary files (PDF, HEIC, zip, docx, ...) return an error rather than empty content, and re-reading them will not help. A file stored as a blob can still be text (a very large file, or an extension the editor does not track) — read those with Bash.
- Tier 1: this hits the workspace document store directly (no sandbox needed). The store is the source of truth — live editors see your edits stream in.
`;

export const WRITE_DESCRIPTION = `Writes a file to the workspace.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- Prefer the Edit / MultiEdit tools for modifying existing files — they only send the diff. Only use Write to create new files or for complete rewrites.
- NEVER create documentation files (*.md) or README files unless explicitly requested.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.
- Tier 1: writes go through the document store and stream live to collaborators with you as the attributed author.
`;

export const EDIT_DESCRIPTION = `Performs exact string replacements in files.

Usage:
- You must use the Read tool at least once on the file before editing.
- When editing text from Read tool output, preserve the exact indentation as it appears in the file content. Never include any line-number prefix in old_string or new_string.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if old_string is not unique in the file. Either provide a larger string with more surrounding context to make it unique, or set \`replace_all=true\` to change every instance.
- For several related changes to one file, prefer MultiEdit so they land atomically.
- Tier 1: this is a single atomic replacement in the document store. Live editors see the change immediately with you as the attributed author.
`;

export const GREP_DESCRIPTION = `A powerful search tool for finding text across the workspace.

Usage:
- ALWAYS use this tool for search tasks. NEVER invoke \`grep\` or \`rg\` as a Bash command. This tool is optimized for the workspace document store.
- \`pattern\` is a POSIX regular expression: alternation (\`a|b\`), character classes, \`\\w\`/\`\\s\`, and word boundaries (\`\\b\`, \`\\m\`/\`\\y\`) all work. Lookahead/lookbehind are NOT supported — escalate to Bash \`rg\` (Tier 2) for those.
- \`path\` scopes the search to a file or subtree (default ".").
- \`-i\` makes the match case-insensitive.
- Returns matching lines as \`path:line: content\`, sorted by path, up to 200 matches.
- Tier 1: runs server-side against the materialized text mirror (always current with the doc store, no sandbox). For multi-line patterns, context lines (-A/-B/-C), file-type/glob filters, or binary/generated files, escalate to Bash with \`rg\` (Tier 2).
`;

// Verbatim Anthropic Claude Code Glob copy (the scraped wording the model is
// conditioned on), with the Sundial caveat kept OUTSIDE the verbatim block. The
// only omitted line is "use the Agent tool instead" — Sundial has no Agent tool,
// and pointing the model at a non-existent tool risks NoSuchTool errors. The
// prior "Lists files and folders" text was itself a non-Anthropic paraphrase of
// an `ls` tool; the implementation is now a real glob, sorted by mtime to match.
export const GLOB_DESCRIPTION = `- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns
- You have the capability to call multiple tools in a single response. It is always better to speculatively perform multiple searches as a batch that are potentially useful.

Sundial: Tier 1 — runs server-side against the workspace document store (no sandbox), recursively over the whole subtree. The optional \`path\` parameter scopes the search to a workspace-relative directory (default ".").
`;

export const BASH_DESCRIPTION = `Executes a given bash command in the workspace sandbox and returns its output.

IMPORTANT: Avoid using this tool to run \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\` commands. Instead, use the appropriate dedicated tool:
- Read files: Use Read (NOT cat/head/tail)
- Edit files: Use Edit / MultiEdit (NOT sed/awk)
- Write files: Use Write (NOT echo >/cat <<EOF)
- File search: Use Glob (NOT find/ls)
- Content search: Use Grep (NOT grep/rg as a shell command)

Use Bash for: running tests, installing packages, running scripts, git push, LaTeX compile, and anything else that legitimately needs a shell. The agent should explicitly pick the right command (e.g. \`pnpm test\`, \`pip install foo\`, \`tectonic main.tex\`) rather than expecting separate dedicated tools — there are none.

# Instructions
- Always quote file paths that contain spaces (e.g., cd "path with spaces/file.txt").
- You may specify an optional timeout in seconds (max 600 / 10 minutes). By default, the command times out after 30 seconds.
- Tier 2: Bash boots / reuses the per-actor sandbox on first call. The sandbox shares the workspace volume with other actors; your edits are diffed and applied to the document store on command exit, attributed to you.
`;
