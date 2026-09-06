# 路况概览中转

这个 Worker 专门向高德获取矩形区域的交通态势数据，再把道路中心线和路况状态给网页。

它的作用是：地图缩小时，用单根红黄绿线仍然显示城区道路状况；放大后继续使用高德 JS 地图自带的精细路况图。

部署前：

1. 安装或使用 `npx wrangler` 登录 Cloudflare。
2. 在本目录执行 `npx wrangler secret put AMAP_TRAFFIC_KEY`，粘贴高德的“Web 服务”类型 Key。
3. 执行 `npx wrangler deploy`。
4. 将部署得到的 `https://...workers.dev` 地址填入根目录 `config.js` 的 `MINI_AMAP_TRAFFIC_API`。

高德 Key 只保存在 Cloudflare 密钥中，不能写入 GitHub 或 `config.js`。
