import "@/styles/globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Spotify Visual Playground",
  description:
    "An interactive visual music playground. Paste a playlist, click a track, watch it distort.",
  icons: {
    icon: [{ url: "/favicon.jpeg", type: "image/jpeg" }],
    apple: [{ url: "/favicon.jpeg", type: "image/jpeg" }],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
