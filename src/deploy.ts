/** * Unified contract deployment script.
 *
 * Usage:
 *   npm run deploy -- token [seed]
 *   npm run deploy -- receive [seed]
 *
 * Deploys the specified contract, saves the address to deployments.json,
 * and optionally accepts a wallet seed (generates one if not provided).
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import * as Rx from 'rxjs';
import { Buffer } from 'buffer';

import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { toHex } from '@midnight-ntwrk/midnight-js-utils';
import { unshieldedToken } from '@midnight-ntwrk/ledger-v8';
import { generateRandomSeed } from '@midnight-ntwrk/wallet-sdk-hd';

import { saveDeployment, loadDeployments } from './config.js';
import { createWallet, createProviders } from './wallet.js';
import { getContractBundle } from './contracts.js';

// ——— Parse Args —————————————————————————————————————————

const contractName = process.argv[2] as 'token' | 'receive' | undefined;
const seedArg = process.argv[3];

if (!contractName || !['token', 'receive'].includes(contractName)) {
  console.error('Usage: npm run deploy -- <token|receive> [seed]');
  process.exit(1);
}

// ——— Main ———————————————————————————————————————————————

async function main() {
  const label = contractName === 'token' ? 'Token' : 'Receive';

  console.log(`\n--- Deploy ${label} Contract ---\n`);

  // 1. Wallet setup
  console.log('--- Step 1: Wallet ---\n');

  let seed: string;

  if (seedArg) {
    seed = seedArg;
    console.log('  Using provided seed.\n');
  } else {
    const rl = createInterface({ input: stdin, output: stdout });
    const choice = await rl.question(
      '  [1] Create new wallet\n  [2] Restore from seed\n  > ',
    );

    seed =
      choice.trim() === '2'
        ? await rl.question('\n  Enter your 64-character seed: ')
        : toHex(Buffer.from(generateRandomSeed()));

    if (choice.trim() !== '2') {
      console.log(`\n  SAVE THIS SEED (you will need it later):\n  ${seed}\n`);
    }
    rl.close();
  }

  console.log('  Creating wallet...');
  const walletCtx = await createWallet(seed);

  console.log('  Syncing with network...');
  const state = await Rx.firstValueFrom(
    walletCtx.wallet.state().pipe(
      Rx.throttleTime(5000),
      Rx.filter((s) => s.isSynced),
    ),
  );

  const address = walletCtx.unshieldedKeystore.getBech32Address();
  const balance = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
  console.log(`  Address: ${address}`);
  console.log(`  Balance: ${balance.toLocaleString()} tNight\n`);

  // 2. Fund wallet if needed
  if (balance === 0n) {
    console.log('--- Step 2: Fund Wallet ---\n');
    console.log('  Visit: https://faucet.preprod.midnight.network/');
    console.log(`  Address: ${address}\n`);
    console.log('  Waiting for funds...');

    await Rx.firstValueFrom(
      walletCtx.wallet.state().pipe(
        Rx.throttleTime(10000),
        Rx.filter((s) => s.isSynced),
        Rx.map((s) => s.unshielded.balances[unshieldedToken().raw] ?? 0n),
        Rx.filter((b) => b > 0n),
      ),
    );
    console.log('  Funds received!\n');
  }

  // 3. DUST setup
  console.log('--- Step 3: DUST Setup ---\n');
  const dustState = await Rx.firstValueFrom(
    walletCtx.wallet.state().pipe(Rx.filter((s) => s.isSynced)),
  );

  if (dustState.dust.balance(new Date()) === 0n) {
    const nightUtxos = dustState.unshielded.availableCoins.filter(
      (c: any) => !c.meta?.registeredForDustGeneration,
    );

    if (nightUtxos.length > 0) {
      console.log('  Registering for DUST generation...');
      const recipe = await walletCtx.wallet.registerNightUtxosForDustGeneration(
        nightUtxos,
        walletCtx.unshieldedKeystore.getPublicKey(),
        (payload) => walletCtx.unshieldedKeystore.signData(payload),
      );
      await walletCtx.wallet.submitTransaction(
        await walletCtx.wallet.finalizeRecipe(recipe),
      );
    }

    console.log('  Waiting for DUST tokens...');
    await Rx.firstValueFrom(
      walletCtx.wallet.state().pipe(
        Rx.throttleTime(5000),
        Rx.filter((s) => s.isSynced),
        Rx.filter((s) => s.dust.balance(new Date()) > 0n),
      ),
    );
  }
  console.log('  DUST ready.\n');

  // 4. Deploy
  console.log(`--- Step 4: Deploy ${label} ---\n`);

  const { compiledContract, config } = getContractBundle(contractName!);
  const providers = await createProviders(walletCtx, config);

  console.log('  Deploying (this may take 30-60 seconds)...\n');
  const deployed = await deployContract(providers, {
    compiledContract,
    privateStateId: config.privateStateId,
    initialPrivateState: {} as any,
    args: []
  });

  const contractAddress = deployed.deployTxData.public.contractAddress;

  // 5. Save
  saveDeployment(contractName!, contractAddress);

  console.log(`  Contract: ${contractAddress}`);
  console.log('  Saved to deployments.json\n');

  // Show current state
  const deployments = loadDeployments();
  if (deployments.token) console.log(`  token:   ${deployments.token.address}`);
  if (deployments.receive)
    console.log(`  receive: ${deployments.receive.address}`);
  console.log();

  await walletCtx.wallet.stop();
  console.log('--- Done ---\n');
}

main().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
