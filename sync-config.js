/* 共享校正配置
   1. 部署 gzmetro_sync 的 Cloudflare Worker
   2. 把 Worker 地址填到 url（不要带结尾斜杠）
   3. 重新上传本文件到 GitHub Pages
   留空则只使用本机 localStorage，不同步。 */
window.GZ_SYNC = {
  url: 'https://gzmetro-sync.1711903835.workers.dev',
  pollMs: 30000,
};
