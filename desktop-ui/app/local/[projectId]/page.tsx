import { LOCAL_SHELL_PARAM } from "@/lib/local/static-shell";
import WorkspacePage from "@/app/local/[projectId]/page";

// One exported shell serves every /local/<id>: the sidecar rewrites those
// paths to this page, and the layout reads the real id from the DOM URL.
export function generateStaticParams() {
  return [{ projectId: LOCAL_SHELL_PARAM }];
}
export const dynamicParams = false;

export default function LocalProjectShell() {
  return <WorkspacePage />;
}
