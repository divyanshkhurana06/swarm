# Swarm

**A data-labelling market where every answer is paid the moment it is given — on-chain, for a fraction of a cent, with no wallet and no signup on either side.**

A requester pastes what they need labelled and signs once. The task goes on-chain. A worker signs in with Google, answers, and is paid per answer. Neither side needs gas, tokens, or a seed phrase.

Built at [Monad Blitz Hyderabad V3](https://blitz.devnads.com/events/monad-blitz-hyderabad-v3).

- **Live app:** **https://swarm-rouge-one.vercel.app**
- **Post a task:** https://swarm-rouge-one.vercel.app/post
- **Projector dashboard:** https://swarm-rouge-one.vercel.app/dashboard
- **TaskPool (Monad Testnet):** [`0x74F2b1C5eCb400c31596dC5CA993f909F083A6d0`](https://testnet.monadvision.com/address/0x74F2b1C5eCb400c31596dC5CA993f909F083A6d0) — verified
- **DemoUSD (Monad Testnet):** [`0x5E47E70679811F5720338237066e3e57D71a449C`](https://testnet.monadvision.com/address/0x5E47E70679811F5720338237066e3e57D71a449C) — verified
- **WorkReceipt NFT (Monad Testnet):** [`0xE2cBB61a976294a31756D0483e00dDbDf6A041c0`](https://testnet.monadvision.com/address/0xE2cBB61a976294a31756D0483e00dDbDf6A041c0) — verified
- **Rewards:** 5c per image bounty · 15c per survey question

---

## Verify it in two minutes

| Claim | Where to check |
|---|---|
| Public repo | https://github.com/divyanshkhurana06/swarm |
| Live, publicly hosted | https://swarm-rouge-one.vercel.app |
| Contracts on Monad Testnet | [TaskPool `0x74F2…A6d0`](https://testnet.monadvision.com/address/0x74F2b1C5eCb400c31596dC5CA993f909F083A6d0) |
| Source verified on the explorer | All three contracts, via Sourcify — open any address above |
| Anyone can run it unaided | [Run it yourself](#run-it-yourself): clone, `forge test --odyssey`, `npm run dev` |
| It works | 51 contract tests · 1593 client checks · three suites run against the **deployed** contracts |

```bash
npx tsx scripts/e2e-bounty.ts   # boxes stored, bounty raced, receipt minted
npx tsx scripts/e2e-modes.ts    # each task mode pays the right people
npx tsx scripts/e2e-onchain.ts  # passkey path, P256 precompile, withdrawal
```

Those matter more than the unit tests: they prove the browser's encoding, the
relayer's calldata and the contract's accounting agree on the real chain.
Several bugs were only ever caught there — a missing ABI entry that made the
task list silently appear empty, and a signature that failed because Solidity
pads array elements to 32 bytes while the client did not.

---

## What this actually is

The labelling task on screen is the demo, not the product. The product is the **payment rail underneath it**: a way to pay anyone in the world a few cents, the instant they earn it, with no account and no wallet to install.

Two things make that possible here:

1. **Sub-cent settlement needs sub-cent fees.** Paying someone five cents is nonsense if the transfer costs two dollars. Every existing micro-work platform works around it the same way: batch the work, pay on Friday, through a middleman taking a large cut. Per-answer settlement is the thing that stops being absurd on Monad, and it is why a worker here is paid before they have finished reading the next question.

2. **A worker should not need a wallet to earn.** Google sign-in creates an embedded wallet; the worker signs each answer, a relayer pays the gas, and the contract verifies the worker's signature — so the relayer can pay for everything without being able to forge anything.

There is also a second, fully-tested authentication path that verifies **passkeys** — Face ID, Touch ID — directly on-chain. Passkeys sign over secp256r1, which the EVM cannot verify natively; a Solidity verifier costs ~300,000 gas. **Monad verifies it in a precompile at `0x0100` for 6,900 gas** ([EIP-7951](https://docs.monad.xyz/developer-essentials/precompiles)), which is what turns "sign in with Face ID" into "authorise every single action with Face ID". Google is the default because it is the smoother demo; the passkey path is the more interesting engineering.

A full passkey-authorised, paid-out answer costs **~206,000 gas** on Monad testnet — measured end to end by `scripts/e2e-onchain.ts` against the deployed contracts, not estimated. (The local Foundry measurement is 156k; the real chain is higher because storage slots start cold.) At 102 gwei that is about 0.021 MON per answer.

## Two kinds of work, two ways of paying

| Task | Scoring | Why |
|---|---|---|
| **Image bounties** | First come — the first worker to box an image takes the reward and the image closes | Drawing a box is a specific, checkable claim. Racing for it is the right incentive; a vote would just slow it down. |
| **Surveys** | Paid on completion of every question | A half-finished form is worth nothing to the requester, and paying per question would reward abandoning it after the easy ones. |

"Nothing here" is a real answer on a bounty and is paid for. Not paying it
would teach workers to invent boxes, which is worse than useless data — it is
data that looks fine.

Boxes are stored as four `uint16`s in basis points of the image rather than
pixels, so a box drawn with a thumb on a phone lands in the same place when the
requester opens it on a monitor.

Uploaded photos are downscaled hard and stored in the task spec on-chain, since
there is no backend to keep them in. That is visibly lossy and correct for "is
there a car in this"; a real deployment would keep the original behind a URL and
put only the pointer on-chain.

For surveys, the requester uploads a PDF (parsed in the browser) or pastes
text, and it is split into questions they can edit before posting — a heuristic
will sometimes be wrong, and silently posting a mangled survey wastes both the
requester's money and the workers' time.

Extracting that text needs care. pdf.js returns positioned fragments rather
than lines, so joining them with spaces — the obvious approach — destroys every
line break and leaves the splitter a single wall of text with nothing to split
on. Fragments are regrouped into lines using the end-of-line flag where the
document sets it and the baseline y-coordinate where it does not. The splitter
then handles numbered (`1.`, `Q1)`), bulleted, and unnumbered layouts, and joins
lines that continue a wrapped question — `scripts/survey.test.ts` covers each of
those shapes, because a question split across two lines becoming two questions
means paying workers to answer sentence fragments.

A majority-vote mode also exists in the contract and is tested, but is not
offered in the product.

## The two sides

| | |
|---|---|
| `/post` | Pick a task type, add items (or upload a survey PDF), set the price, sign once. No gas, no tokens. |
| `/` | A worker signs in with Google, picks a task, and answers. Paid per answer, immediately. |
| `/results/[id]` | The dataset: per-item answers and agreement for labelling, full responses for surveys. JSON or CSV. |
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
- **Whose wallet is it.** Privy creates the embedded wallet at Google sign-in and the key is split across the device, Privy's infrastructure and a recovery share — reassembled inside a TEE only when the worker authorises something. In practice that means the wallet works in this app, on any device they sign into, without a seed phrase. It also means it is invisible to MetaMask, because MetaMask has never seen the key. `/withdraw` therefore offers **Export private key**, which hands over the raw key to import anywhere. Without that escape hatch "your wallet" would be a claim the product could not back.
- **Payouts.** Earnings accrue to an internal ledger keyed by public key, then settle in a single `withdraw` to any address the worker names. Transferring on every answer would mean paying ERC-20 gas hundreds of times to move a couple of dollars. Cash-out has a floor of 0.05 DUSD, because sweeping a few cents costs more gas than it moves.
- **Receipts.** Finishing a task mints a `WorkReceipt` NFT recording what *that task* paid and what kind of work it was — not a running total, which would make every receipt look like it paid more than the job was worth. Its artwork is generated on-chain as an SVG data URI to the same address, recording the amount and the number of answers behind it. A stablecoin payout is invisible in a wallet until the token is manually imported, which makes a real payment feel like nothing happened; the NFT shows up on its own. Its artwork is generated on-chain as an SVG data URI, so nothing has to stay hosted for it to keep rendering.

## Repository layout

```
contracts/
  src/WebAuthn.sol      passkey verification via the 0x0100 precompile
  src/TaskPool.sol      task pools, the worker ledger, payouts
  src/DemoUSD.sol       6-decimal stand-in stablecoin for testnet
  src/WorkReceipt.sol   cash-out receipt NFT, artwork generated on-chain
  src/EIP712.sol        typed-data signing for embedded wallets
  src/Base64.sol        encoder for the NFT's inline metadata
  test/TaskPool.t.sol   51 tests, real P256 and secp256k1 signatures
  script/webauthn.js    generates real WebAuthn assertions for those tests
  script/Deploy.s.sol   deploys and seeds a funded task
web/
  lib/passkey.ts        WebAuthn client: DER parsing, low-s, challenge encoding
  lib/contracts.ts      chain config and ABI
  app/page.tsx          the worker app
  lib/survey.ts          PDF text extraction and question splitting
  components/ui.tsx      shared shell, wallet bar, inputs
  app/post/page.tsx      requester: post any of the three task types
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

```bash
git clone --recurse-submodules https://github.com/divyanshkhurana06/swarm.git
cd swarm
```

### 1. Contracts

```bash
cd contracts
forge test --odyssey -vv     # 51 tests, no setup beyond the clone
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
  --chain 10143 --verifier sourcify \
  --verifier-url https://sourcify-api-monad.blockvision.org/
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

`RELAYER_PRIVATE_KEY` needs testnet MON — it pays gas for every worker, so it
is the one thing that stops the whole app if it empties. Note the missing
`NEXT_PUBLIC_` prefix: that prefix inlines a value into the browser bundle, and
on a private key it would hand the wallet to every visitor. The app refuses to
build if it finds one.

Open `http://localhost:3000` on a phone with Face ID or a fingerprint reader, and `http://localhost:3000/dashboard` on the big screen.

> Passkeys require a secure context. `localhost` works; over a network use HTTPS (`npx localtunnel --port 3000` or just deploy).

### 3. Tests

```bash
cd contracts && forge test --odyssey -vv    # 51 contract tests, local
cd web && npm test                          # DER parser, challenge encoding, survey splitting
cd web && npx tsx scripts/e2e-onchain.ts    # passkey flow against deployed contracts
cd web && npx tsx scripts/e2e-modes.ts      # all three task modes, live chain
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


