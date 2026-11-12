import { defineConfig } from 'vite';

/**
 * 构建配置要点
 * - base: './' 让 dist 可直接放到任意静态目录 / 子路径打开
 * - manualChunks 把 three 单独打成 vendor，游戏代码热更新时不必重传引擎
 * - assetsInlineLimit: 0 保证贴图资源路径可预测，便于后期替换真实素材
 */
export default defineConfig({
  base: './',
  server: { host: '0.0.0.0', port: 5173 },
  preview: { host: '0.0.0.0', port: 4173 },
  build: {
    target: 'es2020',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
        },
      },
    },
  },
});
