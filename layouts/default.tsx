import React from "react";
import { useRouter } from "next/router";

import { Head } from "./head";
import { Sidebar } from "@/components/sidebar";

export default function DefaultLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  // No nav on the login screen — nothing behind it is reachable yet.
  const bare = router.pathname.startsWith("/login");

  return (
    <div className="md:flex min-h-dvh">
      <Head />
      {!bare && <Sidebar />}
      <main className="flex-1 min-w-0">{children}</main>
    </div>
  );
}
