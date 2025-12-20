import { defineSiteConfig } from 'valaxy'

export default defineSiteConfig({
  url: 'https://katyusha.me/',
  lang: 'zh-CN',
  title: 'Katyusha Mindpalace',
  author: {
    name: 'Katyusha0x26d',
    avatar: 'https://static.katyusha.me/2025/12/9aa05b012bc313fb4db13f65ea8468d9.webp',
    status: {
      emoji: '🧑‍💻',
      message: 'busy...'
    }
  },
  subtitle: '微醺学习法',
  description: 'Katyusha0x26d\'s blog',
  favicon: '/favicon.png',
  social: [
    {
      name: 'RSS',
      link: '/atom.xml',
      icon: 'i-ri-rss-line',
      color: 'orange',
    },
    {
      name: 'GitHub',
      link: 'https://github.com/Katyusha0x26d',
      icon: 'i-ri-github-line',
      color: 'dodgerblue',
    },
    {
      name: 'Twitter',
      link: 'https://x.com/Katyusha0x26d',
      icon: 'i-ri-twitter-x-fill',
      color: 'black',
    },
    {
      name: 'E-Mail',
      link: 'mailto:katyusha0x26d@gmail.com',
      icon: 'i-ri-mail-line',
      color: 'pink',
    }
  ],

  comment: {
    enable: true,
  },

  statistics: {
    enable: true,
  },

  search: {
    enable: true,
    provider: 'fuse'
  },

  sponsor: {
    enable: false
  }
})
