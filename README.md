# UTXO Discovery on Midnight

This PoC validates the stateless treasury model for the shielded multisig.
It shows how an operator can discover and spend shielded coins deposited into a contract without storing any coin data on-chain.

Full round trip:

```text
    Mint -> Deposit -> Compute Commitment -> Query Indexer -> SCALE Decode mt_index -> Spend
```

## Quickstart

### Prerequisites

- Node.js v22+

### 1. Start the Local Network

```bash
git clone https://github.com/midnightntwrk/midnight-local-dev.git
cd midnight-local-dev
npm install
npm start
```

Wait for the interactive menu to appear:

```bash
Choose an option:
  [1] Fund accounts from config file (NIGHT + DUST registration)
  [2] Fund accounts by public key (NIGHT transfer only)
  [3] Display wallets
  [4] Exit
```

Leave this running.

### 2. Deploy Token Contract

Open a new terminal in the PoC project directory,
then deploy the token contract.

```bash
npm run deploy -- token
```

Select `[1] Create new wallet`. The script prints a seed and a bech32 address,
then waits for funds.

```bash
SAVE THIS SEED (you'll need it later):
a1b2c3d4...

Visit: https://faucet.preprod.midnight.network/
Address: mn_addr_undeployed...

Waiting for funds...
```

Next, fund the wallet.
Switch to the midnight-local-dev terminal, select option `[2]` and paste the `mn_addr_undeployed...` address.
The deploy script will detect the funds, register for DUST, and deploy.

```bash
  Funds received!

--- Step 3: DUST Setup ---

  Registering for DUST generation...
  Waiting for DUST tokens...
  DUST ready.

--- Step 4: Deploy Token ---

  Deploying (this may take 30-60 seconds)...
```

### 3. Deploy Receive Contract

```bash
npm run deploy -- receive <seed>
```

### 4. Run the Round Trip

```bash
npm run discover <seed>
```

## Architecture

```text
    +------------+      +--------------+      +-------------+
    |  Operator  |----->|   Contract   |----->|   Indexer   |
    |  Backend   |      |  (on-chain)  |      |  (GraphQL)  |
    +------------+      +--------------+      +-------------+
                              |                      |
        1. deposit(coin)      |                      |
        --------------------->|                      |
                              |  2. ZswapOutput       |
                              |     event emitted     |
                              |--------------------->|
        3. Query zswapLedgerEvents                   |
        <--------------------------------------------|
        4. Find commitment, SCALE decode mt_index
        5. Construct QualifiedShieldedCoinInfo
        6. spend(coin, recipient, amount)
        --------------------->|
```

On-chain footprint: Only opaque coin commitments in the global Merkle tree. No coin data, no balances, no UTXO references stored in contract state.

## The Contract

```ts
    pragma language_version >= 0.22.0;
    import CompactStandardLibrary;

    export circuit deposit(coin: ShieldedCoinInfo): [] {
      receiveShielded(disclose(coin));
    }

    export circuit spend(
      coin: QualifiedShieldedCoinInfo,
      recipient: Either<ZswapCoinPublicKey, ContractAddress>,
      amount: Uint<128>
    ): [] {
      sendShielded(disclose(coin), disclose(recipient), disclose(amount));
    }
```

Production would add threshold signature verification to `spend`.
The PoC validates that `QualifiedShieldedCoinInfo` constructed from discovered data is accepted by the protocol.

## Complete flow

### Step 1: Mint a Coin

The operator mints a shielded token. The circuit returns `ShieldedCoinInfo` containing the coin's `nonce`, `color`, and `value`. This data is private — it lives in `result.private.result`, not on-chain.

```ts
    const mintResult = await tokenContract.callTx.mint(
      { is_left: true, left: { bytes: userCoinPublicKey }, right: { bytes: new Uint8Array(32) } },
      100n,
      crypto.randomBytes(32),
    );

    const coinInfo = mintResult.private.result;
    // { nonce: Uint8Array, color: Uint8Array, value: bigint }
```

> Production note: The PoC reads `ShieldedCoinInfo` from the mint return value for convenience.
In production, the operator constructs this from known parameters.
The nonce and value are chosen by the depositor, and the color is derived deterministically as a hash of the domain and contract address.
The operator reconstructs the coin info from parameters communicated off-chain or derived from known contract configuration.

### Step 2: Compute the Coin Commitment

After minting, compute the expected commitment using `persistentHash` with the protocol's `CoinPreimage` struct layout:

```ts
    import { computeContractCoinCommitment, bytesToHex, hexToBytes } from './commitment';

    const commitment = computeContractCoinCommitment(coinInfo, fromHex(contractAddress));
    const commitmentHex = toHex(commitment);
```

Under the hood, this calls `runtimeCoinCommitment` from `@midnight-ntwrk/onchain-runtime-v3`,
passing the coin info and recipient through the runtime's own `ShieldedCoinInfoDescriptor` and `ShieldedCoinRecipientDescriptor`.
This matches the internal `createCoinCommitment` in compact-runtime's zswap module.

For user-addressed coins, use the general `computeCoinCommitment` with `is_left: true`:

```ts
    import { computeCoinCommitment } from './commitment';

    const commitment = computeCoinCommitment(coinInfo, {
      is_left: true,
      left: { bytes: userCoinPublicKey },
      right: { bytes: new Uint8Array(32) },
    });
```

### Step 3: Deposit into Contract

```ts
    const depositResult = await receiveContract.callTx.deposit(coinInfo);
```

The `receiveShielded` call adds the coin's commitment to the global Merkle tree
and creates `ZswapOutput` events on the transaction.
No coin data is stored on the contract's ledger.

### Step 4: Query ZswapLedgerEvents

Events are accessed via `contractAction -> transaction -> zswapLedgerEvents`:

```ts
    // Wait for indexer to process the block
    await new Promise(r => setTimeout(r, 5000));

    const response = await fetch(INDEXER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `{
          contractAction(address: "${contractAddress}") {
            __typename
            ... on ContractCall {
              entryPoint
              transaction {
                hash
                zswapLedgerEvents { id raw }
              }
            }
          }
        }`
      }),
    });
```

Important: `zswapLedgerEvents` is a field on `Transaction`, NOT a top-level query.
WebSocket subscriptions connect but deliver 0 events; HTTP queries work consistently.

### Step 5: Find Commitment and Extract mt_index

Each deposit transaction produces two events. The `ZswapOutput` event (typically the second one) contains the commitment at a known byte offset. Search for the commitment hex string in the raw event data, then extract the SCALE-encoded `mt_index` from the bytes that follow.

```ts
    for (const event of events) {
      const offset = event.raw.toLowerCase().indexOf(commitmentHex.toLowerCase());
      if (offset !== -1) {
        const byteOffset = offset / 2;  // 95 for ZswapOutput events

        // After commitment: [0x02 preimage_evidence::None] [0x00 separator] [SCALE mt_index]
        const afterCommit = event.raw.substring((byteOffset + 32) * 2);
        const scaleHex = afterCommit.substring(4); // skip "0200"
        const mtIndex = decodeScaleCompact(scaleHex);
      }
    }
```

### ZswapOutput Event Layout (event[v9])

```text
    Offset  0-18:   "midnight:event[v9]:" tag (19 bytes)
    Offset  19:     0x08 (EventDetails::ZswapOutput)
    Offset  20-21:  0x0080 (Option::Some for contract)
    Offset  22-53:  contract address (32 bytes)
    Offset  54-57:  source metadata (4 bytes)
    Offset  58-89:  transaction hash (32 bytes)
    Offset  90-94:  source segments + separator (5 bytes)
    Offset  95-126: commitment (32 bytes)
    Offset  127:    0x02 (ZswapPreimageEvidence::None)
    Offset  128:    0x00 (separator)
    Offset  129+:   mt_index (SCALE compact encoded, variable length)
```

Total event size: 130 bytes when mt_index fits in 1 byte (0-63),
131 bytes for 2-byte encoding (64-16383), etc.

### SCALE Compact Encoding

The `mt_index` uses Substrate's SCALE compact integer encoding. The lowest 2 bits of the first byte determine the mode:

| Mode | Low bits | Bytes | Value range | Decoding |
| ---- | -------- | ----- | ----------- | -------- |
| 0 | `0b00` | 1 | 0 - 63 | `byte >> 2` |
| 1 | `0b01` | 2 | 64 - 16,383 | `LE_u16 >> 2` |
| 2 | `0b10` | 4 | 16,384 - 1B | `LE_u32 >> 2` |
| 3 | `0b11` | 4 + n | > 1B | Big integer |

The SCALE decoder:

```js
    function decodeScaleCompact(hex: string): bigint {
      const firstByte = parseInt(hex.substring(0, 2), 16);
      const mode = firstByte & 0x03;

      if (mode === 0) {
        return BigInt(firstByte >> 2);
      } else if (mode === 1) {
        const secondByte = parseInt(hex.substring(2, 4), 16);
        return BigInt(((secondByte << 8) | firstByte) >> 2);
      } else if (mode === 2) {
        const bytes = [];
        for (let i = 0; i < 8; i += 2)
          bytes.push(parseInt(hex.substring(i, i + 2), 16));
        const val = (bytes[3] << 24) | (bytes[2] << 16) | (bytes[1] << 8) | bytes[0];
        return BigInt(val >>> 2);
      }
      throw new Error('Big integer SCALE compact not implemented');
    }
```

### Step 6: Construct QualifiedShieldedCoinInfo

Combine the coin info from minting with the discovered mt_index:

```ts
    const qualifiedCoin = {
      nonce:    coinInfo.nonce,      // from mint result
      color:    coinInfo.color,      // from mint result
      value:    coinInfo.value,      // from mint result
      mt_index: mtIndex,             // from indexer event (SCALE decoded)
    };
```

### Step 7: Spend the Coin

```ts
    // Wait for proof server to sync Merkle tree (~15 seconds)
    await new Promise(r => setTimeout(r, 15000));

    const spendResult = await receiveContract.callTx.spend(
      qualifiedCoin,
      { is_left: true, left: { bytes: recipientPublicKey }, right: { bytes: new Uint8Array(32) } },
      qualifiedCoin.value,
    );
    // Transaction confirmed -> the protocol accepts the constructed coin info
```

Critical timing requirement:
The proof server must sync after the deposit confirms.
Without a ~15 second delay, spends fail with "invalid index into sparse merkle tree" for ALL indices,
including valid ones.
This is a proof server sync issue, not a data correctness issue.

## Production Considerations

### What's Validated

- Commitment formula is correct and reproducible
- Events accessible via standard indexer GraphQL (HTTP queries)
- mt_index is SCALE compact encoded at a known offset after the commitment
- Discovered `QualifiedShieldedCoinInfo` is accepted by the protocol for spending
- Deposits are fully parallel (no contract state written)

### What Needs Hardening

1. Proof server sync detection. Replace the fixed 15-second delay with block confirmation polling or a proof server health check endpoint.

2. ZswapPreimageEvidence variants.
Only `0x02` (None) is handled.
The other variants (`0x00` Ciphertext, `0x01` PublicPreimage) would insert additional bytes between the commitment and mt_index, changing the layout.
For `receiveShielded` deposits, `None` has been consistent across all test runs.

3. Protocol version changes. The event tag is `event[v9]`.
Version bumps could restructure the serialization.
Pin to a known version and update the parser when upgrading.

4. Change coin discovery.
When a withdrawal sends less than the full coin value,
`sendShielded` produces a change coin routed back to the contract.
The operator must discover this change coin's mt_index using the same process on the withdrawal transaction's events.

5. Transaction-specific queries.
The PoC queries `contractAction` which returns the latest action.
Production should query by specific transaction hash.

6. UTXO pool management.
The operator maintains a local database: add entries on deposit/change receipt, remove on spend,
lock during transaction assembly to prevent double-selection.

7. Recovery. If the operator's database is lost, it can be rebuilt by replaying all historical `contractAction` events and re-extracting commitments + mt_index values.
This requires retaining coin preimages (nonce, color, value) separately.
These cannot be recovered from on-chain data.
