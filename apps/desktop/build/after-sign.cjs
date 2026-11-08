const { execFileSync } = require('node:child_process');

module.exports = async ({ appOutDir, packager }) => {
  if (packager.platform.name !== 'mac') return;
  if (!process.env.APPLE_ID || !process.env.APPLE_APP_SPECIFIC_PASSWORD || !process.env.APPLE_TEAM_ID) return;

  const appPath = `${appOutDir}/${packager.appInfo.productFilename}.app`;
  execFileSync('xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' });
  execFileSync('xcrun', ['stapler', 'validate', appPath], { stdio: 'inherit' });
};
