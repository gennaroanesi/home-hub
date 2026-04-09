import type { AppProps } from "next/app";

import { HeroUIProvider } from "@heroui/system";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { ToastProvider } from "@heroui/toast";
import { useRouter } from "next/router";

import "@/styles/globals.css";

import { Amplify } from "aws-amplify";
import outputs from "@/amplify_outputs.json";

Amplify.configure(outputs);

function App({ Component, pageProps }: AppProps) {
  const router = useRouter();

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
