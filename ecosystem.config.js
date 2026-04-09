module.exports = {
  apps: [
    {
      name:   "jarvis-v2",
      script: "dist/index.js",
      cwd:    "/opt/jarvis/jarvis-v2",
      watch:  false,
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
