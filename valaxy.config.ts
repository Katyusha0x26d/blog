import type { UserThemeConfig } from 'valaxy-theme-yun'
import { defineValaxyConfig } from 'valaxy'

// add icons what you will need
const safelist = [
  'i-ri-home-line',
]

/**
 * User Config
 */
export default defineValaxyConfig<UserThemeConfig>({
  // site config see site.config.ts

  theme: 'yun',

  themeConfig: {
    banner: {
      enable: true,
      title: '微醺学习法',
    },

    pages: [
      {
        name: '友情链接',
        url: '/links/',
        icon: 'i-ri-genderless-line',
        color: 'dodgerblue',
      },
      {
        name: '项目橱窗',
        url: '/projects/',
        icon: 'i-ri-folder-check-line',
        color: 'pink'
      }
    ],

    footer: {
      since: 2024
    },
  },

  unocss: { safelist },
})
