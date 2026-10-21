# Changelog

## [0.3.0](https://github.com/pontmore/pontspark/compare/v0.2.1...v0.3.0) (2026-10-21)


### Features

* keep a private history of customers' paying accounts ([b0ea937](https://github.com/pontmore/pontspark/commit/b0ea93744d5c0030e471365ec8b7233c359c7031))
* name registry currencies with Intl and update payment-channels to 0.6.0 ([b97a106](https://github.com/pontmore/pontspark/commit/b97a10613e7aeb0613472a62109c4884dd6bc655))
* open a timeout dispute when payment confirmation lapses ([9d31f71](https://github.com/pontmore/pontspark/commit/9d31f71085115c2a441b8e4c1d37aa68293842e8))
* pay directly when release is authorized after the lock returned ([38ee5c6](https://github.com/pontmore/pontspark/commit/38ee5c643f0ec76e6993fc0db37873c2b38facab))
* sign private messages and share a swap's signed record ([4cbc559](https://github.com/pontmore/pontspark/commit/4cbc559b2ea9b33b5ec8f9395d1e16cc5c825336))


### Bug Fixes

* bind each HTLC payment to a single swap ([e958770](https://github.com/pontmore/pontspark/commit/e958770724f7dd3d9d556f7dcf841eab57fcf135))
* check payout invoices for reuse without binding a second hash ([05e35fb](https://github.com/pontmore/pontspark/commit/05e35fbf127c4fe81e2339cefe20ed46cf495a41))
* close overdue swaps and cancel a returned lock instead of retrying forever ([161ad68](https://github.com/pontmore/pontspark/commit/161ad6869d04c80f6d43d7796ad88c6fe669e115))
* don't list our own agent offer to ourselves in user mode ([e6475a6](https://github.com/pontmore/pontspark/commit/e6475a6e53acb19199ac9f85947b02ed9de60614))
* encrypt private swap cache with a device-protected key ([6e35bec](https://github.com/pontmore/pontspark/commit/6e35bec62ad6c52a9029c72a12e5fd546c0e3956))
* keep claiming a released preimage while a swap is disputed ([c876a84](https://github.com/pontmore/pontspark/commit/c876a843222b9261f101eef67cbf609232df69a2))
* never record a refund for a lock that was released ([3985d5a](https://github.com/pontmore/pontspark/commit/3985d5ac31e52eea22d4ce4a21971db0ef7be155))
* republish agent offers when the balance changes ([07e2f68](https://github.com/pontmore/pontspark/commit/07e2f68f51e301a51df9f6748033f4524510689f))
* show plain copy for wallet and network errors on the Retrying card ([b790baf](https://github.com/pontmore/pontspark/commit/b790bafc441c5ce05d1f6903df0091ebaf8815c8))
* validate decrypted swap messages before ingestion ([6f90ee1](https://github.com/pontmore/pontspark/commit/6f90ee1d34c546d979453897ea392c2f4c827184))

## [0.2.1](https://github.com/pontmore/pontspark/compare/v0.2.0...v0.2.1) (2026-10-04)


### Bug Fixes

* parse APK signer output across build-tools formats ([8a2e47b](https://github.com/pontmore/pontspark/commit/8a2e47b3107c61b2f4b787c67152aebc61cf404c))

## [0.2.0](https://github.com/pontmore/pontspark/compare/v0.1.1...v0.2.0) (2026-10-04)


### Features

* celebrate completed swaps and show agents what they earn ([98bdee1](https://github.com/pontmore/pontspark/commit/98bdee1a35a48757865c837002d13e39bf750ef6))
* full-screen swap-complete moment, wherever you are in the app ([93be1f0](https://github.com/pontmore/pontspark/commit/93be1f01020a64794b4c09aa559673c4304415e2))
* simpler wallet card, in-app confirmations, collapsed swap details ([1a42aa4](https://github.com/pontmore/pontspark/commit/1a42aa4a0bae560f1c639f5c9568a4088efe6d3d))


### Bug Fixes

* clearer disputes, declines and cancels; confirm every final step ([676bfe6](https://github.com/pontmore/pontspark/commit/676bfe668f85331570fac0f1c6423ca434465249))
* escrow swaps in a Lightning hold invoice ([722aa16](https://github.com/pontmore/pontspark/commit/722aa16721d30aaf6bffc396181dd93a5ce0b393))
* lead the finished swap with its pill, then the celebration ([3773cc9](https://github.com/pontmore/pontspark/commit/3773cc928c8c3a313233d006105c0a14e8feff6e))
* let agents receive, check and answer swap requests ([c0ca4c8](https://github.com/pontmore/pontspark/commit/c0ca4c8b9b35ce9ce866da24ac57f4bbdd6e6962))
* name the other side in swaps and calm the online pulse ([3e5b109](https://github.com/pontmore/pontspark/commit/3e5b109736832ba61322b7456ae601fb281c8d19))
* one-tap cash payments and fewer repeated screens ([a3b2f71](https://github.com/pontmore/pontspark/commit/a3b2f71fa96a0101ac50fd1107889384bc81a4f8))
* plainer swap copy, cash-aware prompts and swap activity labels ([7af089d](https://github.com/pontmore/pontspark/commit/7af089d9c200e0ae4be339447b1e3ac1bafbf78b))
* polish from the first buy and sell rounds ([27c8140](https://github.com/pontmore/pontspark/commit/27c8140fd0b8e0314e8e208bd919348ce4745cb7))
* say whose turn the swap clock is, and drop repeated rows ([8d98728](https://github.com/pontmore/pontspark/commit/8d9872811edb549769b47a3798bf6a6c7ae31c85))
* uncut Sell card, full payee number, "Wallet" tab in both modes ([c0b5c76](https://github.com/pontmore/pontspark/commit/c0b5c7606dd6f24dbd7e9b39bd70c59a9ec64ad7))

## [0.1.1](https://github.com/pontmore/pontspark/compare/v0.1.0...v0.1.1) (2026-10-04)


### Documentation

* link the Breez Spark HTLC guide ([441a931](https://github.com/pontmore/pontspark/commit/441a931b7c4da608b113ed2dede0e7e1025fae91))
