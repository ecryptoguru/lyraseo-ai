import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
const manrope = localFont({
  src: "../../public/fonts/Manrope-variable.ttf",
  variable: "--font-manrope",
  display: "swap",
});
const inter = localFont({
  src: "../../public/fonts/Inter-variable.ttf",
  variable: "--font-inter",
  display: "swap",
});
export const metadata: Metadata = {
  title: {
    default: "LyraSEO AI — Turn evidence into your next move",
    template: "%s · LyraSEO AI",
  },
  description:
    "Understand your website’s search readiness. Review the evidence, prioritize useful fixes and measure AI visibility separately.",
  robots: { index: false, follow: false },
  icons: { icon: "/favicon.svg" },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${manrope.variable} ${inter.variable}`}>
        <script
          dangerouslySetInnerHTML={{
            __html: `(()=>{const value=document.cookie.split('; ').find(v=>v.startsWith('lyraseo-theme='))?.split('=')[1];const preference=['light','dark'].includes(value)?value:(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.dataset.theme=preference})()`,
          }}
        />
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
