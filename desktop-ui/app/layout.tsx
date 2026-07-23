import type { Metadata, Viewport } from "next";
import { ThemeApplier } from "@/components/theme-applier";
import { DesktopUpdateToast } from "@/components/desktop/update-toast";
import { DesktopZoomHandler } from "@/components/desktop/zoom";
import { StaticTicketPoller } from "@/components/desktop/static-ticket-poller";
import { WEBKIT_ENGINE_INLINE_SCRIPT } from "@/lib/engine";
import { THEME_INLINE_SCRIPT } from "@/lib/theme";
import "katex/dist/katex.min.css";
import "./desktop.css";

// Clean root layout for the static desktop build: no Clerk, no analytics, no
// cloud SDKs. Auth affordances run on lib/auth/optional-auth's signed-out
// defaults + the desktop browser handoff.

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#ffffff",
};

export const metadata: Metadata = { title: "Sundial" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans antialiased overflow-x-hidden">
        {/* Same pre-paint boot as the cloud layout: `js` class + theme. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `document.documentElement.classList.add('js');${WEBKIT_ENGINE_INLINE_SCRIPT}${THEME_INLINE_SCRIPT}`,
          }}
        />
        <ThemeApplier />
        <DesktopZoomHandler />
        <DesktopUpdateToast />
        <StaticTicketPoller />
        <main id="main-content">{children}</main>
      </body>
    </html>
  );
}
