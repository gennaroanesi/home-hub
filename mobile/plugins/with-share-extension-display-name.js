// Override the iOS Share Extension's CFBundleDisplayName.
//
// expo-share-intent's `iosShareExtensionName` controls the Xcode target
// name AND the bundle product name, but it can't be the same as the
// main app's target name (it'd silently skip target creation — bug we
// hit and worked around by naming the target "ShareExtension"). The
// trade-off was that iOS shows "ShareExtension" in the share sheet.
//
// This plugin patches the generated ShareExtension-Info.plist after
// expo-share-intent runs, swapping CFBundleDisplayName to the
// human-friendly name passed in. Must be listed AFTER expo-share-intent
// in app.json so the plist exists when we patch it.
//
// Usage in app.json:
//   ["./plugins/with-share-extension-display-name", "Home Hub"]

const { withXcodeProject } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");
const plist = require("@expo/plist");

const PLIST_RELATIVE_PATH = "ShareExtension/ShareExtension-Info.plist";

// withXcodeProject runs in the same phase as expo-share-intent's own
// xcodeproj mod (the one that writes the share extension files). Expo's
// mod compiler is LIFO — the LAST plugin registered runs FIRST — so
// to run AFTER expo-share-intent, this plugin must be declared
// BEFORE it in app.json's plugins array. We don't actually mutate the
// Xcode project here; we just hijack the phase to read/write the plist.
module.exports = function withShareExtensionDisplayName(config, displayName) {
  if (!displayName) {
    throw new Error(
      "with-share-extension-display-name: displayName is required"
    );
  }
  return withXcodeProject(config, async (cfg) => {
    const plistPath = path.join(
      cfg.modRequest.platformProjectRoot,
      PLIST_RELATIVE_PATH
    );
    if (!fs.existsSync(plistPath)) {
      console.warn(
        `[share-ext-display-name] ${plistPath} not found — is expo-share-intent listed BEFORE this plugin?`
      );
      return cfg;
    }
    const parsed = plist.default.parse(fs.readFileSync(plistPath, "utf8"));
    parsed.CFBundleDisplayName = displayName;
    fs.writeFileSync(plistPath, plist.default.build(parsed));
    return cfg;
  });
};
