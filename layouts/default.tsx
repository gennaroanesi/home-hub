import React from "react";

import { Head } from "./head";
import { Navbar } from "@/components/navbar";

export default function DefaultLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex flex-col h-dvh">
      <main className="container mx-auto max-w-full flex-grow">
        <Head />
        <Navbar />
        {children}
      </main>
    </div>
  );
}
