// App navigation. Desktop (md+): a sticky left rail that collapses to
// icons only (choice remembered per browser). Mobile: a slim top bar
// whose menu button opens the same nav in a left drawer.
//
// Sections come from config/nav.ts — add pages there, not here.

import React, { useEffect, useState } from "react";
import NextLink from "next/link";
import { useRouter } from "next/router";
import { signOut } from "aws-amplify/auth";
import { Button } from "@heroui/button";
import { Drawer, DrawerContent, DrawerBody, Tooltip } from "@heroui/react";
import {
  FaBars,
  FaSignOutAlt,
  FaAngleDoubleLeft,
  FaAngleDoubleRight,
} from "react-icons/fa";

import {
  ACCOUNT_LINKS,
  NAV_SECTIONS,
  isNavActive,
  type NavLink,
} from "@/config/nav";
import { siteConfig } from "@/config/site";

const COLLAPSED_KEY = "homehub.sidebarCollapsed";

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(v: boolean) {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, v ? "1" : "0");
  } catch {
    // Private mode / blocked storage — just don't remember.
  }
}

export function Sidebar() {
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Read after mount so server and first client render agree.
  useEffect(() => setCollapsed(readCollapsed()), []);

  // Close the mobile drawer whenever navigation happens.
  useEffect(() => {
    const close = () => setDrawerOpen(false);
    router.events.on("routeChangeStart", close);
    return () => router.events.off("routeChangeStart", close);
  }, [router.events]);

  function toggleCollapsed() {
    setCollapsed((c) => {
      writeCollapsed(!c);
      return !c;
    });
  }

  async function handleSignOut() {
    await signOut();
    router.push("/login");
  }

  return (
    <>
      {/* ── Desktop rail ─────────────────────────────────────────── */}
      <aside
        className={`hidden md:flex sticky top-0 h-dvh shrink-0 flex-col border-r border-default-200 bg-default-50 transition-[width] duration-200 ${
          collapsed ? "w-16" : "w-60"
        }`}
      >
        <div
          className={`h-14 flex items-center shrink-0 ${
            collapsed ? "justify-center" : "px-4"
          }`}
        >
          <NextLink href="/" className="font-bold text-foreground truncate">
            {collapsed ? "HH" : siteConfig.name}
          </NextLink>
        </div>
        <NavContent
          pathname={router.pathname}
          collapsed={collapsed}
          onSignOut={handleSignOut}
        />
        <div
          className={`border-t border-default-200 p-2 shrink-0 flex ${
            collapsed ? "justify-center" : "justify-end"
          }`}
        >
          <Button
            isIconOnly
            size="sm"
            variant="light"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onPress={toggleCollapsed}
          >
            {collapsed ? <FaAngleDoubleRight /> : <FaAngleDoubleLeft />}
          </Button>
        </div>
      </aside>

      {/* ── Mobile top bar + drawer ──────────────────────────────── */}
      <header className="md:hidden sticky top-0 z-40 h-16 flex items-center gap-2 px-3 border-b border-default-200 bg-default-50">
        <Button
          isIconOnly
          variant="light"
          aria-label="Open navigation"
          onPress={() => setDrawerOpen(true)}
        >
          <FaBars />
        </Button>
        <NextLink href="/" className="font-bold text-foreground">
          {siteConfig.name}
        </NextLink>
      </header>
      <Drawer
        isOpen={drawerOpen}
        onOpenChange={setDrawerOpen}
        placement="left"
        size="xs"
        radius="none"
      >
        <DrawerContent>
          <DrawerBody className="p-0 flex flex-col">
            <div className="h-14 flex items-center px-4 shrink-0 font-bold">
              {siteConfig.name}
            </div>
            <NavContent
              pathname={router.pathname}
              collapsed={false}
              onSignOut={handleSignOut}
            />
          </DrawerBody>
        </DrawerContent>
      </Drawer>
    </>
  );
}

function NavContent({
  pathname,
  collapsed,
  onSignOut,
}: {
  pathname: string;
  collapsed: boolean;
  onSignOut: () => void;
}) {
  return (
    <nav className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {NAV_SECTIONS.map((section, i) => (
          <div key={section.label ?? i} className={i > 0 ? "mt-4" : ""}>
            {section.label &&
              (collapsed ? (
                <div className="mx-3 mb-2 border-t border-default-200" />
              ) : (
                <p className="px-3 mb-1 text-[11px] font-medium text-default-400 uppercase tracking-wider">
                  {section.label}
                </p>
              ))}
            {section.items.map((item) => (
              <NavItem
                key={item.href}
                item={item}
                active={isNavActive(item.href, pathname)}
                collapsed={collapsed}
              />
            ))}
          </div>
        ))}
      </div>

      <div className="border-t border-default-200 px-2 py-2 shrink-0">
        {ACCOUNT_LINKS.map((item) => (
          <NavItem
            key={item.href}
            item={item}
            active={isNavActive(item.href, pathname)}
            collapsed={collapsed}
          />
        ))}
        <Tooltip content="Sign out" placement="right" isDisabled={!collapsed}>
          <button
            type="button"
            onClick={onSignOut}
            className={`w-full flex items-center gap-3 rounded-md py-2 text-sm text-danger hover:bg-danger-50 ${
              collapsed ? "justify-center" : "px-3"
            }`}
          >
            <FaSignOutAlt className="shrink-0" />
            {!collapsed && <span>Sign out</span>}
          </button>
        </Tooltip>
      </div>
    </nav>
  );
}

function NavItem({
  item,
  active,
  collapsed,
}: {
  item: NavLink;
  active: boolean;
  collapsed: boolean;
}) {
  const Icon = item.icon;
  const base = `flex items-center gap-3 rounded-md py-2 text-sm ${
    collapsed ? "justify-center" : "px-3"
  }`;

  const inner = item.coming ? (
    <span className={`${base} text-default-300 cursor-default`}>
      <Icon className="shrink-0" />
      {!collapsed && (
        <span className="truncate">
          {item.name} <span className="text-xs">· soon</span>
        </span>
      )}
    </span>
  ) : (
    <NextLink
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={`${base} ${
        active
          ? "bg-primary-50 text-primary font-semibold"
          : "text-default-600 hover:bg-default-100 hover:text-foreground"
      }`}
    >
      <Icon className="shrink-0" />
      {!collapsed && <span className="truncate">{item.name}</span>}
    </NextLink>
  );

  return (
    <Tooltip content={item.name} placement="right" isDisabled={!collapsed}>
      <div>{inner}</div>
    </Tooltip>
  );
}
