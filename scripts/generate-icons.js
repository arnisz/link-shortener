import sharp from 'sharp';
import { copyFile } from 'fs/promises';

await sharp('public/icon.png')
	.resize(192, 192)
	.toFile('public/icons/icon-192.png');

await sharp('public/icon.png')
	.resize(512, 512, { kernel: sharp.kernel.lanczos3 })
	.toFile('public/icons/icon-512.png');

console.log('Icons generated: public/icons/icon-192.png, public/icons/icon-512.png');
