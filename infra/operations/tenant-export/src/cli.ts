import { main } from './main.js';

const code = await main(process.argv.slice(2), process.env, (line) => {
  process.stdout.write(`${line}\n`);
});
process.exit(code);
