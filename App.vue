<script lang="ts" setup>
import { onMounted } from "vue";

onMounted(() => {
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

  const commentContainer = document.querySelector(".comment");
  if (commentContainer) commentContainer.appendChild(giscus);
});
</script>

<template>
  <div />
</template>
