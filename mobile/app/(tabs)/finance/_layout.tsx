// Stack inside the Finance tab: overview, then transactions, budget,
// scheduled, goals, accounts and net worth pushed on top with the tab
// bar still showing.

import { Stack } from "expo-router";

export default function FinanceLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
