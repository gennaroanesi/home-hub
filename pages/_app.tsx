import type { AppProps } from "next/app";

import { HeroUIProvider } from "@heroui/system";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { ToastProvider } from "@heroui/toast";
import Router, { useRouter } from "next/router";
import { useEffect } from "react";

import "@/styles/globals.css";
import "@uiw/react-md-editor/markdown-editor.css";
import "@uiw/react-markdown-preview/markdown.css";

import { Amplify } from "aws-amplify";
import outputs from "@/amplify_outputs.json";
import { getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { CREATE_USAGE_EVENT, createUsageLogger, type UsageLogger } from "@/lib/usage";

// `ssr: true` makes Amplify store Cognito tokens in cookies instead of
// localStorage so server-side `runWithAmplifyServerContext` (used by
// withHomeUserAuth on pages/api/**) can read them.
Amplify.configure(outputs, { ssr: true });

// Page usage (/admin/usage): one event per page opened, sent in the
// background. Created on first use so it only exists in the browser.
let usage: UsageLogger | null = null;
function usageLogger(): UsageLogger {
  if (!usage) {
    const client = generateClient({ authMode: "userPool" });
    usage = createUsageLogger({
      platform: "WEB",
      getUsername: () => getCurrentUser().then((u) => u.username).catch(() => null),
      send: async (rows) => {
        await Promise.all(rows.map((input) => Promise.resolve(client.graphql({ query: CREATE_USAGE_EVENT, variables: { input } }) as Promise<unknown>).catch(() => null)));
      },
    });
  }
  return usage;
}

function App({ Component, pageProps }: AppProps) {
  const router = useRouter();

  useEffect(() => {
    const log = usageLogger();
    // The route pattern (/trips/[id]), read when the route has changed.
    const track = () => log.track(Router.pathname);
    track();
    Router.events.on("routeChangeComplete", track);
    const onHide = () => {
      if (document.visibilityState === "hidden") void log.flush();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      Router.events.off("routeChangeComplete", track);
      document.removeEventListener("visibilitychange", onHide);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <NextThemesProvider enableSystem={false}>
      <HeroUIProvider navigate={router.push}>
        <ToastProvider
          toastProps={{
            radius: "none",
          }}
        />
        <Component {...pageProps} />
      </HeroUIProvider>
    </NextThemesProvider>
  );
}

export default App;
