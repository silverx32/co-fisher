# Room card games implementation plan

**Goal:** Play blackjack, Texas Hold'em and Dou Dizhu inside the existing pet window, with 500-point entry and 80% prize pools.

**Architecture:** The shared Rust room server owns tables, shuffled decks, turns, elimination and settlement. Per-player snapshots expose only that player's hand. The desktop wallet applies uniquely identified tickets and settlements exactly once. Hiding the UI never sends a leave command. Existing Steam, LAN and relay connections share the same implementation.

**Tech Stack:** Rust, Tokio, serde_json, Tauri, existing plain HTML/CSS/JavaScript.

## Confirmed rules

- One table per existing room; select blackjack / Hold'em / Dou Dizhu before entering. First entrant is the starter. At least three entrants to start; Dou Dizhu requires exactly three. Hold'em supports up to nine, blackjack up to sixteen.
- Entry is 500 existing points, with no further real-point bets. Waiting players may withdraw for a full refund. A running participant may surrender explicitly; spectators cannot act or see private cards.
- Blackjack: no house banker; closest to 21 without busting survives each round. Lower scores are eliminated; tied highest players replay until one remains. If everyone busts, replay. Aces count as 1 or 11. No split, insurance or side bets.
- Hold'em: 1,000 tournament chips each, blinds 10/20 increasing with hands. Standard community cards, betting streets, fold/check/call/raise/all-in and side pots. Zero chips eliminates a participant. Tied pots split chips; surviving players continue until one champion.
- Dou Dizhu: three-player landlord bidding, three bottom cards, standard combinations including airplanes, bombs and rocket. First to empty wins for their team. Landlord gets 80% of total entry if winning; the two farmers split that 80% if winning (confirmed by user). No multiplier applied to entry or payout.
- Prize pool is entry count * 500 * 80%; the remaining 20% is consumed. Closing or collapsing the panel never quits. Every turn has a visible timeout with automatic safe action so hidden or disconnected clients do not stall the table.
- Tickets and results are keyed by random IDs; retries cannot join or pay twice. Reconnecting resumes the same seat. Server restart cancels unfinished tables and releases their escrow; normal finishes settle once. Keep settlement recovery within the current client-owned wallet model.

## Steps and checks

1. Create `server/src/cards.rs`: unbiased OS-random shuffle, blackjack scores, seven-card poker ranking and Dou Dizhu pattern/comparison. Unit-test edge cases, wheel straights, ties and invalid combinations.
2. Create `server/src/games.rs`: table state, admission, private snapshots, deadlines, tournament progression and idempotent ticket results. Test buy-in, authority, payouts, ties, spectator privacy, timeouts and disconnects.
3. Integrate game protocol into `server/src/lib.rs`; advertise capability on welcome and send private updates. Retain recovery results while receipts are pending.
4. Add durable pending tickets/receipt deduplication in `app/src/config.rs` and commands/event routing in `app/src/main.rs` / `net.rs`. Serialize actual local wallet changes; do not count winnings as typing or Boss damage.
5. Add an embedded, independently collapsible card table in `ui/pet.html`, `ui/games.js`, `ui/games.css`. Extend `api.js`; preserve current pet interactions and click-through regions. Use explicit surrender confirmation.
6. Extend network integration tests for membership, private hands, invalid actions, replayed tickets and result acknowledgements. Run all existing tests, syntax checks and a desktop build. Record actual validation limits.

## Scope boundary

These are non-cash, local game points, consistent with the existing client-owned wallet. This does not make the existing local save or player-hosted server tamper-proof. Relay/host must be updated to advertise the new games; old servers keep existing features and show games unavailable.

## Validation and outputs

- Implemented as v2.6.0; v2.5.0 artifacts preserved.
- 35 Rust tests passed, including an entire auto-play Hold'em tournament, chip conservation, short all-in raise reopening, private snapshots, refund recovery and idempotent wallet settlement. Existing live GitHub lookup remains ignored.
- 20 WebSocket protocol tests passed, including entry replay, host authority, spectator privacy, reconnecting to a hand, offline settlement and unchanged Boss damage after game winnings.
- Browser smoke check passed at 910x720: twenty selectable Dou Dizhu cards fit; folding the table, closing the panel and restoring from the dock send no leave command. Preview at `tmp/games-ui-qa/games-preview.png`.
- Windows release and Linux musl builds packaged under `dist/v2.6.0/`.
- Not yet verified: three real desktop players, actual Steam transport, server Docker startup, external networking or live GitHub publication.
