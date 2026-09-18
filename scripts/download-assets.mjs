import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const photos = {
  chair: 'photo-1567538096630-e0c55bd6374c',
  camera: 'photo-1516035069371-29a1b244cc32',
  headphones: 'photo-1546435770-a3e426bf472b',
  lamp: 'photo-1507473885765-e6ed057f782c',
  bike: 'photo-1485965120184-e220f721d03e',
  coffee: 'photo-1606994697106-3cd69c410688',
  speaker: 'photo-1608043152269-423dbba4e7e1',
  console: 'photo-1606813907291-d86efa9b94db',
};
const destination = join(process.cwd(), 'public', 'products');
await mkdir(destination, { recursive: true });
await Promise.all(Object.entries(photos).map(async ([name, photo]) => {
  const url = `https://images.unsplash.com/${photo}?auto=format&fit=crop&w=700&h=520&q=85`;
  const response = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(join(destination, `${name}.jpg`), bytes);
  console.log(`${name}.jpg: ${bytes.length} bytes`);
}));
