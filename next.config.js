/** @type {import('next').NextConfig} */

const nextConfig = {
  reactStrictMode: true,
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
  // The @uiw markdown editor + preview ESM builds inline CSS imports
  // into their component JS files, which Pages Router otherwise
  // rejects with "Global CSS cannot be imported from within
  // node_modules". transpilePackages opts these into the same CSS
  // pipeline used for App Router and our own modules.
  transpilePackages: [
    "@uiw/react-md-editor",
    "@uiw/react-markdown-preview",
  ],
};

module.exports = nextConfig;
