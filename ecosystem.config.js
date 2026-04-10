module.exports = {
  apps: [
    {
      name:                 "jarvis-v2",
      script:               "dist/index.js",
      cwd:                  "/opt/jarvis/jarvis-v2",
      watch:                false,
      node_args:            "--max-old-space-size=512",
      max_memory_restart:   "400M",
      kill_timeout:         5000,
      listen_timeout:       10000,
      shutdown_with_message: true,
      env: {
        NODE_ENV: "production",
        PORT:     "8080",
      },
    },
    {
      name:          "jarvis-watchdog",
      script:        "server/watchdog/watchdog.js",
      cwd:           "/opt/jarvis/jarvis-v2",
      watch:         false,
      restart_delay: 5000,
    },
  ],
};
