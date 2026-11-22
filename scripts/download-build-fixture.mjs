import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const fixtureTargets = {
  ios: 'https://apps.apple.com/us/app/download-qa/id1234567890',
  android: 'https://downloads.example.test/android.apk',
  h5: 'https://downloads.example.test/web-app/',
};

// Build through the same site.json and locale inputs as a published website.
export async function buildDownloadFixture(targets = fixtureTargets) {
  const scratch = join(root, '.verify-tmp');
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'download-config-'));
  const dist = join(directory, 'dist');
  try {
    const source = process.env.NEXGRID_SITE_FIXTURE_DIR;
    const site = JSON.parse(await readFile(join(source || join(root, 'src/config'), 'site.json'), 'utf8'));
    site.downloads = Object.fromEntries(Object.entries(targets).map(([platform, url]) => [platform, { enabled: true, url }]));
    await writeFile(join(directory, 'site.json'), JSON.stringify(site));
    const i18n = source || join(root, 'src/i18n');
    for (const file of await readdir(i18n)) {
      if (/^[a-z]{2}\.json$/.test(file)) await copyFile(join(i18n, file), join(directory, file));
    }
    execFileSync(process.execPath, [join(root, 'node_modules/astro/bin/astro.mjs'), 'build', '--outDir', dist], {
      cwd: root, env: { ...process.env, NEXGRID_SITE_FIXTURE_DIR: directory }, stdio: 'inherit', windowsHide: true,
    });
    return { directory, dist };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) console.log((await buildDownloadFixture()).dist);
