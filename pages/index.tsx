"use client";

import React, { useState, useEffect } from "react";
import { getCurrentUser, fetchUserAttributes } from "aws-amplify/auth";
import { useRouter } from "next/router";
import { Card, CardBody, CardHeader } from "@heroui/card";
import {
  FaComments,
  FaTasks,
  FaFileInvoiceDollar,
  FaCalendarAlt,
  FaShoppingCart,
  FaImages,
  FaPlane,
  FaFolder,
  FaLightbulb,
  FaFileAlt,
} from "react-icons/fa";

import DefaultLayout from "@/layouts/default";

interface DashboardCard {
  title: string;
  description: string;
  icon: React.ReactNode;
  href: string;
  coming?: boolean;
}

interface DashboardGroup {
  label: string;
  cards: DashboardCard[];
}

const GROUPS: DashboardGroup[] = [
  {
    label: "Janet",
    cards: [
      {
        title: "Agent Chat",
        description: "Ask Janet to manage tasks, bills, trips, and more",
        icon: <FaComments size={22} />,
        href: "/agent",
      },
    ],
  },
  {
    label: "Life",
    cards: [
      {
        title: "Tasks",
        description: "Household tasks and recurring chores",
        icon: <FaTasks size={22} />,
        href: "/tasks",
      },
      {
        title: "Shopping",
        description: "Shared lists (Supermarket, Home Depot, ...)",
        icon: <FaShoppingCart size={22} />,
        href: "/shopping",
      },
      {
        title: "Bills",
        description: "Track bills and payments",
        icon: <FaFileInvoiceDollar size={22} />,
        href: "/bills",
        coming: true,
      },
      {
        title: "Calendar",
        description: "Shared calendar and events",
        icon: <FaCalendarAlt size={22} />,
        href: "/calendar",
      },
      {
        title: "Trips",
        description: "Plan trips, legs, reservations, and travel details",
        icon: <FaPlane size={22} />,
        href: "/trips",
      },
    ],
  },
  {
    label: "Media",
    cards: [
      {
        title: "Photos",
        description: "Browse and upload all photos",
        icon: <FaImages size={22} />,
        href: "/photos",
      },
      {
        title: "Albums",
        description: "Curated photo collections",
        icon: <FaFolder size={22} />,
        href: "/albums",
      },
    ],
  },
  {
    label: "Home",
    cards: [
      {
        title: "Devices",
        description: "Home Assistant devices (thermostat, locks, cameras)",
        icon: <FaLightbulb size={22} />,
        href: "/devices",
      },
      {
        title: "Documents",
        description: "Secure document vault (passports, IDs, insurance)",
        icon: <FaFileAlt size={22} />,
        href: "/documents",
      },
    ],
  },
];

export default function HomeDashboard() {
  const router = useRouter();
  const [fullName, setFullName] = useState("");

  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth() {
    try {
      const { username } = await getCurrentUser();
      const attrs = await fetchUserAttributes();
      setFullName(attrs["custom:full_name"] ?? username);
    } catch {
      router.push("/login");
    }
  }

  return (
    <DefaultLayout>
      <div className="max-w-2xl mx-auto px-4 py-10">
        <h1 className="text-2xl font-bold text-foreground">
          {fullName ? `Hi ${fullName}!` : "Home"}
        </h1>
        <p className="text-default-400 mt-1 mb-8">Your household hub</p>

        <div className="flex flex-col gap-8">
          {GROUPS.map((group) => (
            <div key={group.label}>
              <h2 className="text-xs text-default-400 uppercase tracking-wider mb-3">
                {group.label}
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {group.cards.map((card) => (
                  <Card
                    key={card.title}
                    isPressable={!card.coming}
                    onPress={() => !card.coming && router.push(card.href)}
                    className={card.coming ? "opacity-50" : ""}
                  >
                    <CardHeader className="flex gap-3 items-center pb-0">
                      <div className="text-default-500">{card.icon}</div>
                      <div>
                        <p className="text-md font-semibold">{card.title}</p>
                        {card.coming && (
                          <span className="text-xs text-default-300">
                            Coming soon
                          </span>
                        )}
                      </div>
                    </CardHeader>
                    <CardBody className="pt-1">
                      <p className="text-sm text-default-500">
                        {card.description}
                      </p>
                    </CardBody>
                  </Card>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </DefaultLayout>
  );
}
