// Stack inside the More tab. Lets us push screens like /reminders
// while keeping the bottom tab bar visible — routes that lived at
// the root /reminders previously would hide the tabbar because they
// stacked on top of the entire (tabs) layout.

import { Stack } from "expo-router";

export default function MoreLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
