# Swarm

**A data-labelling market where every answer is paid the moment it is given — on-chain, for a fraction of a cent, with no wallet and no signup on either side.**

A requester pastes what they need labelled and signs once. The task goes on-chain. A worker signs in with Google, answers, and is paid per answer. Neither side needs gas, tokens, or a seed phrase.

Built at [Monad Blitz Hyderabad V3](https://blitz.devnads.com/events/monad-blitz-hyderabad-v3).

- **Live demo:** _TODO — add the deployed URL_
- **Projector dashboard:** _TODO — `<url>/dashboard`_
- **TaskPool (Monad Testnet):** [`0x73c6024536889545115325872AeAeC4fCf03c78E`](https://testnet.monadvision.com/address/0x73c6024536889545115325872AeAeC4fCf03c78E) — verified
- **DemoUSD (Monad Testnet):** [`0x0B9773Ca827eb1E8D8d7AC07adDcdC090EC4b3B0`](https://testnet.monadvision.com/address/0x0B9773Ca827eb1E8D8d7AC07adDcdC090EC4b3B0) — verified
- **WorkReceipt NFT (Monad Testnet):** [`0x5E36430535702e75795a105576B058265e131af0`](https://testnet.monadvision.com/address/0x5E36430535702e75795a105576B058265e131af0) — verified
- **Task id:** `0` · **Reward:** 0.005 DUSD (half a cent) per answer

---

## What this actually is

The labelling task on screen is the demo, not the product. The product is the **payment rail underneath it**: a way to pay anyone in the world a fraction of a cent, instantly, authorised by a fingerprint, with no account.

That primitive did not exist before cheap on-chain P256 verification, for two reasons:

1. **Passkeys sign on the wrong curve.** Ethereum accounts use secp256k1. Passkeys — Face ID, Touch ID, Android Keystore — use secp256r1 (P256). A pure-Solidity P256 verifier costs ~300,000 gas, so verifying a passkey per action was economically absurd. **Monad verifies P256 in a native precompile at `0x0100` for 6,900 gas** ([EIP-7951](https://docs.monad.xyz/developer-essentials/precompiles)), a ~40x reduction. That is what turns passkeys from a login gimmick into per-action authorisation.

2. **Sub-cent payments need sub-cent fees.** Paying someone $0.005 is nonsense if the transfer costs $2. Every existing micro-work platform batches instead: work all week, get paid Friday, through a middleman taking a large cut.

A full passkey-authorised, paid-out answer costs **205,659 gas** on Monad testnet — measured end to end by `scripts/e2e-onchain.ts` against the deployed contracts, not estimated. (The local Foundry measurement is 156k; the real chain is higher because storage slots start cold.) At 102 gwei that is about 0.021 MON per answer.

## The two sides

| | |
|---|---|
| `/post` | A requester writes a question, pastes items one per line, sets what an answer is worth, and signs. No gas, no tokens. |
| `/` | A worker signs in with Google, picks a task, and answers. Paid per answer, immediately. |
| `/results/[id]` | The dataset: every item, the crowd's answer, and how much of the crowd agreed. Downloadable as JSON or CSV. |
| `/withdraw` | Cash out to any address. Mints a receipt NFT. |
| `/dashboard` | The projector wall — live payouts as they are mined. |

**Task specs live on-chain.** A requester posts and a worker anywhere sees it with no server, no database, and nothing that has to still be running tomorrow. Results are read from contract state rather than reconstructed from events, because the public RPC caps `eth_getLogs` at a 100-block range — which makes event-scraping a dataset unreliable exactly when it matters.

**Agreement is reported, not hidden.** Several workers answer each item independently. Where they disagree the item was ambiguous, and the export says so rather than flattening it into a single confident label.

## How it works

```
  phone                        relayer                  Monad
  ─────                        ───────                  ─────
  Face ID  ──── signature ────▶  pays gas  ──── tx ────▶  TaskPool
  (secure enclave,              (postman —              verifies the P256
   key never leaves)             cannot forge)          signature at 0x0100,
                                                        credits the worker
```

- **Two ways to be a person.** Google sign-in with a Privy embedded wallet signs EIP-712 typed data (`submitLabelFor`); a passkey signs a WebAuthn assertion verified against Monad's P256 precompile (`submitLabel`). Both share one ledger — earnings, the cash-out floor and the receipt NFT do not care which was used. An address-derived worker id occupies the low 160 bits, so it can never collide with a passkey id, which is `keccak256` of a public key.
- **Registration (passkey path).** `navigator.credentials.create()` makes a P256 keypair inside the phone's secure enclave. The public key becomes the worker's identity (`workerId = keccak256(x, y)`). The private key physically cannot leave the device; Face ID only unlocks permission to use it.
- **Recovery.** Registration also records `keccak256(credentialId) => workerId` on-chain. A WebAuthn assertion returns the credential id but never the public key, so without that mapping a worker who cleared their browser — or opened the site on a second device — would be unable to derive their own identity and would be silently orphaned from money they had already earned. With it, signing in with the passkey recovers the account from the chain. Browser storage is a cache, not the source of truth.
- **Every answer.** The intent (`taskId`, `itemId`, `answer`) is hashed into the WebAuthn challenge. The contract recomputes that challenge and rejects anything else — so a signature for "yes" is not a signature for "no", and a captured signature cannot be replayed against another action, contract, or chain.
- **Gas.** Workers hold no MON, so a relayer submits their signed payloads and pays. This is safe because the *contract* verifies the worker's signature: the relayer cannot forge an answer, redirect a payout, or touch a balance. The worst it can do is refuse to deliver.
- **Payouts.** Earnings accrue to an internal ledger keyed by public key, then settle in a single `withdraw` to any address the worker names. Transferring on every answer would mean paying ERC-20 gas hundreds of times to move a couple of dollars. Cash-out has a floor of 0.05 DUSD, because sweeping a few cents costs more gas than it moves.
- **Receipts.** Cashing out mints a `WorkReceipt` NFT to the same address, recording the amount and the number of answers behind it. A stablecoin payout is invisible in a wallet until the token is manually imported, which makes a real payment feel like nothing happened; the NFT shows up on its own. Its artwork is generated on-chain as an SVG data URI, so nothing has to stay hosted for it to keep rendering.

## Repository layout

```
contracts/
  src/WebAuthn.sol      passkey verification via the 0x0100 precompile
  src/TaskPool.sol      task pools, the worker ledger, payouts
  src/DemoUSD.sol       6-decimal stand-in stablecoin for testnet
  src/WorkReceipt.sol   cash-out receipt NFT, artwork generated on-chain
  src/EIP712.sol        typed-data signing for embedded wallets
  src/Base64.sol        encoder for the NFT's inline metadata
  test/TaskPool.t.sol   24 tests, real P256 and secp256k1 signatures
  script/webauthn.js    generates real WebAuthn assertions for those tests
  script/Deploy.s.sol   deploys and seeds a funded task
web/
  lib/passkey.ts        WebAuthn client: DER parsing, low-s, challenge encoding
  lib/contracts.ts      chain config and ABI
  app/page.tsx          the worker app
  app/post/page.tsx      requester: post a task
  app/results/[id]       the labelled dataset, JSON/CSV export
  app/withdraw/page.tsx  cash out to any address
  app/dashboard/page.tsx the projector wall
  app/api/relay/route.ts the gas relayer
```

---

## Run it yourself

### Prerequisites

- [Foundry](https://book.getfoundry.sh/getting-started/installation)
- Node 20+
- A funded Monad Testnet key — get MON from [faucet.monad.xyz](https://faucet.monad.xyz)

### 1. Contracts

```bash
cd contracts
forge install
forge test --odyssey -vv
```

`--odyssey` enables the P256 precompile at `0x0100` in the local EVM. Without it, every signature check fails — the precompile simply isn't there.

Deploy and seed a task:

```bash
PRIVATE_KEY=0xyourkey forge script script/Deploy.s.sol \
  --rpc-url monad_testnet --broadcast
```

The script prints the `TaskPool` and `DemoUSD` addresses and the seeded task id. Verify the source so it's readable on the explorer:

```bash
forge verify-contract <TASK_POOL_ADDRESS> src/TaskPool.sol:TaskPool \
  --chain 10143 --verifier sourcify
```

You will also need a [Privy](https://dashboard.privy.io) app id: create an app,
enable Google as a login method, and turn on automatic embedded wallet creation
for EVM. Add every domain you serve from to Privy's allowed origins, or the
login popup closes silently with no error.

### 2. Web app

```bash
cd web
npm install
cp .env.example .env.local     # then paste in the addresses from step 1
npm run dev
```

`RELAYER_PRIVATE_KEY` needs testnet MON — it pays gas for every worker. At ~156k gas per answer, budget accordingly if a whole room is going to use it.

Open `http://localhost:3000` on a phone with Face ID or a fingerprint reader, and `http://localhost:3000/dashboard` on the big screen.

> Passkeys require a secure context. `localhost` works; over a network use HTTPS (`npx localtunnel --port 3000` or just deploy).

### 3. Tests

```bash
cd contracts && forge test --odyssey -vv    # 24 contract tests, local
cd web && npm test                          # DER parser + challenge encoding
cd web && npx tsx scripts/e2e-onchain.ts    # full flow against deployed contracts
```

`scripts/e2e-onchain.ts` is the one that matters most. The Foundry suite runs
against a *locally emulated* precompile; this runs the same flow against real
Monad and asserts three things the emulator cannot prove:

- the TypeScript challenge encoding is byte-identical to Solidity's (a one-byte
  drift would reject every signature in production)
- `0x0100` accepts a genuine P256 assertion
- `0x0100` **rejects** a valid signature made over a different challenge — a
  precompile that silently returned "valid" would be indistinguishable from a
  working one until someone attacked it

The contract tests do not mock the signature layer. `script/webauthn.js` builds `authenticatorData` and `clientDataJSON` exactly as a browser authenticator does and signs the same preimage a passkey signs, so a passing test means a real phone signature verifies too. The suite covers the attacks that matter: a valid signature over a *different* challenge, a tampered answer, a replayed answer, a replayed withdrawal, and high-s malleability.

---

## Security notes

- **Challenges are bound** to chain id, contract address, an action tag, and every parameter of the action. Nothing is replayable across actions, deployments, or chains.
- **Low-s is enforced.** `(r, s)` and `(r, n−s)` are both valid ECDSA signatures for the same message; the contract rejects the high variant so one authorisation cannot be presented twice looking different.
- **The challenge is located in `clientDataJSON` by byte offset**, and the preceding `"challenge":"` key is checked, so a matching string cannot be smuggled in via `origin` or any other field.
- **The relayer is untrusted by design.** It pays gas and nothing else.


