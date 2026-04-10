import { defineFunction } from "@aws-amplify/backend";

export const faceDetector = defineFunction({
  name: "face-detector",
  timeoutSeconds: 120,
  memoryMB: 512,
  resourceGroupName: "data",
});
