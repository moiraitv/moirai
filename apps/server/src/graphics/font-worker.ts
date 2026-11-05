import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

const markup = await readFile(process.argv[2]!, 'utf8');
const image = await sharp({ text: { text: markup, font: 'Sans', width: 1920, rgba: true } })
	.timeout({ seconds: 1 }).png().toBuffer();
process.stdout.write(image);
