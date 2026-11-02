// Design export tooling; sharp is supplied by the workspace asset runtime.
const path = require('node:path');
const sharp = require('sharp');
const root = path.resolve(__dirname, '..');
(async () => {
  for (const name of ['logo-preview', 'lyraseo-light', 'lyraseo-light-aeo-geo', 'lyraseo-dark', 'lyraseo-dark-aeo-geo']) {
    await sharp(path.join(root, `${name}.svg`)).png().toFile(path.join(root, `${name}.png`));
  }
  for (const size of [16, 24, 32, 48, 180, 192, 256, 512]) {
    await sharp(path.join(root, 'lyraseo-favicon.svg'), { density: size * 72 / 64 })
      .resize(size, size).png().toFile(path.join(root, `icon-${size}.png`));
  }
  const small = await sharp(path.join(root, 'icon-16.png')).resize(160, 160, {kernel:'nearest'}).png().toBuffer();
  await sharp({create:{width:200,height:200,channels:4,background:'#FFFFFF'}})
    .composite([{input:small,left:20,top:20}]).png().toFile(path.join(root,'source','icon-16-inspection.png'));
  console.log('Rendered logo preview, transparent lockups and eight icon sizes.');
})().catch(error => { console.error(error); process.exitCode = 1; });
