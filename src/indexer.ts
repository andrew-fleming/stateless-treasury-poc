/** * @module indexer
 * @description Coin discovery from Midnight indexer events.
 *
 * ZswapOutput event layout (event[v9], contract-addressed coin):
 *   Offset  0-18:   "midnight:event[v9]:" tag
 *   Offset  19:     0x08 (EventDetails::ZswapOutput)
 *   Offset  20-21:  0x0080 (Option::Some for contract)
 *   Offset  22-53:  contract address (32 bytes)
 *   Offset  54-89:  source data (tx hash + metadata)
 *   Offset  90-94:  source segments + separator
 *   Offset  95-126: commitment (32 bytes)
 *   Offset  127:    0x02 (ZswapPreimageEvidence::None)
 *   Offset  128:    0x00 (separator)
 *   Offset  129+:   mt_index (SCALE compact encoded)
 */

// ─── SCALE Compact Decoding ─────────────────────────────────────

/**
 * Decodes a SCALE compact encoded integer.
 *
 * Low 2 bits of first byte = mode:
 *   0b00: single byte,   value = byte >> 2          (0–63)
 *   0b01: two bytes LE,  value = u16 >> 2           (64–16,383)
 *   0b10: four bytes LE, value = u32 >> 2           (16,384–1,073,741,823)
 *   0b11: big integer,   first byte >> 2 = byte count
 */
export function decodeScaleCompact(hex: string): bigint {
  const firstByte = parseInt(hex.substring(0, 2), 16);
  const mode = firstByte & 0x03;

  if (mode === 0) {
    return BigInt(firstByte >> 2);
  } else if (mode === 1) {
    const secondByte = parseInt(hex.substring(2, 4), 16);
    return BigInt(((secondByte << 8) | firstByte) >> 2);
  } else if (mode === 2) {
    const b = [0, 1, 2, 3].map((i) => parseInt(hex.substring(i * 2, i * 2 + 2), 16));
    const val = (b[3] << 24) | (b[2] << 16) | (b[1] << 8) | b[0];
    return BigInt(val >>> 2);
  } else {
    const byteCount = firstByte >> 2;
    let val = 0n;
    for (let i = byteCount; i >= 1; i--) {
      val = (val << 8n) | BigInt(parseInt(hex.substring(i * 2, i * 2 + 2), 16));
    }
    return val;
  }
}

// ─── Commitment Search ──────────────────────────────────────────

/** Finds a commitment in raw event hex. Returns byte offset or null. */
export function searchForCommitment(
  rawHex: string,
  commitmentHex: string,
): { found: boolean; offset: number } | null {
  const pos = rawHex.toLowerCase().indexOf(commitmentHex.toLowerCase());
  if (pos === -1) return null;
  return { found: true, offset: pos / 2 };
}

// ─── mt_index Extraction ────────────────────────────────────────

/**
 * Extracts mt_index from bytes following the commitment in a ZswapOutput event.
 *
 * After commitment: [0x02 preimage_evidence::None] [0x00 separator] [SCALE compact mt_index]
 */
export function extractMtIndex(
  eventRawHex: string,
  commitmentByteOffset: number,
): bigint | null {
  const afterCommitStart = (commitmentByteOffset + 32) * 2;
  const afterCommit = eventRawHex.substring(afterCommitStart);

  if (afterCommit.length < 6) return null;
  if (afterCommit.substring(0, 2) !== '02') return null;  // preimage evidence variant
  if (afterCommit.substring(2, 4) !== '00') return null;  // separator

  return decodeScaleCompact(afterCommit.substring(4));
}

// ─── High-Level Discovery ───────────────────────────────────────

/**
 * Discovers mt_index for a coin from ZswapLedgerEvents.
 *
 * @example
 * ```ts
 * const events = await queryZswapEvents(indexerUrl, contractAddress);
 * const result = discoverMtIndex(events, commitmentHex);
 * if (result) {
 *   const qualifiedCoin = { ...coinInfo, mt_index: result.mtIndex };
 * }
 * ```
 */
export function discoverMtIndex(
  events: Array<{ id: number; raw: string }>,
  commitmentHex: string,
): { mtIndex: bigint; eventId: number } | null {
  for (const evt of events) {
    const commitResult = searchForCommitment(evt.raw, commitmentHex);
    if (!commitResult) continue;
    const mtIndex = extractMtIndex(evt.raw, commitResult.offset);
    if (mtIndex !== null) return { mtIndex, eventId: evt.id };
  }
  return null;
}

// ─── Indexer Query ──────────────────────────────────────────────

/**
 * Queries the indexer for ZswapLedgerEvents on the latest contract action.
 * Path: contractAction → transaction → zswapLedgerEvents
 */
export async function queryZswapEvents(
  indexerUrl: string,
  contractAddress: string,
): Promise<Array<{ id: number; raw: string }> | null> {
  const response = await fetch(indexerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query:
        '{ contractAction(address: "' + contractAddress +
        '") { __typename ... on ContractCall { entryPoint transaction { hash zswapLedgerEvents { id raw } } } } }',
    }),
  });
  const data = await response.json();
  if (data.errors) return null;
  return data.data?.contractAction?.transaction?.zswapLedgerEvents ?? null;
}
