export const SIDECAR_USAGE = `Sundial local sidecar

Usage:
  serve.mjs
  serve.mjs --share <folder> [--workspace <url|slug|id> | --mcp-grant <grant>] [--install | --no-install] [--print-token]
  serve.mjs --supervised [--print-token]
  serve.mjs --uninstall
  serve.mjs --help

Options:
  --share <folder>     Sync a local folder with Sundial.
  --workspace <ref>   Attach that folder to an existing workspace.
  --mcp-grant <grant> Attach through a short-lived hosted MCP handoff.
  --install           Keep the sync running after login (the share default).
  --no-install        Run the sync only in this process.
  --uninstall         Remove the installed login service.
  --supervised        Run as the installed login service.
  --print-token       Print the local API token after startup.
  -h, --help          Show this help without starting the sidecar.`;

export class SidecarCliError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SidecarCliError';
  }
}

/** Pure parsing boundary for direct `serve.mjs` runs. Add future authenticated
 *  attach options here; callers should consume only this returned object. */
export function parseSidecarArgs(args) {
  const parsed = {
    help: false,
    share: null,
    workspace: null,
    mcpGrant: null,
    install: false,
    noInstall: false,
    uninstall: false,
    supervised: false,
    printToken: false,
  };
  const seen = new Set();
  const once = (key, flag) => {
    if (seen.has(key)) throw new SidecarCliError(`${flag} may only be specified once`);
    seen.add(key);
  };
  const value = (index, flag) => {
    const next = args[index + 1];
    if (!next?.trim() || next.startsWith('-')) throw new SidecarCliError(`${flag} needs a value`);
    return next;
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '-h':
      case '--help':
        once('help', arg);
        parsed.help = true;
        break;
      case '--share':
        once('share', arg);
        parsed.share = value(index, arg);
        index += 1;
        break;
      case '--workspace':
        once('workspace', arg);
        parsed.workspace = value(index, arg).trim();
        index += 1;
        break;
      case '--mcp-grant':
        once('mcpGrant', arg);
        parsed.mcpGrant = value(index, arg);
        index += 1;
        break;
      case '--install':
        once('install', arg);
        parsed.install = true;
        break;
      case '--no-install':
        once('noInstall', arg);
        parsed.noInstall = true;
        break;
      case '--uninstall':
        once('uninstall', arg);
        parsed.uninstall = true;
        break;
      case '--supervised':
        once('supervised', arg);
        parsed.supervised = true;
        break;
      case '--print-token':
        once('printToken', arg);
        parsed.printToken = true;
        break;
      default:
        throw new SidecarCliError(
          arg.startsWith('-') ? `unknown option: ${arg}` : `unexpected argument: ${arg}`,
        );
    }
  }

  const selected = Object.entries(parsed).filter(([key, enabled]) => key !== 'help' && Boolean(enabled));
  if (parsed.help && selected.length) throw new SidecarCliError('--help cannot be combined with other options');
  if (parsed.install && parsed.noInstall) throw new SidecarCliError('--install and --no-install cannot be combined');
  if (parsed.workspace && !parsed.share) throw new SidecarCliError('--workspace requires --share <folder>');
  if (parsed.mcpGrant && !parsed.share) throw new SidecarCliError('--mcp-grant requires --share <folder>');
  if (parsed.workspace && parsed.mcpGrant) {
    throw new SidecarCliError('--workspace and --mcp-grant cannot be combined');
  }
  if ((parsed.install || parsed.noInstall) && !parsed.share) {
    throw new SidecarCliError(`${parsed.install ? '--install' : '--no-install'} requires --share <folder>`);
  }
  if (parsed.supervised && (parsed.share || parsed.install || parsed.noInstall || parsed.uninstall)) {
    throw new SidecarCliError('--supervised cannot be combined with share or service-management options');
  }
  if (parsed.uninstall && selected.some(([key]) => key !== 'uninstall')) {
    throw new SidecarCliError('--uninstall cannot be combined with other options');
  }
  return parsed;
}
