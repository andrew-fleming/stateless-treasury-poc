import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type Witnesses<PS> = {
}

export type ImpureCircuits<PS> = {
  mint(context: __compactRuntime.CircuitContext<PS>,
       recipient_0: { is_left: boolean,
                      left: { bytes: Uint8Array },
                      right: { bytes: Uint8Array }
                    },
       amount_0: bigint,
       nonce_0: Uint8Array): __compactRuntime.CircuitResults<PS, { nonce: Uint8Array,
                                                                   color: Uint8Array,
                                                                   value: bigint
                                                                 }>;
}

export type ProvableCircuits<PS> = {
  mint(context: __compactRuntime.CircuitContext<PS>,
       recipient_0: { is_left: boolean,
                      left: { bytes: Uint8Array },
                      right: { bytes: Uint8Array }
                    },
       amount_0: bigint,
       nonce_0: Uint8Array): __compactRuntime.CircuitResults<PS, { nonce: Uint8Array,
                                                                   color: Uint8Array,
                                                                   value: bigint
                                                                 }>;
}

export type PureCircuits = {
}

export type Circuits<PS> = {
  mint(context: __compactRuntime.CircuitContext<PS>,
       recipient_0: { is_left: boolean,
                      left: { bytes: Uint8Array },
                      right: { bytes: Uint8Array }
                    },
       amount_0: bigint,
       nonce_0: Uint8Array): __compactRuntime.CircuitResults<PS, { nonce: Uint8Array,
                                                                   color: Uint8Array,
                                                                   value: bigint
                                                                 }>;
}

export type Ledger = {
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>): __compactRuntime.ConstructorResult<PS>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
