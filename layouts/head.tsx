import React from "react";
import NextHead from "next/head";

import { siteConfig } from "@/config/site";

export const Head = () => {
  return (
    <NextHead>
      <title>{siteConfig.name}</title>
      <meta key="title" content={siteConfig.name} property="og:title" />
      <meta content={siteConfig.description} property="og:description" />
      <meta content="/thumbnail.png" property="og:image" />
      <meta content={siteConfig.description} name="description" />
      <meta
        key="viewport"
        content="viewport-fit=cover, width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=0"
        name="viewport"
      />
      <link href="/favicon.png" rel="icon" />
      {/* Installable: Safari → Share → Add to Home Screen opens it full
          screen with the app icon, like the phone app (iPad gets the
          sidebar layout from md up). */}
      <link href="/manifest.webmanifest" rel="manifest" />
      <link href="/apple-touch-icon.png" rel="apple-touch-icon" />
      <meta content="yes" name="apple-mobile-web-app-capable" />
      <meta content="yes" name="mobile-web-app-capable" />
      <meta content="Home Hub" name="apple-mobile-web-app-title" />
      <meta content="default" name="apple-mobile-web-app-status-bar-style" />
      <meta content="#736359" name="theme-color" />
    </NextHead>
  );
};
