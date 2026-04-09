import { heroui } from "@heroui/theme/plugin";

export default heroui({
  defaultTheme: "light",
  themes: {
    light: {
      colors: {
        primary: "#aca29c",
      },
    },
    dark: {
      backgroundColor: "#f1f2eb",
      colors: {
        primary: "#aca29c",
      },
    },
  },
});
