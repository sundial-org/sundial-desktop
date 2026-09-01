/** Sentinel `projectId` the desktop's local (sidecar) workspaces send to the
 *  cloud AI editor routes (rewrite-variants, morph, factcheck, pangram-check,
 *  humanize, generate-image). No cloud project backs a local folder, so the
 *  routes skip project access checks for it and instead require a signed-in
 *  caller — they are the payer — and log with a NULL workspace_id.
 *  Client-safe: imported by both the routes and the local fetch emulation. */
export const LOCAL_AI_PROJECT_ID = 'local';
