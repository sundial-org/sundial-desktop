/** Route param of the static desktop export's single exported shell for
 *  /local/<id> (desktop-ui). The sidecar serves that shell for every project
 *  path; the real id comes from the DOM URL at runtime. */
export const LOCAL_SHELL_PARAM = '_';

export function localProjectIdFromLocation(): string | null {
  if (typeof window === 'undefined') return null;
  const match = window.location.pathname.match(/^\/local\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}
