"use client";

import React, { useState, useEffect } from "react";
import { getCurrentUser, fetchUserAttributes } from "aws-amplify/auth";
import { useRouter } from "next/router";
import { Button } from "@heroui/button";
import { Card, CardBody, CardHeader } from "@heroui/card";
import { FaComments, FaTasks, FaFileInvoiceDollar, FaCalendarAlt, FaShoppingCart, FaImages, FaPlane } from "react-icons/fa";

import DefaultLayout from "@/layouts/default";

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

  const sections = [
    {
      title: "Agent Chat",
      description: "Ask the assistant to manage tasks, bills, and reminders",
      icon: <FaComments size={24} />,
      href: "/agent",
      color: "primary" as const,
    },
    {
      title: "Tasks",
      description: "View and manage household tasks",
      icon: <FaTasks size={24} />,
      href: "/tasks",
      color: "secondary" as const,
    },
    {
      title: "Shopping",
      description: "Shared shopping lists (Supermarket, Home Depot, …)",
      icon: <FaShoppingCart size={24} />,
      href: "/shopping",
      color: "success" as const,
    },
    {
      title: "Bills",
      description: "Track bills and payments",
      icon: <FaFileInvoiceDollar size={24} />,
      href: "/bills",
      color: "warning" as const,
      coming: true,
    },
    {
      title: "Calendar",
      description: "Shared calendar and events",
      icon: <FaCalendarAlt size={24} />,
      href: "/calendar",
      color: "success" as const,
    },
    {
      title: "Trips",
      description: "Plan trips, legs, and travel details",
      icon: <FaPlane size={24} />,
      href: "/trips",
      color: "secondary" as const,
    },
    {
      title: "Photos",
      description: "Browse and upload trip photos",
      icon: <FaImages size={24} />,
      href: "/photos",
      color: "primary" as const,
    },
  ];

  return (
    <DefaultLayout>
      <div className="max-w-2xl mx-auto px-4 py-10">
        <h1 className="text-2xl font-bold text-foreground">
          {fullName ? `Hi ${fullName}!` : "Home"}
        </h1>
        <p className="text-default-400 mt-1 mb-8">Your household hub</p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {sections.map((s) => (
            <Card
              key={s.title}
              isPressable={!s.coming}
              onPress={() => !s.coming && router.push(s.href)}
              className={s.coming ? "opacity-50" : ""}
            >
              <CardHeader className="flex gap-3 items-center">
                <div className={`text-${s.color}`}>{s.icon}</div>
                <div>
                  <p className="text-md font-semibold">{s.title}</p>
                  {s.coming && (
                    <span className="text-xs text-default-300">Coming soon</span>
                  )}
                </div>
              </CardHeader>
              <CardBody>
                <p className="text-sm text-default-500">{s.description}</p>
              </CardBody>
            </Card>
          ))}
        </div>
      </div>
    </DefaultLayout>
  );
}

