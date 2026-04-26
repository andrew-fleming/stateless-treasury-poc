/** * Contract registry.
 *
 * Thin wrappers that load compiled contract artifacts and expose
 * the contract-specific config needed by the provider factory.
 */

import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CompiledContract } from '@midnight-ntwrk/compact-js';

import { projectRoot } from './config.js';
import type { ContractConfig } from './wallet.js';

// ——— Helpers ————————————————————————————————————————————

function artifactPath(contractName: string): string {
  return path.resolve(projectRoot, 'contracts', 'artifacts', contractName);
}

async function loadContract(
  name: string,
  artifactsDir: string,
): Promise<any> {
  const contractPath = path.join(artifactsDir, 'contract', 'index.js');
  const mod = await import(pathToFileURL(contractPath).href);
  return CompiledContract.make(name, mod.Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(artifactsDir),
  );
}

// ——— Token Contract ————————————————————————————————————

const tokenArtifacts = artifactPath('Token');

export const tokenConfig: ContractConfig = {
  privateStateId: 'mintState',
  privateStoreName: 'mint-state',
  zkConfigPath: tokenArtifacts,
};

export const tokenContract = await loadContract('token', tokenArtifacts);

// ——— Receive Contract ——————————————————————————————————

const receiveArtifacts = artifactPath('Receive');

export const receiveConfig: ContractConfig = {
  privateStateId: 'receiveState',
  privateStoreName: 'receive-state',
  zkConfigPath: receiveArtifacts,
};

export const receiveContract = await loadContract('receive', receiveArtifacts);

// ——— Lookup ————————————————————————————————————————————

export function getContractBundle(name: 'token' | 'receive') {
  if (name === 'token') {
    return { compiledContract: tokenContract, config: tokenConfig };
  }
  return { compiledContract: receiveContract, config: receiveConfig };
}
