export type LocalSyncShell = 'posix' | 'windows';

function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function validateLocalSyncFolder(folder: string, shell: LocalSyncShell): void {
  if (!folder.trim()) throw new Error('Folder path cannot be blank.');
  if (folder.includes('\0') || /[\r\n]/.test(folder)) {
    throw new Error('Folder path cannot contain a newline or NUL byte.');
  }
  // Double quotes cannot occur in a valid Windows filename, and would also
  // break the outer `-Command "..."` boundary before PowerShell sees the
  // safely single-quoted -Folder value.
  if (shell === 'windows' && folder.includes('"')) {
    throw new Error('Windows folder path cannot contain a double quote.');
  }
}

/** Build a command for the user's native shell, never Sunny's remote Bash. */
export function buildLocalSyncAttachCommand(args: {
  origin: string;
  folder: string;
  grant: string;
  shell: LocalSyncShell;
}): string {
  validateLocalSyncFolder(args.folder, args.shell);
  if (args.shell === 'windows') {
    return (
      'powershell -ExecutionPolicy Bypass -Command "& ' +
      `([scriptblock]::Create((irm ${powershellQuote(`${args.origin}/serve.ps1`)}))) ` +
      `-Folder ${powershellQuote(args.folder)} -McpGrant ${powershellQuote(args.grant)}"`
    );
  }
  return (
    `curl -fsSL ${posixQuote(`${args.origin}/serve.sh`)} | sh -s -- ` +
    `${posixQuote(args.folder)} --mcp-grant ${posixQuote(args.grant)}`
  );
}
