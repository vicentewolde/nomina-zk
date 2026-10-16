// Uso: node export-vk.mjs <verification_key.json> <vk_soroban.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { vkToSoroban } from '../../app/src/zk/encode.js';

const [, , input, output] = process.argv;
const vk = JSON.parse(readFileSync(input, 'utf8'));
if (vk.protocol !== 'groth16' || vk.curve !== 'bn128') throw new Error('Se espera groth16 sobre bn128');
writeFileSync(output, JSON.stringify(vkToSoroban(vk), null, 2) + '\n');
console.log(`VK Soroban escrita en ${output} (${vk.IC.length} IC)`);
