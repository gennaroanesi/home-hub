import { heroui } from "@heroui/theme";

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./layouts/**/*.{js,ts,jsx,tsx,mdx}",
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./node_modules/@heroui/theme/dist/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    fontFamily: {
      FrancieScript: "var(--font-francie-script)",
      CaslonPro: "adobe-caslon-pro",
    },
    extend: {
      backgrouncColor: "#f1f2eb",
      backgroundImage: {
        crisGennaro01: "url('../public/images/crisgennaro01.jpeg')",
        paperTexture:
          "url('../public/images/background/background_texture.webp')",
        paperTextureMobile:
          "url('../public/images/background/background_texture_mobile.webp')",
        cGwarm: "url('../public/cris_gennaro_pic_warm2.jpg')",
        gramadoValeQuilombo: "url('../public/gramado_vale_quilombo.jpg')",
      },
      colors: {
        primary: "#aca29c",
        secondary: "#4e5e53",
        text: "#aca29c",
        mainTextColor: "#735f55",
        alternateBackgroundColor: "#aca29c",
        lightBackgroundColor: "#f1f2eb",
        whiteishText: "#f1f2eb",
        darkGreen: "#1b2727",
        softGreen: "#4e5e53",
      },
      radius: {
        none: "0px",
      },
    },
  },

  darkMode: "class",
  plugins: [
    heroui({
      defaultTheme: "light",
      themes: {
        light: {
          colors: {
            primary: "#aca29c",
          },
        },
        dark: {
          backgrouncColor: "#f1f2eb",
          colors: {
            primary: "#aca29c",
          },
        },
      },
    }),
  ],
};
