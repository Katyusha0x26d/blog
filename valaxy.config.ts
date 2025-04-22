import type { UserThemeConfig } from "valaxy-theme-yun";
import { defineValaxyConfig } from "valaxy";

// add icons what you will need
const safelist = ["i-ri-home-line"];

/**
 * User Config
 */
export default defineValaxyConfig<UserThemeConfig>({
  // site config see site.config.ts

  theme: "yun",

  themeConfig: {
    banner: {
      enable: true,
      title: "微醺学习法",
      cloud: {
        enable: true,
      },
    },

    pages: [
      {
        name: "项目橱窗",
        url: "/projects/",
        icon: "i-ri-terminal-box-line",
        color: "#FF8EB3",
      },
      {
        name: "友情链接",
        url: "/links/",
        icon: "i-ri-links-line",
        color: "dodgerblue",
      },
    ],

    footer: {
      since: 2025,
    },
  },

  unocss: { safelist },
});
