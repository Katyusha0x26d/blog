import { defineSiteConfig } from 'valaxy'

export default defineSiteConfig({
  url: 'https://katyusha.me/',
  lang: 'zh-CN',
  title: 'Katyusha Mindpalace',
  author: {
    name: 'Katyusha0x26d',
    avatar: 'https://static.katyusha.me/2025/12/f30e9702da611defbedf38282ea798dc.webp',
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
    enable: true,
    title: '让价值流向更远方',
    description: '这里的知识免费，但自由与生命无价。若你心存感激，请代我将这份力量传递给 维基媒体、自由软件基金会 或 联合国儿童基金会 等众多非营利组织。让知识、技术与爱，都开源给这个世界。',
  }
})
