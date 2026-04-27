/** * Coin commitment computation for UTXO discovery.
 *
 * Replicates the internal `createCoinCommitment` from compact-runtime's
 * zswap module. That function is marked @internal and not exported, but
 * the pattern is straightforward: delegate to `runtimeCoinCommitment`
 * from the onchain-runtime, passing coinInfo and recipient through the
 * exported type descriptors.
 *
 * This produces the same commitment the protocol stores in the Merkle tree,
 * allowing the operator to search for it in indexer ZswapOutput events.
 */

import * as ocrt from '@midnight-ntwrk/onchain-runtime-v3';
import {
  Bytes32Descriptor,
  ShieldedCoinInfoDescriptor,
  ShieldedCoinRecipientDescriptor,
  EncodedShieldedCoinInfo,
  EncodedRecipient
} from '@midnight-ntwrk/compact-runtime';

// ——— Main API ————————————————————————————————————————————

/**
 * Computes the coin commitment matching the protocol's internal computation.
 *
 * Mirrors the @internal `createCoinCommitment` in compact-runtime/zswap.ts:
 *   ocrt.runtimeCoinCommitment(
 *     { value: ShieldedCoinInfoDescriptor.toValue(coinInfo), alignment: ... },
 *     { value: ShieldedCoinRecipientDescriptor.toValue(recipient), alignment: ... },
 *   )
 *
 * @param coinInfo - The coin's nonce, color, and value
 * @param recipient - The full encoded recipient (Either<ZswapCoinPublicKey, ContractAddress>)
 * @returns The 32-byte commitment
 */
export function computeCoinCommitment(
  coinInfo: EncodedShieldedCoinInfo,
  recipient: EncodedRecipient,
): Uint8Array {
  const result = ocrt.runtimeCoinCommitment(
    {
      value: ShieldedCoinInfoDescriptor.toValue(coinInfo),
      alignment: ShieldedCoinInfoDescriptor.alignment(),
    },
    {
      value: ShieldedCoinRecipientDescriptor.toValue(recipient),
      alignment: ShieldedCoinRecipientDescriptor.alignment(),
    },
  );

  return Bytes32Descriptor.fromValue(result.value);
}

/**
 * Convenience: compute commitment for a contract-addressed coin.
 *
 * @param coinInfo - The coin's nonce, color, and value
 * @param contractAddress - The 32-byte contract address
 * @returns The 32-byte commitment
 */
export function computeContractCoinCommitment(
  coinInfo: EncodedShieldedCoinInfo,
  contractAddress: Uint8Array,
): Uint8Array {
  return computeCoinCommitment(coinInfo, {
    is_left: false,
    left: { bytes: new Uint8Array(32) },
    right: { bytes: contractAddress },
  });
}
