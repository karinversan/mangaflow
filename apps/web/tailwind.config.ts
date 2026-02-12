import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0A0B0F",
        panel: "#171920",
        warm: "#FF7A1A",
        glow: "#FFD966"
      },
      boxShadow: {
        soft: "0 20px 50px rgba(0,0,0,0.4)"
      },
      backgroundImage: {
        ambient:
          "radial-gradient(circle at 15% 20%, rgba(255,122,26,0.35), transparent 35%), radial-gradient(circle at 85% 0%, rgba(255,217,102,0.2), transparent 30%), linear-gradient(130deg, #0A0B0F 0%, #11131A 55%, #171920 100%)"
      }
    }
  },
  plugins: []
};

export default config;
