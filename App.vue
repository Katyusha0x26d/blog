<script lang="ts" setup>
import { onMounted, nextTick, watch } from "vue";
import { useRouter } from "vue-router";

const router = useRouter();

const initGiscus = async () => {
  await nextTick();

  const existingGiscus = document.querySelector('script[src="https://giscus.app/client.js"]');
  if (existingGiscus) {
    existingGiscus.remove();
  }

  const existingGiscusFrame = document.querySelector('.giscus');
  if (existingGiscusFrame) {
    existingGiscusFrame.remove();
  }

  let commentContainer = document.querySelector(".comment");

  if (commentContainer) {
    const giscus = document.createElement("script");
    giscus.src = "https://giscus.app/client.js";
    giscus.async = true;
    giscus.crossOrigin = "anonymous";

    giscus.setAttribute("data-repo", "Katyusha0x26d/blog");
    giscus.setAttribute("data-repo-id", "R_kgDOOdPhLA");
    giscus.setAttribute("data-category", "Ideas");
    giscus.setAttribute("data-category-id", "DIC_kwDOOdPhLM4CpUYs");
    giscus.setAttribute("data-mapping", "pathname");
    giscus.setAttribute("data-strict", "0");
    giscus.setAttribute("data-reactions-enabled", "1");
    giscus.setAttribute("data-emit-metadata", "1");
    giscus.setAttribute("data-input-position", "top");
    giscus.setAttribute("data-loading", "lazy");
    giscus.setAttribute("data-theme", "preferred_color_scheme");

    commentContainer.appendChild(giscus);
  }
};

onMounted(() => {
  setTimeout(initGiscus, 100);
});

watch(() => router.currentRoute.value.path, () => {
  setTimeout(initGiscus, 300);
});
</script>

<template>
  <div />
</template>
