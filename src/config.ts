/** * Network configuration and deployment address management.
 *
 * Network endpoints are configured here. Deployed contract addresses
 * are persisted to deployments.json and loaded at runtime.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

// ——— Network ————————————————————————————————————————————

setNetworkId('undeployed');

export const CONFIG = {
  indexer: 'http://localhost:8088/api/v4/graphql',
  indexerWS: 'ws://localhost:8088/api/v4/graphql/ws',
  node: 'ws://localhost:9944',
  proofServer: 'http://localhost:6300',
};

// ——— Paths ——————————————————————————————————————————————

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(__dirname, '..');
export const deploymentsPath = path.join(projectRoot, 'deployments.json');

// ——— Deployment Persistence ————————————————————————————

export interface Deployments {
  token?: { address: string; deployedAt: string };
  receive?: { address: string; deployedAt: string };
}

export function loadDeployments(): Deployments {
  if (!fs.existsSync(deploymentsPath)) return {};
  return JSON.parse(fs.readFileSync(deploymentsPath, 'utf-8'));
}

export function saveDeployment(
  contract: 'token' | 'receive',
  address: string,
): void {
  const deployments = loadDeployments();
  deployments[contract] = { address, deployedAt: new Date().toISOString() };
  fs.writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2));
}

export function requireAddress(contract: 'token' | 'receive'): string {
  const deployments = loadDeployments();
  const entry = deployments[contract];
  if (!entry) {
    console.error(
      `No ${contract} contract deployed. Run: npm run deploy -- ${contract}`,
    );
    process.exit(1);
  }
  return entry.address;
}
