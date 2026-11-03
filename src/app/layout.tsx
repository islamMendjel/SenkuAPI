import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SenkuAPI — Personal AI Gateway",
  description:
    "Personal AI gateway with pooled key routing, 3-tier token pacing, prompt caching and OpenAI compatibility.",
  applicationName: "SenkuAPI",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "SenkuAPI",
  },
  icons: {
    // The chatbot logo itself (welcome / sidebar / timeline all use
    // /senku-sparkle.png), plus apple-icon.png — the same mark on the
    // opaque #0d0d0d tile, because iOS home screens black-matte
    // transparent icons and would swallow the white sparkle.
    icon: "/senku-sparkle.png",
    apple: "/apple-icon.png",
  },
};

/** Mobile virtual keyboards resize the page instead of covering
 *  it — the floating input bar stays pinned above the keyboard on
 *  Android (iOS Safari already follows the visual viewport).
 *
 *  Run 27 (PWA): viewport-fit=cover lets the app paint under the
 *  notch/home-indicator so safe-area env() insets become real in
 *  standalone mode; maximum-scale=1 is the personal-gateway call —
 *  it stops iOS from zooming into inputs on focus (the tradeoff:
 *  pinch-zoom is disabled, accepted for this single-user app). */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: "#0d0d0d",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Next 16 emits only the modern `mobile-web-app-capable` for
            appleWebApp.capable. WebKit 11.3+ honors the manifest's
            display:"standalone" for home-screen launches, but the
            classic prefixed meta is still the belt-and-suspenders
            signal every iOS PWA guide carries — cheap, harmless, and
            it makes older Safari treat the home-screen app as
            full-screen too. */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
