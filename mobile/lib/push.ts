// Push-notification registration. Requests permission, retrieves the
// Expo push token, and upserts a homePushSubscription row keyed on
// (personId, deviceLabel). The expo-push-deliver Lambda (added in a
// later phase) consumes these rows to fan homeOutboundMessage rows
// out to native push alongside WhatsApp.

import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { getClient } from "./amplify";

export interface PushRegistration {
  expoPushToken: string;
  deviceLabel: string;
  subscriptionId: string;
}

/**
 * Request permission, fetch the Expo push token, and upsert the
 * homePushSubscription row for this device. Returns null if the user
 * denies permission or the device is a simulator (Expo refuses to
 * mint tokens on simulators).
 */
export async function registerForPushNotifications(
  personId: string
): Promise<PushRegistration | null> {
  if (!Device.isDevice) {
    // Simulators get APNs tokens but not Expo push tokens. Skip silently.
    return null;
  }

  const existing = await Notifications.getPermissionsAsync();
  let granted = existing.granted || existing.status === "granted";
  if (!granted) {
    const requested = await Notifications.requestPermissionsAsync();
    granted = requested.granted || requested.status === "granted";
  }
  if (!granted) return null;

  // Project ID is read from app.json (eas.projectId) once EAS is set up.
  // Until then, getExpoPushTokenAsync falls back to the slug-based path
  // which is fine for development.
  const tokenRes = await Notifications.getExpoPushTokenAsync();
  const expoPushToken = tokenRes.data;
  const deviceLabel = Device.modelName ?? Device.deviceName ?? "iPhone";
  const platform = Platform.OS === "ios" ? "IOS" : "ANDROID";

  const client = getClient();

  // Upsert by (personId, deviceLabel). If the same device shows up
  // again — e.g. after a token rotation — we update in place rather
  // than accumulating dead rows.
  const { data: existingRows } = await client.models.homePushSubscription.list({
    filter: {
      personId: { eq: personId },
      deviceLabel: { eq: deviceLabel },
    },
  });

  const now = new Date().toISOString();
  if (existingRows && existingRows.length > 0) {
    const row = existingRows[0];
    await client.models.homePushSubscription.update({
      id: row.id,
      expoPushToken,
      platform,
      lastSeenAt: now,
    });
    return { expoPushToken, deviceLabel, subscriptionId: row.id };
  }

  const { data: created, errors } = await client.models.homePushSubscription.create({
    personId,
    expoPushToken,
    deviceLabel,
    platform,
    lastSeenAt: now,
  });
  if (errors?.length) throw new Error(errors[0].message);
  return {
    expoPushToken,
    deviceLabel,
    subscriptionId: created!.id,
  };
}

/** iOS-friendly default behavior for foreground notifications. */
export function configureNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}
