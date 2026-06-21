/// On-chain submission marker for DeepBook Market OS — a small, honest record
/// of this project's identity, separate from the app itself (which has no
/// custom on-chain contract of its own; it composes DeepBookV3's existing
/// mainnet contracts via the official SDK). This object is created once, at
/// publish time, and transferred to the publisher.
module deepbook_market_os::submission;

public struct Submission has key {
    id: UID,
    project: vector<u8>,
    team: vector<u8>,
    description: vector<u8>,
    repo_url: vector<u8>,
    live_url: vector<u8>,
}

fun init(ctx: &mut TxContext) {
    let submission = Submission {
        id: object::new(ctx),
        project: b"DeepBook Market OS",
        team: b"Aleks Arriola",
        description: b"A market operating system on DeepBookV3 (Sui): Spot, Margin and Predict composed into execution, accounts, liquidity, structured products and market creation.",
        repo_url: b"https://github.com/aleksarriola-max/deepbook-market-os",
        live_url: b"https://aleksarriola-max.github.io/deepbook-market-os/",
    };
    transfer::transfer(submission, ctx.sender());
}
