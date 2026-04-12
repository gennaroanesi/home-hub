"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/router";
import { getCurrentUser, signOut } from "aws-amplify/auth";

import {
  Navbar as NextUINavbar,
  NavbarContent,
  NavbarBrand,
  NavbarItem,
  NavbarMenuToggle,
  NavbarMenu,
  NavbarMenuItem,
} from "@heroui/navbar";
import { Link } from "@heroui/link";
import NextLink from "next/link";
import { Button } from "@heroui/button";
import {
  DropdownItem,
  DropdownTrigger,
  Dropdown,
  DropdownMenu,
  DropdownSection,
} from "@heroui/dropdown";
import {
  FaHome,
  FaComments,
  FaTasks,
  FaFileInvoiceDollar,
  FaCalendarAlt,
  FaShoppingCart,
  FaImages,
  FaPlane,
  FaFolder,
  FaLightbulb,
  FaUserCircle,
  FaFileAlt,
  FaLock,
  FaUsers,
  FaSmile,
  FaSignOutAlt,
  FaBars,
} from "react-icons/fa";

// ── Nav group definitions ──────────────────────────────────────────────
// Each group becomes a dropdown on desktop and a labeled section in the
// mobile hamburger menu. Standalone items (no children) render as plain
// links on desktop.

interface NavLink {
  name: string;
  href: string;
  icon: React.ReactNode;
  coming?: boolean;
}

interface NavGroup {
  label: string;
  icon: React.ReactNode;
  items: NavLink[];
}

type NavEntry = NavLink | NavGroup;

function isGroup(e: NavEntry): e is NavGroup {
  return "items" in e;
}

const NAV: NavEntry[] = [
  { name: "Home", href: "/", icon: <FaHome /> },
  { name: "Janet", href: "/agent", icon: <FaComments /> },
  {
    label: "Life",
    icon: <FaCalendarAlt />,
    items: [
      { name: "Tasks", href: "/tasks", icon: <FaTasks /> },
      { name: "Shopping", href: "/shopping", icon: <FaShoppingCart /> },
      { name: "Bills", href: "/bills", icon: <FaFileInvoiceDollar />, coming: true },
      { name: "Calendar", href: "/calendar", icon: <FaCalendarAlt /> },
      { name: "Trips", href: "/trips", icon: <FaPlane /> },
    ],
  },
  {
    label: "Media",
    icon: <FaImages />,
    items: [
      { name: "Photos", href: "/photos", icon: <FaImages /> },
      { name: "Albums", href: "/albums", icon: <FaFolder /> },
      { name: "Faces", href: "/admin/faces", icon: <FaSmile /> },
    ],
  },
  {
    label: "Home",
    icon: <FaLightbulb />,
    items: [
      { name: "Devices", href: "/devices", icon: <FaLightbulb /> },
      { name: "Documents", href: "/documents", icon: <FaFileAlt /> },
    ],
  },
];

// Flatten all links for mobile menu + active-state detection
const ALL_LINKS: NavLink[] = NAV.flatMap((e) =>
  isGroup(e) ? e.items : [e]
);

export const Navbar = () => {
  const router = useRouter();
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

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

  // Is the current route inside a group?
  function isGroupActive(group: NavGroup): boolean {
    return group.items.some((i) => router.pathname === i.href);
  }

  return (
    <NextUINavbar
      className="bg-default-50 border-b border-default-200"
      maxWidth="xl"
      position="sticky"
      isMenuOpen={menuOpen}
      onMenuOpenChange={setMenuOpen}
    >
      {/* ── Brand + mobile toggle ─────────────────────────────────── */}
      <NavbarContent justify="start">
        <NavbarMenuToggle
          aria-label="Toggle navigation"
          className="sm:hidden"
        />
        <NavbarBrand className="max-w-fit">
          <NextLink
            className="flex items-center gap-2 font-bold text-foreground"
            href="/"
          >
            Home Hub
          </NextLink>
        </NavbarBrand>
      </NavbarContent>

      {/* ── Desktop nav (hidden on mobile) ────────────────────────── */}
      <NavbarContent className="hidden sm:flex gap-3" justify="center">
        {NAV.map((entry) => {
          if (!isGroup(entry)) {
            // Standalone link
            return (
              <NavbarItem key={entry.href}>
                <Link
                  as={NextLink}
                  href={entry.coming ? "#" : entry.href}
                  className={`flex items-center gap-1 text-sm ${
                    router.pathname === entry.href
                      ? "text-primary font-semibold"
                      : entry.coming
                        ? "text-default-300 cursor-default"
                        : "text-default-600"
                  }`}
                >
                  {entry.icon}
                  {entry.name}
                </Link>
              </NavbarItem>
            );
          }

          // Grouped dropdown
          return (
            <Dropdown key={entry.label}>
              <NavbarItem>
                <DropdownTrigger>
                  <Button
                    variant="light"
                    size="sm"
                    className={`flex items-center gap-1 text-sm ${
                      isGroupActive(entry)
                        ? "text-primary font-semibold"
                        : "text-default-600"
                    }`}
                    startContent={entry.icon}
                  >
                    {entry.label}
                  </Button>
                </DropdownTrigger>
              </NavbarItem>
              <DropdownMenu aria-label={entry.label}>
                {entry.items.map((item) => (
                  <DropdownItem
                    key={item.href}
                    startContent={item.icon}
                    className={
                      router.pathname === item.href
                        ? "text-primary font-semibold"
                        : item.coming
                          ? "text-default-300"
                          : ""
                    }
                    onPress={() => !item.coming && router.push(item.href)}
                  >
                    {item.name}
                    {item.coming && (
                      <span className="text-xs text-default-300 ml-1">
                        soon
                      </span>
                    )}
                  </DropdownItem>
                ))}
              </DropdownMenu>
            </Dropdown>
          );
        })}
      </NavbarContent>

      {/* ── User menu (always visible) ────────────────────────────── */}
      <NavbarContent justify="end">
        {isLoggedIn ? (
          <Dropdown>
            <DropdownTrigger>
              <Button isIconOnly variant="light">
                <FaUserCircle size={20} />
              </Button>
            </DropdownTrigger>
            <DropdownMenu>
              <DropdownItem
                key="people"
                startContent={<FaUsers size={14} />}
                onPress={() => router.push("/admin/people")}
              >
                Manage people
              </DropdownItem>
              <DropdownItem
                key="security"
                startContent={<FaLock size={14} />}
                onPress={() => router.push("/security")}
              >
                Security
              </DropdownItem>
              <DropdownItem
                key="signout"
                startContent={<FaSignOutAlt size={14} />}
                className="text-danger"
                onPress={() =>
                  signOut().then(() => router.push("/login"))
                }
              >
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

      {/* ── Mobile hamburger menu ─────────────────────────────────── */}
      <NavbarMenu>
        {NAV.map((entry) => {
          if (!isGroup(entry)) {
            return (
              <NavbarMenuItem key={entry.href}>
                <Link
                  as={NextLink}
                  href={entry.coming ? "#" : entry.href}
                  className={`w-full flex items-center gap-2 py-2 ${
                    router.pathname === entry.href
                      ? "text-primary font-semibold"
                      : entry.coming
                        ? "text-default-300"
                        : "text-foreground"
                  }`}
                  onPress={() => setMenuOpen(false)}
                >
                  {entry.icon}
                  {entry.name}
                </Link>
              </NavbarMenuItem>
            );
          }

          return (
            <React.Fragment key={entry.label}>
              <NavbarMenuItem>
                <p className="text-xs text-default-400 uppercase tracking-wider pt-3 pb-1">
                  {entry.label}
                </p>
              </NavbarMenuItem>
              {entry.items.map((item) => (
                <NavbarMenuItem key={item.href}>
                  <Link
                    as={NextLink}
                    href={item.coming ? "#" : item.href}
                    className={`w-full flex items-center gap-2 py-2 pl-4 ${
                      router.pathname === item.href
                        ? "text-primary font-semibold"
                        : item.coming
                          ? "text-default-300"
                          : "text-foreground"
                    }`}
                    onPress={() => setMenuOpen(false)}
                  >
                    {item.icon}
                    {item.name}
                    {item.coming && (
                      <span className="text-xs text-default-300 ml-1">
                        soon
                      </span>
                    )}
                  </Link>
                </NavbarMenuItem>
              ))}
            </React.Fragment>
          );
        })}

        {/* Admin links in mobile menu too */}
        <NavbarMenuItem>
          <p className="text-xs text-default-400 uppercase tracking-wider pt-3 pb-1">
            Admin
          </p>
        </NavbarMenuItem>
        <NavbarMenuItem>
          <Link as={NextLink} href="/admin/people" className="w-full flex items-center gap-2 py-2 pl-4 text-foreground" onPress={() => setMenuOpen(false)}>
            <FaUsers size={14} /> Manage people
          </Link>
        </NavbarMenuItem>
        <NavbarMenuItem>
          <Link as={NextLink} href="/security" className="w-full flex items-center gap-2 py-2 pl-4 text-foreground" onPress={() => setMenuOpen(false)}>
            <FaLock size={14} /> Security
          </Link>
        </NavbarMenuItem>
      </NavbarMenu>
    </NextUINavbar>
  );
};
