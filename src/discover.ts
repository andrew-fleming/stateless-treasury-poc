/** * UTXO Discovery PoC — Full Round Trip
 * Mint -> Deposit -> Discover -> Spend
 *
 * Validates the stateless treasury model:
 * - No coin data stored on-chain
 * - Full UTXO discovery from standard indexer events
 * - QualifiedShieldedCoinInfo constructed from discovered data
 * - Protocol accepts discovered coin for spending
 *
 * Usage: npm run discover -- <wallet-seed>
 *
 * Requires both contracts deployed first:
 *   npm run deploy -- token <seed>
 *   npm run deploy -- receive <seed>
 */

import * as Rx from 'rxjs';
import * as crypto from 'node:crypto';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';

import { CONFIG, requireAddress } from './config.js';
import { createWallet, createProviders } from './wallet.js';
import { tokenContract, tokenConfig, receiveContract, receiveConfig } from './contracts.js';
import { computeCoinCommitment } from './commitment.js';
import { queryZswapEvents, discoverMtIndex } from './indexer.js';
import { toHex, fromHex } from '@midnight-ntwrk/compact-runtime';
import { encodeContractAddress } from '@midnight-ntwrk/ledger-v8';

// ——— Load Addresses from deployments.json ———————————————

const TOKEN_ADDRESS = requireAddress('token');
const RECEIVE_ADDRESS = requireAddress('receive');

// ——— Main ———————————————————————————————————————————————

async function main() {
  console.log('\n--- UTXO Discovery PoC — Full Round Trip ---');
  console.log('--- Mint -> Deposit -> Discover -> Spend ---\n');
  console.log(`  token:   ${TOKEN_ADDRESS}`);
  console.log(`  receive: ${RECEIVE_ADDRESS}\n`);

  const seed = process.argv[2];
  if (!seed) {
    console.error('Usage: npm run discover -- <wallet-seed>');
    process.exit(1);
  }

  // —— Step 1: Wallet ————————————————————————————————————

  console.log('--- Step 1: Wallet ---\n');
  console.log('  Creating wallet...');
  const walletCtx = await createWallet(seed);
  console.log('  Syncing...');
  await Rx.firstValueFrom(
    walletCtx.wallet.state().pipe(Rx.throttleTime(5000), Rx.filter((s) => s.isSynced)),
  );
  console.log('  Ready.\n');

  // —— Step 2: Join Contracts ————————————————————————————

  console.log('--- Step 2: Join Contracts ---\n');

  const tokenProviders = await createProviders(walletCtx, tokenConfig);
  const tokenApi = await findDeployedContract(tokenProviders, {
    contractAddress: TOKEN_ADDRESS,
    compiledContract: tokenContract,
    privateStateId: tokenConfig.privateStateId,
    initialPrivateState: {} as any,
  });
  console.log(`  Token:   ${TOKEN_ADDRESS.substring(0, 16)}...`);

  const receiveProviders = await createProviders(walletCtx, receiveConfig);
  const receiveApi = await findDeployedContract(receiveProviders, {
    contractAddress: RECEIVE_ADDRESS,
    compiledContract: receiveContract,
    privateStateId: receiveConfig.privateStateId,
    initialPrivateState: {} as any,
  });
  console.log(`  Receive: ${RECEIVE_ADDRESS.substring(0, 16)}...\n`);

  // —— Step 3: Mint ——————————————————————————————————————

  console.log('--- Step 3: Mint ---\n');

  const walletState = await Rx.firstValueFrom(
    walletCtx.wallet.state().pipe(Rx.filter((s) => s.isSynced)),
  );
  const coinPublicKey = walletState.shielded.coinPublicKey.toHexString();

  console.log('  Minting 100 tokens...');
  const mintResult = await tokenApi.callTx.mint(
    { is_left: true, left: { bytes: fromHex(coinPublicKey) }, right: { bytes: new Uint8Array(32) } },
    100n,
    crypto.randomBytes(32),
  );
  const coinInfo = mintResult.private.result;
  console.log('  Minted.');
  console.log(`    nonce: ${toHex(coinInfo.nonce)}`);
  console.log(`    color: ${toHex(coinInfo.color)}`);
  console.log(`    value: ${coinInfo.value}\n`);

  // —— Step 4: Compute Commitment ————————————————————————

  console.log('--- Step 4: Compute Commitment ---\n');

  const recipient = {
    is_left: false,
    left: { bytes: new Uint8Array(32) },
    right: {bytes: encodeContractAddress(RECEIVE_ADDRESS) }
  }

  const commitment = computeCoinCommitment(coinInfo, recipient);
  const commitmentHex = toHex(commitment);
  console.log(`  Expected: ${commitmentHex}\n`);

  // —— Step 5: Deposit ———————————————————————————————————

  console.log('--- Step 5: Deposit ---\n');

  const depositResult = await receiveApi.callTx.deposit(coinInfo);
  console.log('  Deposited.');
  console.log(`    tx:    ${depositResult.public.txHash}`);
  console.log(`    block: ${depositResult.public.blockHeight}\n`);

  // —— Step 6: Discover mt_index —————————————————————————

  console.log('--- Step 6: Discover mt_index ---\n');

  console.log('  Waiting 5s for indexer...');
  await new Promise((r) => setTimeout(r, 5000));

  const events = await queryZswapEvents(CONFIG.indexer, RECEIVE_ADDRESS);

  if (!events || events.length === 0) {
    console.log('  No events found on transaction.');
    await walletCtx.wallet.stop();
    return;
  }

  console.log(`  Found ${events.length} events.`);

  const discovery = discoverMtIndex(events, commitmentHex);

  if (!discovery) {
    console.log('  Could not discover mt_index.');
    await walletCtx.wallet.stop();
    return;
  }

  console.log(`  mt_index: ${discovery.mtIndex} (event #${discovery.eventId})\n`);

  // —— Step 7: Construct QualifiedShieldedCoinInfo ————————

  console.log('--- Step 7: QualifiedShieldedCoinInfo ---\n');

  const qualifiedCoin = {
    nonce: coinInfo.nonce,
    color: coinInfo.color,
    value: coinInfo.value,
    mt_index: discovery.mtIndex,
  };

  console.log(`  nonce:    ${toHex(qualifiedCoin.nonce)}`);
  console.log(`  color:    ${toHex(qualifiedCoin.color)}`);
  console.log(`  value:    ${qualifiedCoin.value}`);
  console.log(`  mt_index: ${qualifiedCoin.mt_index}\n`);

  // —— Step 8: Spend —————————————————————————————————————

  console.log('--- Step 8: Spend ---\n');

  console.log('  Waiting 15s for proof server to sync Merkle tree...\n');
  await new Promise((r) => setTimeout(r, 15000));

  console.log('  Sending coin back to user wallet...');
  console.log(`    recipient: ${coinPublicKey.substring(0, 32)}...`);
  console.log(`    amount:    ${qualifiedCoin.value}\n`);

  try {
    const spendResult = await receiveApi.callTx.spend(
      qualifiedCoin,
      {
        is_left: true,
        left: { bytes: fromHex(coinPublicKey) },
        right: { bytes: new Uint8Array(32) },
      },
      qualifiedCoin.value,
    );

    console.log('  SPEND SUCCESSFUL');
    console.log(`    tx:    ${spendResult.public.txHash}`);
    console.log(`    block: ${spendResult.public.blockHeight}\n`);

    console.log('  +----------------------------------------------------------+');
    console.log('  |  FULL ROUND TRIP CONFIRMED                               |');
    console.log('  |                                                          |');
    console.log('  |  1. Minted shielded coin                                 |');
    console.log('  |  2. Deposited into stateless contract                    |');
    console.log('  |  3. Computed commitment locally                          |');
    console.log('  |  4. Found commitment in indexer events                   |');
    console.log('  |  5. Extracted mt_index (SCALE compact)                   |');
    console.log('  |  6. Constructed QualifiedShieldedCoinInfo                |');
    console.log('  |  7. Spent coin using discovered data                     |');
    console.log('  |                                                          |');
    console.log('  |  The stateless treasury model is validated.              |');
    console.log('  +----------------------------------------------------------+\n');
  } catch (err: any) {
    console.log('  SPEND FAILED');
    console.log(`    error: ${err.message || err}\n`);
    console.log('  Debug:');
    console.log(`    mt_index: ${qualifiedCoin.mt_index}`);
    console.log(`    nonce:    ${toHex(qualifiedCoin.nonce)}`);
    console.log(`    color:    ${toHex(qualifiedCoin.color)}`);
    console.log(`    value:    ${qualifiedCoin.value}`);
  }

  console.log('--- Done ---\n');
  await walletCtx.wallet.stop();
}

main().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
