// Metro defaults to watching only files inside mobile/. Our app imports
// `../../amplify_outputs.json` (and uses `import type` for the
// generated `Schema` from `amplify/data/resource.ts`) so the bundler
// has to be told it can serve files from the repo root too.
//
// We deliberately don't touch nodeModulesPaths — mobile has its own
// node_modules with RN-compatible deps; the root has Next.js-only
// packages we don't want Metro resolving. Hierarchical lookup is left
// on so transitive deps in mobile/node_modules still resolve normally.

const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "..");

const config = getDefaultConfig(projectRoot);
config.watchFolders = [workspaceRoot];

module.exports = config;
