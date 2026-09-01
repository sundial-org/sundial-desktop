// Deep links that open a FRESH chat-assistant conversation with the whole
// workspace session prefilled as the USER's first message. This is how a
// browsing agent hands its human a one-click connect: URL-provenance guards
// trust "the exact URL from the user's message", so a new conversation seeded
// this way can open every URL in the payload itself — no echo ritual. Proven
// live against ChatGPT (chatgpt.com/?q= prefills the composer; the human
// presses Enter once).
//
// The payload deliberately contains ONLY read URLs. Mutations are excluded:
// suggest/comment URLs embed edit content unknowable at mint time, and a
// pre-baked /g/task would silently burn one of the anon identity's limited
// free Sunny runs on a stunt. The payload instead teaches the assistant the
// echo fallback for actions and the free-vs-metered split.

export function buildChatGptConnectLink(opts: {
  appUrl: string;
  ws: string;
  key: string;
  openPath: string;
}): string {
  const { appUrl, ws, key, openPath } = opts;
  const auth = `ws=${ws}&key=${key}`;
  const message = [
    `I'm working in my Sundial workspace ${ws}. These URLs are from me; open them all now, in order:`,
    '',
    `${appUrl}/g/tree?${auth}`,
    `${appUrl}/g/read?${auth}&path=${encodeURIComponent(openPath)}`,
    `${appUrl}/g/chat-log?${auth}`,
    `${appUrl}/g/diff?${auth}`,
    `${appUrl}/start`,
    '',
    'The last URL is the command reference for acting on the workspace. Then summarize the workspace state and help me work on it. You may re-open any of these URLs whenever you need fresh state. When you present file contents and your environment can write files, also save them as a raw HTML file and offer it as a download.',
    '',
    'To act on the workspace, show me the exact action URL in a code block and I will paste it back so you can open it. Suggestions and comments are free; /g/task starts a Sunny agent run and my free runs are limited, so save it for compiles and sandbox work.',
  ].join('\n');
  // encodeURIComponent leaves apostrophes raw, and React/HTML renderers
  // escape them to &#x27; — which, copied from raw HTML, truncates the q
  // param at the ampersand. Percent-encode them so the URL survives every
  // rendering verbatim.
  return `https://chatgpt.com/?q=${encodeURIComponent(message).replace(/'/g, '%27')}`;
}
