// Single source of truth for app navigation. The sidebar renders these
// sections; anything that needs "where can I go" (dashboard shortcuts,
// command palette later) should read from here rather than keep its
// own list.

import type { IconType } from "react-icons";
import {
  FaHome,
  FaComments,
  FaTasks,
  FaShoppingCart,
  FaFileInvoiceDollar,
  FaCalendarAlt,
  FaPlane,
  FaCheckSquare,
  FaPaperclip,
  FaStickyNote,
  FaBell,
  FaHeartbeat,
  FaImages,
  FaFolder,
  FaSmile,
  FaLightbulb,
  FaFileAlt,
  FaUsers,
  FaCog,
  FaLock,
} from "react-icons/fa";

export interface NavLink {
  name: string;
  href: string;
  icon: IconType;
  coming?: boolean;
}

export interface NavSection {
  // Omitted for the top, unlabeled section (Home, Janet).
  label?: string;
  items: NavLink[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    items: [
      { name: "Home", href: "/", icon: FaHome },
      { name: "Janet", href: "/agent", icon: FaComments },
    ],
  },
  {
    label: "Life",
    items: [
      { name: "Tasks", href: "/tasks", icon: FaTasks },
      { name: "Calendar", href: "/calendar", icon: FaCalendarAlt },
      { name: "Shopping", href: "/shopping", icon: FaShoppingCart },
      { name: "Trips", href: "/trips", icon: FaPlane },
      { name: "Health", href: "/health", icon: FaHeartbeat },
      { name: "Checklists", href: "/checklists", icon: FaCheckSquare },
      { name: "Reminders", href: "/reminders", icon: FaBell },
      { name: "Notes", href: "/notes", icon: FaStickyNote },
      { name: "Attachments", href: "/attachments", icon: FaPaperclip },
      { name: "Bills", href: "/bills", icon: FaFileInvoiceDollar, coming: true },
    ],
  },
  {
    label: "Media",
    items: [
      { name: "Photos", href: "/photos", icon: FaImages },
      { name: "Albums", href: "/albums", icon: FaFolder },
      { name: "Faces", href: "/admin/faces", icon: FaSmile },
    ],
  },
  {
    label: "Home",
    items: [
      { name: "Devices", href: "/devices", icon: FaLightbulb },
      { name: "Documents", href: "/documents", icon: FaFileAlt },
    ],
  },
];

// Pinned to the bottom of the sidebar, above Sign out.
export const ACCOUNT_LINKS: NavLink[] = [
  { name: "People", href: "/admin/people", icon: FaUsers },
  { name: "Settings", href: "/admin/settings", icon: FaCog },
  { name: "Calendar feeds", href: "/admin/calendar-feeds", icon: FaCalendarAlt },
  { name: "Security", href: "/security", icon: FaLock },
];

// Active when on the page itself or one of its children (/trips/[id]).
// "/" only matches exactly, or it'd light up everywhere.
export function isNavActive(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
