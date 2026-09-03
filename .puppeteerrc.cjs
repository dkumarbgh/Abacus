const { join } = require("path");

/**
 * Puppeteer (a dependency of whatsapp-web.js) downloads Chrome into
 * ~/.cache/puppeteer by default. On Render (and some other hosts), that
 * home-directory cache is populated during the BUILD step but doesn't
 * reliably carry over into the actual RUNTIME container - only files
 * inside this project directory do. The end result is the classic
 * "Could not find Chrome" error even though the build logs showed it
 * downloading successfully.
 *
 * Pointing the cache directory at a folder inside the project (instead of
 * the home directory) fixes this: Chrome gets downloaded here during
 * `npm install`, and since this folder is part of the deployed project,
 * it's actually present when the app runs.
 *
 * See: https://pptr.dev/troubleshooting#could-not-find-expected-browser-locally
 */
module.exports = {
    cacheDirectory: join(__dirname, ".cache", "puppeteer")
};
