const { app } = require('electron');

process.stdout.write('main-script-started\n');
app.whenReady().then(() => {
  process.stdout.write('app-ready\n');
  app.quit();
}).catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
