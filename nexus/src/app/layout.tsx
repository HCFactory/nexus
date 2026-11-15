import type { Metadata } from "next";
import { ThemeProvider } from "next-themes";
import "./globals.css";
import { APP_NAME, APP_DESCRIPTION } from "@/lib/constants";

export const metadata: Metadata = {
  title: APP_NAME,
  description: APP_DESCRIPTION,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans antialiased">
        <ThemeProvider
          // data-theme too: Glisse (liquid-glass buttons) reads it for light/dark.
          attribute={["class", "data-theme"]}
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
          value={{ light: "light", dark: "dark" }}
        >
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
