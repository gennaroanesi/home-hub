import outputs from "@/amplify_outputs.json";

// Runtime models come from the connected backend, not the local Schema type.
// Local UI code can be ahead of the deployed Amplify schema during development.
export const wardrobeTryOnAvailable = "homeWardrobeTryOn" in outputs.data.model_introspection.models;
export const wardrobeTryOnSetupMessage = "Try-on previews need a backend update. Deploy the wardrobe Amplify changes, refresh amplify_outputs.json, and restart the local app.";
