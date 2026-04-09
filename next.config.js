/** @type {import('next').NextConfig} */

const { hostname } = require("os");
const { i18n } = require("./next-i18next.config");

const nextConfig = {
  reactStrictMode: true,
  i18n,
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "picsum.photos",
      },
      {
        protocol: "https",
        hostname: "s3.us-east-1.amazonaws.com",
      },
    ],
  },
};

module.exports = nextConfig;
