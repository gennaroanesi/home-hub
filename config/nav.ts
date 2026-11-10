// Single source of truth for app navigation. The sidebar renders these
// sections; anything that needs "where can I go" (dashboard shortcuts,
// command palette later) should read from here rather than keep its
// own list.

import type { IconType } from "react-icons";
import {
  FaCalendarWeek,
  FaHome,
  FaComments,
  FaTasks,
  FaShoppingCart,
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
  FaBoxOpen,
  FaMap,
  FaTshirt,
  FaWallet,
  FaExchangeAlt,
  FaBalanceScale,
  FaClipboardCheck,
  FaCalendarCheck,
  FaBullseye,
  FaLayerGroup,
  FaUniversity,
  FaFilter,
  FaMoneyCheckAlt,
  FaFileInvoiceDollar,
  FaLandmark,
} from "react-icons/fa";

export interface NavLink {
  name: string;
  href: string;
  icon: IconType;
  coming?: boolean;
  // Active only on this exact path, not its children (/finance would
  // otherwise light up on every finance page).
  exact?: boolean;
}

export interface NavSection {
  // Omitted for the top, unlabeled section (Home, Janet, Week planner).
  label?: string;
  items: NavLink[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    items: [
      { name: "Home", href: "/", icon: FaHome },
      { name: "Janet", href: "/agent", icon: FaComments },
      { name: "Week planner", href: "/week", icon: FaCalendarWeek },
    ],
  },
  {
    label: "To-do",
    items: [
      { name: "Tasks", href: "/tasks", icon: FaTasks },
      { name: "Shopping", href: "/shopping", icon: FaShoppingCart },
      { name: "Checklists", href: "/checklists", icon: FaCheckSquare },
      { name: "Reminders", href: "/reminders", icon: FaBell },
    ],
  },
  {
    label: "Events",
    items: [
      { name: "Calendar", href: "/calendar", icon: FaCalendarAlt },
      { name: "Trips", href: "/trips", icon: FaPlane },
    ],
  },
  {
    label: "People",
    items: [
      { name: "Health", href: "/health", icon: FaHeartbeat },
      { name: "Household", href: "/admin/people", icon: FaUsers },
    ],
  },
  {
    label: "Home",
    items: [
      { name: "Map", href: "/map", icon: FaMap },
      { name: "Devices", href: "/devices", icon: FaLightbulb },
      { name: "Inventory", href: "/inventory", icon: FaBoxOpen },
      { name: "Wardrobe", href: "/wardrobe", icon: FaTshirt },
    ],
  },
  {
    label: "Finance",
    items: [
      { name: "Overview", href: "/finance", icon: FaWallet, exact: true },
      { name: "Transactions", href: "/finance/transactions", icon: FaExchangeAlt },
      { name: "Budget", href: "/finance/budget", icon: FaBalanceScale },
      { name: "Review", href: "/finance/review", icon: FaClipboardCheck },
      { name: "Scheduled", href: "/finance/scheduled", icon: FaCalendarCheck },
      { name: "Goals", href: "/finance/goals", icon: FaBullseye },
      { name: "Groups", href: "/finance/groups", icon: FaLayerGroup },
      { name: "Paychecks", href: "/finance/paychecks", icon: FaMoneyCheckAlt },
      { name: "Tax outlook", href: "/finance/tax-outlook", icon: FaLandmark },
      { name: "Invoices", href: "/finance/invoices", icon: FaFileInvoiceDollar },
      { name: "Accounts", href: "/finance/accounts", icon: FaUniversity },
      { name: "Rules", href: "/finance/rules", icon: FaFilter },
    ],
  },
  {
    label: "Files",
    items: [
      { name: "Documents", href: "/documents", icon: FaFileAlt },
      { name: "Notes", href: "/notes", icon: FaStickyNote },
      { name: "Attachments", href: "/attachments", icon: FaPaperclip },
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
];

// Pinned to the bottom of the sidebar, above Sign out.
export const ACCOUNT_LINKS: NavLink[] = [
  { name: "Settings", href: "/admin/settings", icon: FaCog },
  { name: "Calendar feeds", href: "/admin/calendar-feeds", icon: FaCalendarAlt },
  { name: "Security", href: "/security", icon: FaLock },
];

// Active when on the page itself or one of its children (/trips/[id]).
// "/" only matches exactly, or it'd light up everywhere.
export function isNavActive(href: string, pathname: string, exact = false): boolean {
  if (href === "/" || exact) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}
