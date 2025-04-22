import { defineAppSetup } from "valaxy";
import { createGtag } from 'vue-gtag'

export default defineAppSetup((ctx) => {
    const { app, router } = ctx
    
    app.use(createGtag({
        tagId: 'G-66WDDWF7H9',
        pageTracker: {
            router
        }
    }))
})