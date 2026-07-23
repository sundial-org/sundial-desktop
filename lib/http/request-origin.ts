export function getRequestOrigin(request: Request): string {
  const url = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || "";
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "";
  const host = forwardedHost || request.headers.get("host")?.split(",")[0]?.trim() || "";

  if (!host) {
    return url.origin;
  }
  if (/^https?:\/\//i.test(host)) {
    return host.replace(/\/$/, "");
  }

  const proto = forwardedProto || url.protocol.replace(/:$/, "") || "http";
  return `${proto}://${host}`;
}
