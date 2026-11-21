import { createHash } from 'node:crypto';
import { createReadStream, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';

let stage = 'load';
try {
  const { chromium } = await import('playwright');
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const executable = resolve(cache, process.argv[2]);
  stage = 'launch';
  const server = await chromium.launchServer({ headless: true, host: '127.0.0.1', timeout: 10000 });
  let receipt;
  try {
    stage = 'executable';
    const { spawnfile, spawnargs } = server.process();
    if (!isAbsolute(spawnfile) || relative(executable, spawnfile) !== '') throw new Error();
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(spawnfile)) hash.update(chunk);

    stage = 'profile';
    const prefix = '--user-data-dir=';
    const profile = spawnargs.find(arg => arg.startsWith(prefix))?.slice(prefix.length);
    if (!profile || !isAbsolute(profile)) throw new Error();
    const profileRelative = relative(realpathSync.native(tmpdir()), realpathSync.native(profile));
    if (!profileRelative || profileRelative === '..' || profileRelative.startsWith(`..${sep}`) || isAbsolute(profileRelative)) throw new Error();

    stage = 'connect';
    const browser = await chromium.connect(server.wsEndpoint(), { timeout: 5000 });
    try {
      stage = 'DOM';
      const page = await browser.newPage();
      await page.setContent('<main id="probe">t00-chromium</main>', { timeout: 5000 });
      if (await page.locator('#probe').textContent({ timeout: 5000 }) !== 't00-chromium') throw new Error();
      receipt = { version: browser.version(), executable: relative(cache, spawnfile), sha256: hash.digest('hex'), profilePrivate: true, dom: true };
    } finally {
      await browser.close();
    }
  } finally {
    if (receipt) stage = 'close';
    await server.close();
  }
  console.log(JSON.stringify(receipt));
} catch {
  console.error(`Chromium preparation probe failed at ${stage}`);
  process.exitCode = 1;
}
