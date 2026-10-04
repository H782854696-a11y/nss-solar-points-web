/** PM2 config for the V2 control center release managed by deploy-v2.sh. */
module.exports = {
  apps: [{
    name: 'solarpoints-v2',
    script: 'server.js',
    cwd: '/opt/solarpoints-v2/current',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production',
      PORT: '3001',
      SP_DATA_DIR: '/opt/solarpoints-v2/data',
    },
  }],
};
