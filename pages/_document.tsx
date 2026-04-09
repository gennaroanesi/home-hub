import React from "react";
import { Html, Head, Main, NextScript } from "next/document";

export default function Document() {
  return (
    <Html className="fade" lang="en">
      <Head />
      <link
        rel="preload"
        href="https://use.typekit.net/azs0lbm.css"
        as="style"
      />
      <link rel="stylesheet" href="https://use.typekit.net/azs0lbm.css" />
      <body className="min-h-screen bg-background font-sans antialiased">
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
