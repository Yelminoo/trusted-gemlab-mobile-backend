// pm2 process definition for production.
// --env-file=.env: there's no dotenv package here, and plain `node dist/index.js`
// doesn't auto-load .env the way systemd's EnvironmentFile or tsx's dev-mode
// loading do — Node 20.6+'s native --env-file flag fills that gap without
// adding a dependency.
module.exports = {
  apps: [
    {
      name: 'mobile-backend',
      script: 'dist/index.js',
      node_args: '--env-file=.env',
      instances: 1,
      autorestart: true,
      watch: false,
    },
  ],
};
