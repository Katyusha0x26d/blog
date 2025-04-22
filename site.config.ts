import { defineSiteConfig } from "valaxy";

export default defineSiteConfig({
  url: "https://katyusha.me/",
  lang: "zh-CN",
  title: "Katyusha Mindpalace",
  subtitle: "微醺学习法",
  author: {
    name: "Katyusha0x26d",
    avatar: "/katyusha.jpg",
    status: {
      emoji: "💤",
      message: "tired",
    },
  },
  favicon: "/favicon.png",
  description: "谨以此纪录我平凡的一生",

  sponsor: {
    enable: false,
  },
  social: [
    {
      name: "RSS",
      link: "/atom.xml",
      icon: "i-ri-rss-line",
      color: "orange",
    },
    {
      name: "GitHub",
      link: "https://github.com/Katyusha0x26d",
      icon: "i-ri-github-line",
      color: "#8E71C1",
    },
    {
      name: "Twitter",
      link: "https://twitter.com/Katyusha0x26d",
      icon: "i-ri-twitter-x-line",
      color: "black",
    },
    {
      name: "E-Mail",
      link: "mailto:katyusha0x26d@gmail.com",
      icon: "i-ri-mail-line",
      color: "#1DA1F2",
    },
  ],

  search: {
    enable: true,
    type: "fuse",
  },

  fuse: {
    options: {
      keys: ["title", "tags", "categories", "excerpt", "content"],
    },
  },
  comment: {
    enable: true,
  },
});
