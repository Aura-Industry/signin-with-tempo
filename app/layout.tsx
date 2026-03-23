import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sign In With Tempo",
  description: "Passkey-only Tempo wallet demo with backup and agent keys.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
