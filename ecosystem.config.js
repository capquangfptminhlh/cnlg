// PM2: pm2 start ecosystem.config.js && pm2 save && pm2 startup
module.exports = {
  apps: [
    {
      name: 'hoangminh-store',
      script: 'server.js',
      instances: 1, // dữ liệu lưu file JSON + bộ đếm trong bộ nhớ → chỉ chạy 1 tiến trình
      autorestart: true,
      max_memory_restart: '512M',
      time: true,
      env: { NODE_ENV: 'production' }
    }
  ]
};
