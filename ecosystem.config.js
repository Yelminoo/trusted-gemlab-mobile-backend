// pm2 process definition for production.
// --env-file=.env: there's no dotenv package here, and plain `node dist/index.js`
// doesn't auto-load .env the way systemd's EnvironmentFile or tsx's dev-mode
// loading do — Node 20.6+'s native --env-file flag fills that gap without
// adding a dependency.
// exec_mode: 'fork' — explicit on purpose. Setting `instances` at all makes
// pm2 default to cluster mode (Node's `cluster` module, multiple worker
// processes) even at instances:1, which crash-looped immediately in
// production (confirmed: the exact same script runs fine standalone via
// plain `node --env-file=.env dist/index.js`, only breaks under pm2's
// cluster mode). Fork mode is also just the correct choice here regardless —
// a single Fastify instance, no need for cluster's multi-core load balancing
// at this scale.
module.exports = {
  apps: [
    {
      name: 'mobile-backend',
      script: 'dist/index.js',
      node_args: '--env-file=.env',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
    },
  ],
};
