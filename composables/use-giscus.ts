import { useAppStore } from 'valaxy'
import { nextTick, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

const giscusClientSrc = 'https://giscus.app/client.js'

/**
 * @see https://giscus.app/
 */
export function useGiscus(options: {
  repo: string
  repoId: string
  mapping: 'pathname' | 'title'
  category: string
  categoryId: string
}) {
  const app = useAppStore()
  const route = useRoute()

  const giscusScriptRef = ref<HTMLScriptElement>()
  /**
   * mount giscus
   * @see https://giscus.app/
   */
  function createGiscusScript() {
    if (giscusScriptRef.value) {
      giscusScriptRef.value.remove()
    }

    giscusScriptRef.value = document.createElement('script')

    giscusScriptRef.value.src = giscusClientSrc
    giscusScriptRef.value.async = true
    giscusScriptRef.value.crossOrigin = 'anonymous'
    
    giscusScriptRef.value.setAttribute('data-repo', options.repo)
    giscusScriptRef.value.setAttribute('data-repo-id', options.repoId)
    giscusScriptRef.value.setAttribute('data-mapping', options.mapping)
    giscusScriptRef.value.setAttribute('data-category', options.category)
    giscusScriptRef.value.setAttribute('data-category-id', options.categoryId)

    giscusScriptRef.value.setAttribute('data-theme', app.isDark ? 'dark' : 'light')

    const commentContainer = document.querySelector('.comment')

    if (commentContainer) {
      // 如果旧元素存在，移除旧元素
      const giscusContainer = commentContainer.querySelector('.giscus')
      if (giscusContainer)
        commentContainer.removeChild(giscusContainer)

      commentContainer.appendChild(giscusScriptRef.value)
    }
  }

  // watch dark mode for theme
  watch(() => app.isDark, () => {
    createGiscusScript()
  })

  watch(
    () => route.path,
    () => {
      nextTick(() => {
        createGiscusScript()
      })
    },
  )

  onMounted(() => {
    createGiscusScript()
  })
}