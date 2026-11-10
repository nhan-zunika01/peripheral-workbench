import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const root = new URL('../public/vendor/gsap/', import.meta.url);
mkdirSync(root, { recursive: true });
for (const file of ['gsap.min.js', 'Flip.min.js']) copyFileSync(new URL(`../node_modules/gsap/dist/${file}`, import.meta.url), new URL(file, root));
const { version, license } = JSON.parse(readFileSync(new URL('../node_modules/gsap/package.json', import.meta.url), 'utf8'));
writeFileSync(new URL('NOTICE.txt', root), `GSAP ${version} and Flip plugin\nCopyright GreenSock.\nLicense: ${license}\nhttps://gsap.com/standard-license/\nExact distribution bytes copied from the installed gsap npm package.\n`);
