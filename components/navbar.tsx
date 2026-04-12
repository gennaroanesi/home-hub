"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/router";
import { getCurrentUser, signOut } from "aws-amplify/auth";

import {
  Navbar as NextUINavbar,
  NavbarContent,
  NavbarBrand,
  NavbarItem,
} from "@heroui/navbar";
import { Link } from "@heroui/link";
import NextLink from "next/link";
import { Button } from "@heroui/button";
import {
  DropdownItem,
  DropdownTrigger,
  Dropdown,
  DropdownMenu,
} from "@heroui/dropdown";
import { FaHome, FaComments, FaTasks, FaFileInvoiceDollar, FaCalendarAlt, FaShoppingCart, FaImages, FaPlane, FaFolder, FaLightbulb, FaUserCircle, FaFileAlt } from "react-icons/fa";

export const Navbar = () => {
  const router = useRouter();
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth() {
    try {
      const { userId } = await getCurrentUser();
      if (userId) setIsLoggedIn(true);
    } catch {
      setIsLoggedIn(false);
    }
  }

  const navItems = [
    { name: "Home", href: "/", icon: <FaHome /> },
    { name: "Agent", href: "/agent", icon: <FaComments /> },
    { name: "Tasks", href: "/tasks", icon: <FaTasks /> },
    { name: "Shopping", href: "/shopping", icon: <FaShoppingCart /> },
    { name: "Bills", href: "/bills", icon: <FaFileInvoiceDollar />, coming: true },
    { name: "Calendar", href: "/calendar", icon: <FaCalendarAlt /> },
    { name: "Trips", href: "/trips", icon: <FaPlane /> },
    { name: "Albums", href: "/albums", icon: <FaFolder /> },
    { name: "Photos", href: "/photos", icon: <FaImages /> },
    { name: "Devices", href: "/devices", icon: <FaLightbulb /> },
    { name: "Documents", href: "/documents", icon: <FaFileAlt /> },
  ];

  return (
    <NextUINavbar
      className="bg-default-50 border-b border-default-200"
      maxWidth="xl"
      position="sticky"
    >
      <NavbarContent justify="start">
        <NavbarBrand className="max-w-fit">
          <NextLink className="flex items-center gap-2 font-bold text-foreground" href="/">
            Home Hub
          </NextLink>
        </NavbarBrand>
      </NavbarContent>

      <NavbarContent className="hidden sm:flex gap-4" justify="center">
        {navItems.map((item) => (
          <NavbarItem key={item.href}>
            <Link
              as={NextLink}
              href={item.coming ? "#" : item.href}
              className={`flex items-center gap-1 text-sm ${
                router.pathname === item.href
                  ? "text-primary font-semibold"
                  : item.coming
                  ? "text-default-300 cursor-default"
                  : "text-default-600"
              }`}
            >
              {item.icon}
              {item.name}
            </Link>
          </NavbarItem>
        ))}
      </NavbarContent>

      <NavbarContent justify="end">
        {isLoggedIn ? (
          <Dropdown>
            <DropdownTrigger>
              <Button isIconOnly variant="light">
                <FaUserCircle size={20} />
              </Button>
            </DropdownTrigger>
            <DropdownMenu>
              <DropdownItem key="people" onPress={() => router.push("/admin/people")}>
                Manage people
              </DropdownItem>
              <DropdownItem key="faces" onPress={() => router.push("/admin/faces")}>
                Faces
              </DropdownItem>
              <DropdownItem key="security" onPress={() => router.push("/security")}>
                Security
              </DropdownItem>
              <DropdownItem key="signout" onPress={() => signOut().then(() => router.push("/login"))}>
                Sign out
              </DropdownItem>
            </DropdownMenu>
          </Dropdown>
        ) : (
          <NavbarItem>
            <Button as={NextLink} href="/login" size="sm" variant="flat">
              Login
            </Button>
          </NavbarItem>
        )}
      </NavbarContent>
    </NextUINavbar>
  );
};
