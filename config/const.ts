export const apiBase =
  process.env.NODE_ENV === "development"
    ? "http://localhost:3000"
    : "https://www.cristinegennaro.com";

console.log("apiBase: ", apiBase);
