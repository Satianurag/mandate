# Dependency security and reproducibility

The lockfile is the install contract. `npm ci` and the clean Linux verification
build are required checks. The release does not equate “latest npm version” with
compatibility, and does not downgrade SDKs merely because `npm audit fix --force`
suggests a historical package version.

The 11 September 2026 audit initially reported 62 transitive findings, including
one critical protobuf.js advisory. These are dependency-chain entries, not 62
independent exploits in Mandate. Explicit overrides now resolve protobuf.js 7.6.6
and 8.8.0, grpc-js 1.12.7, ws 8.21.3, uuid 11.1.1, bn.js 5.2.5, axios 1.20.0,
decode-uri-component 0.5.0 and file-type 21.3.4. Compatibility is checked by the
project tests and live readback; the primary Ledger/x402 integrations retain their
observed versions.

The subsequent npm report contained no critical or moderate entries. It still
reported seven high and thirteen low entries propagated from two upstream roots:
`image-size` and `elliptic`. This document does not suppress or relabel that report.

## Image parser mitigation

The npm-resolved image-size 1.2.1 is pulled in by mobile/Metro dependencies; Mandate's
operator does not expose an image-upload/parser API. npm publishes image-size 2.0.2,
but Metro 0.87.0 declares `image-size ^1.0.2`, so force-overriding that transitive
major would violate its dependency contract. The repository instead applies an
additional version- and SHA-256-checked guard through `postinstall` and `verify`.
It rejects non-progressing ICNS entries, validates bounds, and interprets ISO box
size zero as consuming the remaining buffer. It does not fake image results or
change the package version to fool the advisory scanner.

`scripts/security-patches.test.mjs` exercises malformed inputs with a process
deadline, progress checks, and a valid PNG/ICNS positive case. An unexpected upstream
source revision causes installation/verification to fail so the patch is reviewed
again. The original advisories remain visible in raw npm reports:

- https://github.com/advisories/GHSA-w3rx-r6r6-pgpr
- https://github.com/advisories/GHSA-5p2g-fcmc-qvqq

## Remaining upstream implementation warning

The low-severity elliptic warning concerns an upstream cryptographic implementation
used by transitive older Ethers/Hedera packages. The main workspace signs EVM data
through Ledger/viem and HCS through the current Hiero SDK, but the old implementation
still exists in the dependency tree. There is no claim that its presence is fixed
by an application guard or that the whole supply chain has zero residual risk.
No production/mainnet readiness claim is made.

https://github.com/advisories/GHSA-848j-6mx2-7j84

## Patched advisory references

- https://github.com/advisories/GHSA-xq3m-2v4x-88gg
- https://github.com/advisories/GHSA-5375-pq7m-f5r2
- https://github.com/advisories/GHSA-96hv-2xvq-fx4p
- https://github.com/advisories/GHSA-w5hq-g745-h8pq

`npm outdated` on 11 September 2026 showed only GraphQL 17.0.2. Mandate stays on
16.14.2 because `@graphprotocol/client-x402@1.0.0` declares a GraphQL `^15.2 || ^16`
peer range; 16.14.2 is the newest compatible 16.x release. Primary runtime versions
checked against the registry were x402 2.25.0, Hiero SDK 2.88.0, Ledger DMK 1.9.0,
Ledger Ethereum signer kit 1.18.0, and HOL standards SDK 0.1.186.

Keep raw audit output with the verification evidence. Dependency overrides require
compatibility testing whenever they change; an audit report is not a substitute
for signature, live integration, or rollback/recovery checks.
