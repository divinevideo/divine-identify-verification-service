import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    // Worktrees are separate checkouts of other branches; their tests aren't this checkout's.
    exclude: [...configDefaults.exclude, '.worktrees/**', '.claude/worktrees/**'],
  },
})
