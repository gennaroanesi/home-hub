// Bottom tab bar.
//   - Today    snapshot of today's events + tasks
//   - Janet    agent chat (Phase 2A)
//   - Week     the week planner (get_week_plan)
//   - Finance  overview, with transactions / budget / … stacked on top
//   - Calendar agenda + create (Phase 1D)
//   - More     launcher for everything else (tasks, home devices,
//              shopping, reminders, trips, documents, …)

import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: "#735f55",
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Today",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="sunny-outline" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="agent"
        options={{
          title: "Janet",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="chatbubbles-outline" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="week"
        options={{
          title: "Week",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="calendar-number-outline" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="finance"
        options={{
          title: "Finance",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="wallet-outline" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="calendar"
        options={{
          title: "Calendar",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="calendar-outline" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: "More",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="ellipsis-horizontal" color={color} size={size} />
          ),
        }}
      />
    </Tabs>
  );
}
