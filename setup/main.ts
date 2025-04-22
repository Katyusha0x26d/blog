import { defineAppSetup } from "valaxy";
import { createGtag } from "vue-gtag";

export default defineAppSetup((ctx) => {
  const { app, router } = ctx;

  if (!import.meta.env.SSR) {
    app.use(
      createGtag({
        tagId: "G-66WDDWF7H9",
        pageTracker: {
          router,
        },
      })
    );
  }
});
