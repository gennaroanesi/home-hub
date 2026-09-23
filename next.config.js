/** @type {import('next').NextConfig} */

const nextConfig = {
  reactStrictMode: true,
  // tests/next-build.test.ts builds into .next-test so running the test
  // suite doesn't clobber a running `npm run dev` (which uses .next).
  distDir: process.env.NEXT_DIST_DIR || ".next",
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
