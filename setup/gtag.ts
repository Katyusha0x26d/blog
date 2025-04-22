import type { UserModule } from 'valaxy'
import VueGtag, { trackRouter } from 'vue-gtag-next'

export const install: UserModule = ({ isClient, app, router }) => {
  if (isClient) {
    app.use(VueGtag, {
      property: { id: 'G-WM31YLS1JZ' },
    })

    trackRouter(router)
  }
}